import { createClient } from "npm:@supabase/supabase-js@2";
import { deleteJobOutputs, type RetentionClaim } from "./retention.ts";
import { deleteDueR2Outputs } from "./r2-retention.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("brand-retention: required Supabase environment is missing");
    return json({ error: "Retention service is not configured" }, 500);
  }

  // This endpoint is callable with the public project key, but cannot accept
  // arbitrary job IDs or paths: it only claims records already due for expiry.
  // The privileged service role key is used only inside this server function.
  // Supabase's gateway validates that this is a project API key. We only
  // require its presence here, avoiding assumptions about legacy anon JWT vs
  // current sb_publishable keys. No caller-provided data controls the claim.
  if (!request.headers.get("apikey")) return json({ error: "Unauthorized" }, 401);

  const limit = (() => {
    try {
      const requested = Number((request.headers.get("x-retention-batch-size") ?? "20"));
      return Number.isFinite(requested) ? Math.max(1, Math.min(50, Math.trunc(requested))) : 20;
    } catch {
      return 20;
    }
  })();

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const { data, error } = await supabase.rpc("claim_expired_brand_outputs", { p_limit: limit });
  if (error) {
    console.error("brand-retention: claim RPC failed", error.message);
    return json({ error: "Unable to claim expired outputs" }, 500);
  }

  const jobs = (data ?? []) as RetentionClaim[];
  const summary = { claimed: jobs.length, expired: 0, partially_cleaned: 0, retry_scheduled: 0, terminal_failures: 0, claim_failures: 0, abandoned_deleted: 0, abandoned_failed: 0 };

  for (const job of jobs) {
    const markerResult = await deleteJobOutputs({
      async list(bucket, path, search) {
        const { data, error: listError } = await supabase.storage.from(bucket).list(path, { search, limit: 100 });
        return { data: data?.map((file) => ({ name: file.name })) ?? null, error: listError };
      },
      async remove(bucket, paths) {
        const { error: removeError } = await supabase.storage.from(bucket).remove(paths);
        return { error: removeError };
      },
    }, job);
    const providerQuery=await supabase.from('brand_jobs').select('storage_provider,reference_storage_provider').eq('id',job.job_id).single();
    const r2Result=providerQuery.error?{ok:false,failures:[{bucket:'r2-provider',error:providerQuery.error}]}:
      await deleteDueR2Outputs(job,providerQuery.data,async input=>{
        const origin=Deno.env.get('MUSE_MEDIA_GATEWAY_ORIGIN')||'https://muse-brand-studio.vercel.app';
        const url=new URL('/api/media',origin);
        if(url.protocol!=='https:')throw new Error('R2 cleanup gateway must use HTTPS');
        const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'expire',...input})});
        if(!response.ok)throw new Error(`R2 cleanup gateway returned ${response.status}`);
      });
    const result={ok:markerResult.ok&&r2Result.ok,failures:[...markerResult.failures,...r2Result.failures]};

    if (!result.ok) {
      const messages = result.failures.map(({ bucket, error: failure }) => ({
        bucket,
        error: failure instanceof Error ? failure.message : String(failure),
      }));
      // Detailed diagnostics remain in Edge Function logs. Keep the database
      // error generic because job rows are readable by their owning member.
      console.error("brand-retention: Storage removal failed", {
        job_id: job.job_id,
        attempt: job.retention_attempt,
        failures: messages,
      });
    }

    const { data: completed, error: completionError } = await supabase.rpc("complete_expired_brand_output", {
      p_id: job.job_id,
      p_claim_token: job.retention_claim_token,
      p_success: result.ok,
      p_error: result.ok ? null : "STORAGE_DELETE_FAILED",
      p_final_path: job.final_path,
      p_reference_path: job.reference_path,
      p_scene_paths: job.scene_paths,
    });

    if (completionError) {
      summary.claim_failures++;
      console.error("brand-retention: completion RPC failed", {
        job_id: job.job_id,
        attempt: job.retention_attempt,
        error: completionError.message,
      });
      continue;
    }

    if (result.ok) {
      if (completed?.retention_status === "expired") summary.expired++;
      else summary.partially_cleaned++;
    } else if (completed?.retention_next_attempt_at) {
      summary.retry_scheduled++;
    } else {
      summary.terminal_failures++;
    }
  }

  // Unlike completed assets, an interrupted direct upload may never have
  // reached the job's output_path. Process its pre-registered path separately.
  const pending=await supabase.rpc('claim_abandoned_r2_uploads',{p_limit:limit});
  if(pending.error){
    console.error('brand-retention: abandoned upload claim failed',pending.error.message);
    summary.claim_failures++;
  }else for(const item of pending.data??[]){
    let ok=true;
    try{
      const origin=Deno.env.get('MUSE_MEDIA_GATEWAY_ORIGIN')||'https://muse-brand-studio.vercel.app';
      const url=new URL('/api/media',origin);
      if(url.protocol!=='https:')throw new Error('R2 cleanup gateway must use HTTPS');
      const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        action:'expire_abandoned',jobId:item.job_id,claim:item.claim_token,bucket:item.bucket,paths:[item.object_path]
      })});
      if(!response.ok)throw new Error(`R2 cleanup gateway returned ${response.status}`);
      const markerJob={job_id:item.job_id,user_id:item.user_id,final_path:item.bucket==='brand-videos'?item.object_path:null,
        reference_path:item.bucket==='brand-references'?item.object_path:null,scene_paths:[],retention_attempt:item.attempt,retention_claim_token:item.claim_token};
      const removed=await deleteJobOutputs({
        async list(bucket,path,search){const {data,error}=await supabase.storage.from(bucket).list(path,{search,limit:100});return {data:data?.map(file=>({name:file.name}))??null,error};},
        async remove(bucket,paths){const {error}=await supabase.storage.from(bucket).remove(paths);return {error};}
      },markerJob);
      if(!removed.ok)throw new Error('Unable to remove upload marker');
    }catch(error){ok=false;console.error('brand-retention: abandoned upload removal failed',{job_id:item.job_id,attempt:item.attempt,error:error instanceof Error?error.message:String(error)});}
    const completed=await supabase.rpc('complete_abandoned_r2_upload',{p_id:item.job_id,p_claim:item.claim_token,p_success:ok});
    if(completed.error||completed.data!==true){summary.claim_failures++;console.error('brand-retention: abandoned upload completion failed',{job_id:item.job_id,error:completed.error?.message});}
    else if(ok)summary.abandoned_deleted++;else summary.abandoned_failed++;
  }

  return json(summary);
});
