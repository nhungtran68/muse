do $$
declare
  admin uuid;
  member uuid;
  other uuid;
  job public.brand_jobs%rowtype;
  member_job uuid := extensions.gen_random_uuid();
  worker uuid := extensions.gen_random_uuid();
  lease uuid;
begin
  select id into strict admin from public.profiles
    where role='admin' and approved and email like 'muse-acceptance-%@example.test' limit 1;
  select id into strict member from public.profiles
    where role='member' and approved and email like 'muse-acceptance-%@example.test' order by id limit 1;
  select id into strict other from public.profiles
    where id<>member and role='member' and approved and email like 'muse-acceptance-%@example.test' limit 1;
  update public.app_settings set enabled=true,daily_limit=30 where id;
  update private.r2_media_settings set enabled=true where singleton;
  insert into private.zalo_group_catalog(admin_id,entries)
    values(admin,'[{"id":"123456","name":"Approved group"},{"id":"789012","name":"Other group"}]');
  perform set_config('request.jwt.claim.sub',member::text,true);
  if public.my_video_distribution()->>'r2' <> 'false' then raise exception 'Implicit member R2 privilege'; end if;
  begin
    perform public.member_video_distribution(member,true,'123456');
    raise exception 'Member can grant privileges';
  exception when raise_exception then if sqlerrm<>'ADMIN_REQUIRED' then raise; end if;
  end;
  begin
    perform public.submit_video_with_distribution(member_job,extensions.gen_random_uuid(),'Deny unauthorized R2','video_free',null,true,null);
    raise exception 'Unauthorized R2 accepted';
  exception when raise_exception then if sqlerrm<>'R2_NOT_ALLOWED' then raise; end if;
  end;
  perform set_config('request.jwt.claim.sub',admin::text,true);
  perform public.member_video_distribution(member,true,'123456');
  perform public.choose_zalo_group(true,'123456');
  job:=public.submit_video_with_distribution(extensions.gen_random_uuid(),extensions.gen_random_uuid(),
    'Admin explicit no destination', 'video_free',null,false,null);
  if job.storage_provider<>'supabase' then raise exception 'Opt-out ignored'; end if;
  update public.brand_jobs set status='done',final_path=user_id::text||'/'||id::text||'/video.mp4' where id=job.id;
  if exists(select 1 from private.zalo_deliveries where job_id=job.id) then raise exception 'Opt-out sent to group'; end if;
  perform set_config('request.jwt.claim.sub',other::text,true);
  if public.my_video_distribution()->>'zalo_group' is not null then raise exception 'Another owner can see group'; end if;
  perform set_config('request.jwt.claim.sub',member::text,true);
  if public.my_video_distribution()->>'zalo_group' is distinct from 'Approved group' then raise exception 'Assigned group missing'; end if;
  begin
    perform public.submit_video_with_distribution(member_job,extensions.gen_random_uuid(),'Deny unassigned Zalo group','video_free',null,true,'789012');
    raise exception 'Unassigned group accepted';
  exception when raise_exception then if sqlerrm<>'ZALO_NOT_ALLOWED' then raise; end if;
  end;
  job:=public.submit_video_with_distribution(member_job,extensions.gen_random_uuid(),
    'Member video explicit opt-in', 'video_free',null,true,'123456');
  if job.storage_provider<>'r2' then raise exception 'Selected R2 missing'; end if;
  update public.brand_jobs set status='done',final_path=user_id::text||'/'||id::text||'/video.mp4' where id=job.id;
  if not exists(select 1 from private.zalo_deliveries where job_id=job.id and group_id='123456')
    then raise exception 'Approved delivery not queued'; end if;
  perform set_config('request.jwt.claim.sub',admin::text,true);
  update private.muse_worker_lease set expires_at=now()-interval '1 second' where resource='primary';
  select (public.acquire_muse_worker(worker)->>'token')::uuid into lease;
  if public.claim_zalo_delivery(worker,lease)->>'id' is distinct from member_job::text
    then raise exception 'Worker cannot claim authorized member delivery'; end if;
  perform public.member_video_distribution(member,false,'');
  perform set_config('request.jwt.claim.sub',member::text,true);
  if public.my_video_distribution()->>'r2' <> 'false' or public.my_video_distribution()->>'zalo_group' is not null
    then raise exception 'Member revocation not enforced'; end if;
end $$;
select 'ACCOUNT_GRANTS_AND_EXPLICIT_JOB_SELECTION_OK' as result;
