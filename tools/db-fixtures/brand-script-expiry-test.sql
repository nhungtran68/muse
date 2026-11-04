\set ON_ERROR_STOP on
begin;
insert into public.brand_jobs(id,user_id,content,scene_count,scene_seconds,reference_path,
 schema_version,status,workflow_phase,attempt,lease_expires_at,reference_sha256)
values('90000000-0000-4000-8000-000000000005','e2f83e79-0133-4c73-9ddf-7ca7fac01b0d',
 'Worker v3 mất kết nối trong lúc tạo video',1,10,'fixture/expired/reference',
 3,'generating','video',1,now()-interval '2 minutes',repeat('d',64));
insert into public.brand_scenes(job_id,scene_index,prompt,dialogue,status,request_receipt)
values('90000000-0000-4000-8000-000000000005',1,'same person','Lời thoại đã duyệt','generating','{"key":"EXPIRED_V3_RECEIPT"}');
do $$
declare n integer;
begin
 n=private.expire_stalled_muse_jobs();
 if n<>1 then raise exception 'Scheduled recovery missed expired v3 job'; end if;
 if not exists(select 1 from public.brand_jobs where id='90000000-0000-4000-8000-000000000005'
   and status='error' and error_code='WORKER_INTERRUPTED' and retryable) then raise exception 'Expired v3 job has wrong state'; end if;
 if not exists(select 1 from public.brand_scenes where job_id='90000000-0000-4000-8000-000000000005'
   and status='error' and request_receipt->>'key'='EXPIRED_V3_RECEIPT') then raise exception 'Recovery lost scene receipt'; end if;
end $$;
rollback;
select 'BRAND_SCRIPT_WORKER_EXPIRY_OK' as result;
