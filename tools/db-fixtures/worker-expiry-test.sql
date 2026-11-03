\set ON_ERROR_STOP on
-- Run only in the separate Supabase acceptance database with synthetic users.
begin;
do $$
declare member uuid; expired uuid=extensions.gen_random_uuid(); fresh uuid=extensions.gen_random_uuid(); receipt jsonb='{"key":"LOCAL_EXPIRY_FIXTURE"}';
begin
 select id into member from public.profiles where email like 'muse-acceptance-%@example.test' and role='member' limit 1;
 if member is null then raise exception 'A disposable local fixture member is required'; end if;
 insert into public.brand_jobs(id,user_id,content,scene_count,scene_seconds,reference_path,schema_version,status,attempt,lease_expires_at)
 values(expired,member,'Mẫu cục bộ kiểm tra worker đã hết hạn',1,10,member::text||'/'||expired::text||'/reference',2,'generating',1,now()-interval '1 minute'),
 (fresh,member,'Mẫu cục bộ kiểm tra worker còn hoạt động',1,10,member::text||'/'||fresh::text||'/reference',2,'generating',1,now()+interval '1 minute');
 insert into public.brand_scenes(job_id,scene_index,prompt,status,request_receipt) values(expired,1,'Local expiry fixture scene','generating',receipt);
 perform private.expire_stalled_muse_jobs();
 if (select status from public.brand_jobs where id=expired)<>'error' then raise exception 'Expired job did not fail'; end if;
 if (select status from public.brand_jobs where id=fresh)<>'generating' then raise exception 'Active lease was interrupted'; end if;
 if not exists(select 1 from public.brand_scenes where job_id=expired and status='error' and request_receipt=receipt) then raise exception 'Scene error or saved receipt was lost'; end if;
 perform private.expire_stalled_muse_jobs();
 if (select count(*) from public.brand_job_events where job_id=expired and status='error')<>1 then raise exception 'Cleanup emitted duplicate events'; end if;
 if has_function_privilege('authenticated','private.expire_stalled_muse_jobs()','EXECUTE') then raise exception 'Member can invoke private cleanup'; end if;
end $$;
rollback;
select 'EXPIRED_WORKER_JOB_RECEIPT_AND_PERMISSIONS_OK' as result;
