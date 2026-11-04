import { createClient } from "npm:@supabase/supabase-js@2";
import { deleteJobOutputs, type RetentionClaim } from "./retention.ts";

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
  const summary = { claimed: jobs.length, expired: 0, retry_scheduled: 0, terminal_failures: 0, claim_failures: 0 };

  for (const job of jobs) {
    const result = await deleteJobOutputs({
      async list(bucket, path, search) {
        const { data, error: listError } = await supabase.storage.from(bucket).list(path, { search, limit: 100 });
        return { data: data?.map((file) => ({ name: file.name })) ?? null, error: listError };
      },
      async remove(bucket, paths) {
        const { error: removeError } = await supabase.storage.from(bucket).remove(paths);
        return { error: removeError };
      },
    }, job);

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
      summary.expired++;
    } else if (completed?.retention_next_attempt_at) {
      summary.retry_scheduled++;
    } else {
      summary.terminal_failures++;
    }
  }

  return json(summary);
});
