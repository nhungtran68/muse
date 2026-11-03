\set ON_ERROR_STOP on
set role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
do $$
declare worker uuid='55555555-0000-4000-8000-000000000001'; lease jsonb; token uuid; job public.brand_jobs; plan jsonb; i integer; key text; n integer; stranger uuid;
begin
 lease=public.acquire_muse_worker(worker);token=(lease->>'token')::uuid;
 job=public.claim_brand_job_v2(worker,token);if job.id is null then raise exception 'no queued fixture';end if;
 select jsonb_agg(jsonb_build_object('index',x,'seconds',job.scene_seconds,'prompt','Fixture scene prompt','dialogue','', 'action','fixture','source_quotes','[]'::jsonb,'speech','{}'::jsonb) order by x) into plan from generate_series(1,job.scene_count) x;
 perform public.update_brand_job_v2(job.id,worker,token,job.claim_token,jsonb_build_object('status','generating','plan',plan));
 for i in 1..job.scene_count loop
   key=job.user_id::text||'/'||job.id::text||'/'||job.claim_token::text||'/scenes/'||i::text||'.mp4';
   insert into storage.objects(bucket_id,name) values('brand-videos',key);
   perform public.update_brand_scene_v2(job.id,i,worker,token,job.claim_token,jsonb_build_object('status','done','output_path',key,'duration',job.scene_seconds,'output_sha256',lpad(i::text,64,'0'),'speech_audit',jsonb_build_object('ok',true)));
 end loop;
 perform public.update_brand_job_v2(job.id,worker,token,job.claim_token,'{"status":"joining"}');
 key=job.user_id::text||'/'||job.id::text||'/'||job.claim_token::text||'/final.mp4';
 insert into storage.objects(bucket_id,name) values('brand-videos',key);
 begin
  perform public.update_brand_job_v2(job.id,worker,token,job.claim_token,jsonb_build_object('status','done','final_path',key,'final_probe',jsonb_build_object('duration',job.scene_count*job.scene_seconds)));
  raise exception 'final audio verification bypassed';
 exception when raise_exception then if sqlerrm='final audio verification bypassed' then raise;end if;end;
 perform public.update_brand_job_v2(job.id,worker,token,job.claim_token,jsonb_build_object('status','done','final_path',key,'final_probe',jsonb_build_object('duration',job.scene_count*job.scene_seconds,'speech_audit',jsonb_build_object('ok',true))));
 perform public.release_muse_worker(worker,token);
 stranger=case when job.user_id='20000000-0000-4000-8000-000000000002'::uuid then '30000000-0000-4000-8000-000000000003'::uuid else '20000000-0000-4000-8000-000000000002'::uuid end;
 perform set_config('request.jwt.claim.sub',stranger::text,false);
 select count(*) into n from storage.objects where name=key;if n<>0 then raise exception 'cross-user final output exposed';end if;
 select count(*) into n from public.brand_scenes where job_id=job.id;if n<>0 then raise exception 'cross-user scenes exposed';end if;
 perform set_config('request.jwt.claim.sub',job.user_id::text,false);
 select count(*) into n from storage.objects where name=key;if n<>1 then raise exception 'owner cannot see final';end if;
 select count(*) into n from public.brand_scenes where job_id=job.id;if n<>job.scene_count then raise exception 'owner cannot see scenes';end if;
end $$;
select 'OUTPUT_RLS_TEST_OK' as result;
