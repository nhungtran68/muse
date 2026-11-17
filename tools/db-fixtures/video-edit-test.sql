do $$
declare
  admin uuid; member uuid; other uuid; worker uuid:=extensions.gen_random_uuid();
  job_id uuid:=extensions.gen_random_uuid(); request_key uuid:=extensions.gen_random_uuid();
  other_job uuid:=extensions.gen_random_uuid();
  token uuid; job public.brand_jobs%rowtype; repeated public.brand_jobs%rowtype;
  source_hash text:=repeat('a',64);
begin
  select id into strict admin from public.profiles where role='admin' and approved and email like 'muse-acceptance-%@example.test' limit 1;
  select id into strict member from public.profiles where role='member' and approved and email like 'muse-acceptance-%@example.test' order by id limit 1;
  select id into strict other from public.profiles where id<>member and role='member' and approved and email like 'muse-acceptance-%@example.test' limit 1;
  update public.app_settings set enabled=true,daily_limit=30 where id;
  update private.r2_media_settings set enabled=true where singleton;
  perform set_config('request.jwt.claim.sub',member::text,true);
  begin
    perform public.submit_video_edit_job(job_id,request_key,'Cắt thử video đầu vào',source_hash,false);
    raise exception 'Disabled edit feature accepted';
  exception when raise_exception then if sqlerrm<>'VIDEO_EDIT_UNAVAILABLE' then raise; end if; end;
  update private.video_edit_settings set enabled=true,test_member_id=other where singleton;
  begin
    perform public.submit_video_edit_job(job_id,request_key,'Cắt thử video đầu vào',source_hash,false);
    raise exception 'Another test account was accepted';
  exception when raise_exception then if sqlerrm<>'VIDEO_EDIT_UNAVAILABLE' then raise; end if; end;
  update private.video_edit_settings set test_member_id=member where singleton;
  begin
    perform public.submit_video_edit_job(job_id,request_key,'Cắt thử video đầu vào',source_hash,false);
    raise exception 'Unapproved R2 accepted';
  exception when raise_exception then if sqlerrm<>'R2_NOT_ALLOWED' then raise; end if; end;
  perform set_config('request.jwt.claim.sub',admin::text,true);
  perform public.member_video_distribution(member,true,null);
  perform set_config('request.jwt.claim.sub',member::text,true);
  begin
    perform public.submit_video_edit_job(job_id,request_key,'Cắt thử video đầu vào',source_hash,true);
    raise exception 'Unapproved Zalo group accepted';
  exception when raise_exception then if sqlerrm<>'ZALO_NOT_ALLOWED' then raise; end if; end;
  job:=public.submit_video_edit_job(job_id,request_key,'Cắt thử video đầu vào',source_hash,false);
  if job.id<>job_id or job.status<>'uploading' or job.reference_kind<>'video' or job.storage_provider<>'r2'
    or job.reference_storage_provider<>'r2' or job.output_r2_selected is distinct from true then raise exception 'Unexpected video edit job'; end if;
  repeated:=public.submit_video_edit_job(job_id,request_key,'Cắt thử video đầu vào',source_hash,false);
  if repeated.id<>job.id then raise exception 'Idempotent request produced another job'; end if;
  begin
    perform public.submit_video_edit_job(job_id,request_key,'Nội dung khác nhau',source_hash,false);
    raise exception 'Different request reused key';
  exception when raise_exception then if sqlerrm<>'REQUEST_ID_CONFLICT' then raise; end if; end;
  if exists(select 1 from private.job_zalo_destination d where d.job_id=job.id) then raise exception 'Zalo opted in implicitly'; end if;
  insert into storage.objects(bucket_id,name) values('brand-references',job.reference_path);
  perform public.queue_brand_job(job.id);
  perform set_config('request.jwt.claim.sub',admin::text,true);
  update private.muse_worker_lease set expires_at=now()-interval '1 second' where resource='primary';
  select (public.acquire_muse_worker(worker)->>'token')::uuid into token;
  perform public.register_r2_worker(worker,token);
  repeated:=public.claim_brand_job_v2(worker,token);
  if repeated.id is not null then raise exception 'Old worker claimed a video edit job'; end if;
  perform public.register_video_edit_worker(worker,token);
  repeated:=public.claim_brand_job_v2(worker,token);
  if repeated.id is distinct from job.id then raise exception 'Capable worker could not claim video job'; end if;
  update public.brand_scenes s set status='error',submission_state='sent',request_receipt='{"key":"original"}'::jsonb where s.job_id=job.id;
  update public.brand_jobs set status='error',error_code='MUSE_TIMEOUT',retryable=true,updated_at=now()-interval '20 seconds',
    conversation_ref='{"url":"https://muse.ai/thread/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}'::jsonb where id=job.id;
  perform set_config('request.jwt.claim.sub',other::text,true);
  perform public.submit_single_media_job(other_job,extensions.gen_random_uuid(),'Một yêu cầu video khác','video_free',null);
  perform set_config('request.jwt.claim.sub',admin::text,true);
  for n in 1..2 loop
    if not public.schedule_video_edit_recovery(worker,token) then raise exception 'Safe recovery not scheduled'; end if;
    select * into repeated from public.brand_jobs where id=job.id;
    if repeated.status<>'queued' or repeated.video_edit_retries<>n or repeated.video_edit_retry_after<=now() then raise exception 'Recovery not bounded'; end if;
    if (select s.request_receipt->>'key' from public.brand_scenes s where s.job_id=job.id)<>'original' then raise exception 'Recovery discarded receipt'; end if;
    repeated:=public.claim_brand_job_v2(worker,token);
    if n=1 then
      if repeated.id is distinct from other_job then raise exception 'A delayed recovery blocked another request'; end if;
      update public.brand_jobs set status='error' where id=other_job;
    elsif repeated.id is not null then raise exception 'Recovery ignored backoff'; end if;
    update public.brand_jobs set video_edit_retry_after=now()-interval '1 second' where id=job.id;
    repeated:=public.claim_brand_job_v2(worker,token);
    if repeated.id is distinct from job.id then raise exception 'Recovery was not claimable'; end if;
    update public.brand_jobs set status='error',error_code='MUSE_TIMEOUT',retryable=true,updated_at=now()-interval '20 seconds' where id=job.id;
  end loop;
  if public.schedule_video_edit_recovery(worker,token) then raise exception 'Retry limit was exceeded'; end if;
  perform set_config('request.jwt.claim.sub',other::text,true);
  begin
    perform public.queue_brand_job(job.id);
    raise exception 'Other member accessed job';
  exception when raise_exception then if sqlerrm='Other member accessed job' then raise; end if; end;
end $$;
select 'VIDEO_EDIT_ISOLATION_AND_CAPABILITY_OK' as result;
