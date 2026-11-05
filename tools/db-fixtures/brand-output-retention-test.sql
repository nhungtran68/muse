\set ON_ERROR_STOP on
-- Disposable Supabase acceptance DB only. Every fixture row is rolled back.
begin;

do $$
declare
  member_a constant uuid := 'e2f83e79-0133-4c73-9ddf-7ca7fac01b0d';
  member_b constant uuid := '3cda2513-82f4-4b80-9918-41f42d8839fb';
  retry_id constant uuid := '99000000-0000-4000-8000-000000000001';
  success_id constant uuid := '99000000-0000-4000-8000-000000000002';
  pending_id constant uuid := '99000000-0000-4000-8000-000000000003';
  legacy_id constant uuid := '99000000-0000-4000-8000-000000000004';
  active_id constant uuid := '99000000-0000-4000-8000-000000000005';
  partial_id constant uuid := '99000000-0000-4000-8000-000000000006';
begin
  -- These identities exist only inside this rollback transaction. Refuse to
  -- reuse an existing account rather than changing any real user's profile.
  if exists(select 1 from auth.users where id in (member_a,member_b))
    or exists(select 1 from public.profiles where id in (member_a,member_b)) then
    raise exception 'Retention fixture user IDs are already in use';
  end if;
  insert into auth.users(
    id,email,aud,role,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at
  ) values
    (member_a,'retention-a-'||extensions.gen_random_uuid()::text||'@example.invalid',
      'authenticated','authenticated',now(),'{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now()),
    (member_b,'retention-b-'||extensions.gen_random_uuid()::text||'@example.invalid',
      'authenticated','authenticated',now(),'{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now());
  -- The application's auth-user trigger creates the matching profiles.
  if (select count(*) from public.profiles where id in (member_a,member_b))<>2 then
    raise exception 'Retention fixture auth users did not receive application profiles';
  end if;
  update public.profiles set role='member',approved=true where id in (member_a,member_b);

  insert into public.brand_jobs(id,user_id,content,scene_count,scene_seconds,reference_path,status,final_path)
  values
    (retry_id,member_a,'Retention retry fixture',1,10,member_a::text||'/'||retry_id::text||'/reference','generating',member_a::text||'/'||retry_id::text||'/final.mp4'),
    (success_id,member_b,'Retention success fixture',1,10,member_b::text||'/'||success_id::text||'/reference','generating',member_b::text||'/'||success_id::text||'/final.mp4'),
    (pending_id,member_a,'Retention pending fixture',1,10,member_a::text||'/'||pending_id::text||'/reference','generating',null),
    (active_id,member_a,'Retention active fixture',1,10,member_a::text||'/'||active_id::text||'/reference','generating',member_a::text||'/'||active_id::text||'/final.mp4'),
    (partial_id,member_b,'Per-file retention fixture',2,10,member_b::text||'/'||partial_id::text||'/reference','generating',member_b::text||'/'||partial_id::text||'/final.mp4');

  -- This done row has no stored output and therefore receives no new expiry.
  insert into public.brand_jobs(id,user_id,content,scene_count,scene_seconds,reference_path,status,final_path)
  values(legacy_id,member_a,'Legacy retention fixture',1,10,member_a::text||'/'||legacy_id::text||'/reference','done',null);

  update public.brand_jobs set status='done' where id in (retry_id,success_id,active_id,partial_id);
  if not exists(select 1 from public.brand_jobs where id=retry_id
      and output_expires_at between clock_timestamp()+interval '59 minutes' and clock_timestamp()+interval '61 minutes'
      and reference_expires_at between clock_timestamp()+interval '59 minutes' and clock_timestamp()+interval '61 minutes'
      and retention_status='active') then
    raise exception 'A successful job did not start the server-side 60 minute reference/final windows';
  end if;
  if (select output_expires_at from public.brand_jobs where id=legacy_id) is not null then
    raise exception 'A historical done row was backfilled';
  end if;

  update public.brand_jobs set output_expires_at=now()-interval '1 second',reference_expires_at=now()-interval '1 second' where id in (retry_id,success_id);
  -- A pending job with an old timestamp remains ineligible; a successful active
  -- job and legacy history remain readable until their applicable expiry.
  update public.brand_jobs set output_expires_at=now()-interval '1 second' where id=pending_id;
  insert into public.brand_scenes(job_id,scene_index,prompt,dialogue,status,output_path)
  values
    (retry_id,1,'same character','retry dialogue','done',member_a::text||'/'||retry_id::text||'/scene-01.mp4'),
    (success_id,1,'same character','success dialogue','done',member_b::text||'/'||success_id::text||'/scene-01.mp4'),
    (pending_id,1,'same character','long-running job scene','done',member_a::text||'/'||pending_id::text||'/scene-01.mp4'),
    (partial_id,1,'same character','expired scene','done',member_b::text||'/'||partial_id::text||'/scene-01.mp4'),
    (partial_id,2,'same character','later scene','done',member_b::text||'/'||partial_id::text||'/scene-02.mp4');
  update public.brand_scenes set output_expires_at=now()-interval '1 second'
    where job_id in (retry_id,success_id,pending_id) or (job_id=partial_id and scene_index=1);
  insert into storage.objects(bucket_id,name) values
    ('brand-videos',member_a::text||'/'||active_id::text||'/final.mp4'),
    ('brand-references',member_a::text||'/'||active_id::text||'/reference'),
    ('brand-videos',member_b::text||'/'||success_id::text||'/final.mp4'),
    ('brand-references',member_b::text||'/'||success_id::text||'/reference'),
    ('brand-videos',member_a::text||'/'||pending_id::text||'/scene-01.mp4'),
    ('brand-videos',member_b::text||'/'||partial_id::text||'/scene-01.mp4'),
    ('brand-videos',member_b::text||'/'||partial_id::text||'/scene-02.mp4');
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub','e2f83e79-0133-4c73-9ddf-7ca7fac01b0d',true);
do $$
begin
  if not exists(select 1 from public.brand_jobs where id='99000000-0000-4000-8000-000000000005') then
    raise exception 'Member cannot read their active job';
  end if;
  if exists(select 1 from public.brand_jobs where id='99000000-0000-4000-8000-000000000002') then
    raise exception 'Member can read another member job';
  end if;
  if exists(select 1 from storage.objects where name='3cda2513-82f4-4b80-9918-41f42d8839fb/99000000-0000-4000-8000-000000000002/final.mp4') then
    raise exception 'Member can read another member Storage object';
  end if;
  if exists(select 1 from storage.objects where name='e2f83e79-0133-4c73-9ddf-7ca7fac01b0d/99000000-0000-4000-8000-000000000001/final.mp4') then
    raise exception 'Owner can read an output after its server expiry';
  end if;
  if exists(select 1 from storage.objects where name='e2f83e79-0133-4c73-9ddf-7ca7fac01b0d/99000000-0000-4000-8000-000000000003/scene-01.mp4') then
    raise exception 'Member can read an expired scene merely because its job is still processing';
  end if;
end $$;
reset role;

-- Worker access is administrative and only extends scene reads for unfinished
-- jobs. Restore the fixture member's original profile before other RLS checks.
create temporary table retention_test_admin_restore on commit drop as
  select id, role, approved from public.profiles
  where id='3cda2513-82f4-4b80-9918-41f42d8839fb';
update public.profiles set role='admin', approved=true
  where id='3cda2513-82f4-4b80-9918-41f42d8839fb';
set local role authenticated;
select set_config('request.jwt.claim.sub','3cda2513-82f4-4b80-9918-41f42d8839fb',true);
do $$
begin
  if not public.is_admin() then raise exception 'Worker fixture requires an approved administrator'; end if;
  if not exists(select 1 from storage.objects where name='e2f83e79-0133-4c73-9ddf-7ca7fac01b0d/99000000-0000-4000-8000-000000000003/scene-01.mp4') then
    raise exception 'Worker cannot recover an expired scene while its job is unfinished';
  end if;
  if exists(select 1 from storage.objects where name='3cda2513-82f4-4b80-9918-41f42d8839fb/99000000-0000-4000-8000-000000000006/scene-01.mp4') then
    raise exception 'Worker can read an expired scene after the job completed';
  end if;
end $$;
reset role;
update public.profiles p set role=saved.role, approved=saved.approved
from retention_test_admin_restore saved where p.id=saved.id;

do $$
declare
  retry_id constant uuid := '99000000-0000-4000-8000-000000000001';
  success_id constant uuid := '99000000-0000-4000-8000-000000000002';
  pending_id constant uuid := '99000000-0000-4000-8000-000000000003';
  legacy_id constant uuid := '99000000-0000-4000-8000-000000000004';
  partial_id constant uuid := '99000000-0000-4000-8000-000000000006';
  retry_claim record;
  success_claim record;
  next_claim record;
  partial_claim record;
  attempt_number integer;
  expected_delay interval;
begin
  create temporary table retention_test_claims on commit drop as
    select * from public.claim_expired_brand_outputs(20);
  select * into retry_claim from retention_test_claims where job_id=retry_id;
  select * into success_claim from retention_test_claims where job_id=success_id;
  if retry_claim.job_id is null or retry_claim.retention_attempt<>1 or retry_claim.retention_claim_token is null then
    raise exception 'Expired job was not claimed with attempt and fencing token';
  end if;
  if success_claim.job_id is null then raise exception 'Second eligible member job was not claimed'; end if;
  if jsonb_array_length(retry_claim.scene_paths)<>1 or retry_claim.scene_paths->0->>'path'<>'e2f83e79-0133-4c73-9ddf-7ca7fac01b0d/99000000-0000-4000-8000-000000000001/scene-01.mp4' then
    raise exception 'Claim did not return the scene output path';
  end if;
  if exists(select 1 from public.claim_expired_brand_outputs(20) where job_id in (retry_id,success_id,pending_id,legacy_id,partial_id)) then
    raise exception 'A live claim was duplicated, or a pending/legacy job was selected';
  end if;
  select * into partial_claim from retention_test_claims where job_id=partial_id;
  if partial_claim.job_id is null or partial_claim.final_path is not null or partial_claim.reference_path is not null
    or jsonb_array_length(partial_claim.scene_paths)<>1
    or partial_claim.scene_paths->0->>'path'<>'3cda2513-82f4-4b80-9918-41f42d8839fb/99000000-0000-4000-8000-000000000006/scene-01.mp4' then
    raise exception 'Claim did not isolate only the individually expired scene';
  end if;
  perform public.complete_expired_brand_output(partial_id,partial_claim.retention_claim_token,true,null,
    partial_claim.final_path,partial_claim.reference_path,partial_claim.scene_paths);
  if not exists(select 1 from public.brand_jobs where id=partial_id and retention_status='active' and final_path is not null and reference_path is not null) then
    raise exception 'Partial cleanup incorrectly marked the entire job expired or cleared later outputs';
  end if;
  if (select output_path from public.brand_scenes where job_id=partial_id and scene_index=1) is not null
    or (select output_path from public.brand_scenes where job_id=partial_id and scene_index=2) is null then
    raise exception 'Partial cleanup did not clear exactly the expired scene path';
  end if;

  -- A stale invocation is fenced out after the lease is reclaimed.
  update public.brand_jobs set retention_claimed_at=clock_timestamp()-interval '16 minutes' where id=success_id;
  select * into next_claim from public.claim_expired_brand_outputs(20) where job_id=success_id;
  if next_claim.job_id is null or next_claim.retention_attempt<>2 or next_claim.retention_claim_token=success_claim.retention_claim_token then
    raise exception 'Stale deletion lease was not safely reclaimed';
  end if;
  begin
    perform public.complete_expired_brand_output(success_id,success_claim.retention_claim_token,true,null,
      success_claim.final_path,success_claim.reference_path,success_claim.scene_paths);
    raise exception 'STALE_RETENTION_TOKEN_ACCEPTED';
  exception when raise_exception then
    if sqlerrm='STALE_RETENTION_TOKEN_ACCEPTED' then raise; end if;
  end;
  perform public.complete_expired_brand_output(success_id,next_claim.retention_claim_token,true,null,
    next_claim.final_path,next_claim.reference_path,next_claim.scene_paths);
  if not exists(select 1 from public.brand_jobs where id=success_id and retention_status='expired' and final_path is null and retention_deleted_at is not null) then
    raise exception 'Successful deletion did not mark the record expired and clear the final path';
  end if;
  if exists(select 1 from public.brand_scenes where job_id=success_id and output_path is not null) then
    raise exception 'Successful deletion left a scene output path';
  end if;
  -- Verify bounded retry backoff (1, 5, 15, 60 minutes) and terminal attempt 5.
  perform public.complete_expired_brand_output(retry_id,retry_claim.retention_claim_token,false,'STORAGE_TIMEOUT');
  for attempt_number in 1..5 loop
    if not exists(select 1 from public.brand_jobs where id=retry_id and retention_status='delete_failed') then
      raise exception 'Failed Storage deletion did not record a retryable state';
    end if;
    if attempt_number=1 then expected_delay:=interval '1 minute';
    elsif attempt_number=2 then expected_delay:=interval '5 minutes';
    elsif attempt_number=3 then expected_delay:=interval '15 minutes';
    elsif attempt_number=4 then expected_delay:=interval '60 minutes';
    else expected_delay:=null;
    end if;
    if attempt_number<5 and not exists(select 1 from public.brand_jobs where id=retry_id
        and retention_next_attempt_at between clock_timestamp()+expected_delay-interval '10 seconds'
        and clock_timestamp()+expected_delay+interval '10 seconds'
        and retention_error is not null) then
      raise exception 'Retry attempt % did not schedule the expected delay',attempt_number;
    end if;
    if attempt_number=5 then
      if exists(select 1 from public.brand_jobs where id=retry_id and retention_next_attempt_at is not null) then
        raise exception 'Retry limit did not become terminal';
      end if;
      exit;
    end if;
    update public.brand_jobs set retention_next_attempt_at=now()-interval '1 second' where id=retry_id;
    select * into next_claim from public.claim_expired_brand_outputs(20) where job_id=retry_id;
    if next_claim.job_id is null or next_claim.retention_attempt<>attempt_number+1 then
      raise exception 'Retry attempt % was not claimed exactly once',attempt_number+1;
    end if;
    perform public.complete_expired_brand_output(retry_id,next_claim.retention_claim_token,false,'STORAGE_TIMEOUT');
  end loop;
  if exists(select 1 from public.claim_expired_brand_outputs(20) where job_id=retry_id) then
    raise exception 'Terminal delete_failed job was claimed again';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub','3cda2513-82f4-4b80-9918-41f42d8839fb',true);
do $$
begin
  if exists(select 1 from storage.objects where name='3cda2513-82f4-4b80-9918-41f42d8839fb/99000000-0000-4000-8000-000000000002/final.mp4') then
    raise exception 'Owner can read a file after successful expiration';
  end if;
  if exists(select 1 from storage.objects where name='3cda2513-82f4-4b80-9918-41f42d8839fb/99000000-0000-4000-8000-000000000006/scene-01.mp4') then
    raise exception 'The expired scene remained readable after its path was cleared';
  end if;
  if not exists(select 1 from storage.objects where name='3cda2513-82f4-4b80-9918-41f42d8839fb/99000000-0000-4000-8000-000000000006/scene-02.mp4') then
    raise exception 'An unexpired scene became unreadable when another scene expired';
  end if;
end $$;
reset role;

rollback;
select 'BRAND_OUTPUT_RETENTION_LIFECYCLE_OK' as result;
