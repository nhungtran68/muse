-- Additive rollout: existing jobs stay in Supabase. New jobs switch only after
-- the gateway, worker, bucket policy and cleanup function have been verified.
alter table public.brand_jobs
  add column storage_provider text not null default 'supabase' check(storage_provider in ('supabase','r2')),
  add column reference_storage_provider text not null default 'supabase' check(reference_storage_provider in ('supabase','r2'));

create table private.r2_media_settings (
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false
);
insert into private.r2_media_settings(singleton,enabled) values(true,false);
revoke all on private.r2_media_settings from public,anon,authenticated;

create function private.assign_job_storage_provider() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if (select enabled from private.r2_media_settings where singleton) then
    new.storage_provider='r2';new.reference_storage_provider='r2';
  else
    new.storage_provider='supabase';new.reference_storage_provider='supabase';
  end if;
  return new;
end $$;
revoke all on function private.assign_job_storage_provider() from public,anon,authenticated;
create trigger assign_job_storage_provider before insert on public.brand_jobs
for each row execute function private.assign_job_storage_provider();

-- Old worker binaries cannot read R2. They may keep processing old jobs, but
-- must never claim an R2 job even if another machine is still running them.
create table private.r2_worker_capabilities(worker_id uuid primary key,registered_at timestamptz not null default now());
revoke all on private.r2_worker_capabilities from public,anon,authenticated;
create function public.register_r2_worker(p_worker uuid,p_token uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  perform private.assert_muse_lease(p_worker,p_token);
  insert into private.r2_worker_capabilities(worker_id,registered_at) values(p_worker,now())
    on conflict(worker_id) do update set registered_at=excluded.registered_at;
  return true;
end $$;
revoke all on function public.register_r2_worker(uuid,uuid) from public,anon;
grant execute on function public.register_r2_worker(uuid,uuid) to authenticated;

create or replace function public.claim_brand_job_v2(p_worker uuid,p_token uuid) returns public.brand_jobs
language plpgsql security definer set search_path='' as $$
declare result public.brand_jobs%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(735105402);
  perform private.assert_muse_lease(p_worker,p_token);
  perform private.expire_stalled_muse_jobs();
  if exists(select 1 from public.brand_jobs where schema_version=2 and status in ('planning','generating','joining')) then return null; end if;
  select * into result from public.brand_jobs j where j.schema_version=2 and j.status='queued'
    and ((j.storage_provider='supabase' and j.reference_storage_provider='supabase') or exists(select 1 from private.r2_worker_capabilities c where c.worker_id=p_worker))
    order by j.created_at,j.id for update skip locked limit 1;
  if not found then return null; end if;
  update public.brand_jobs set status='planning',worker_id=p_worker,claim_token=extensions.gen_random_uuid(),lease_expires_at=now()+interval '90 seconds',attempt=attempt+1,error=null,error_code=null,updated_at=now() where id=result.id returning * into result;
  insert into public.brand_job_events(job_id,attempt,status) values(result.id,result.attempt,'planning');return result;
end $$;

create or replace function public.claim_brand_job_v3(p_worker uuid,p_token uuid) returns public.brand_jobs
language plpgsql security definer set search_path='' as $$
declare result public.brand_jobs%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(735105402);
  perform private.assert_muse_lease(p_worker,p_token);
  perform private.expire_stalled_muse_jobs();
  if exists(select 1 from public.brand_jobs where schema_version in (2,3) and status in ('planning','generating','joining')) then return null; end if;
  select * into result from public.brand_jobs j where j.schema_version=3 and j.status in ('script_queued','video_queued')
    and ((j.storage_provider='supabase' and j.reference_storage_provider='supabase') or exists(select 1 from private.r2_worker_capabilities c where c.worker_id=p_worker))
    order by j.created_at,j.id for update skip locked limit 1;
  if not found then return null; end if;
  update public.brand_jobs set status=case when status='script_queued' then 'planning' else 'generating' end,
    worker_id=p_worker,claim_token=extensions.gen_random_uuid(),lease_expires_at=now()+interval '90 seconds',
    attempt=attempt+1,error=null,error_code=null,updated_at=now() where id=result.id returning * into result;
  insert into public.brand_job_events(job_id,attempt,status) values(result.id,result.attempt,result.status);return result;
end $$;

-- A short-lived cleanup claim authorizes deletion only for the exact already
-- expired files of that job. It does not authorize reads or future deletions.
create function public.authorize_r2_expiry(p_id uuid,p_claim uuid,p_bucket text,p_paths text[])
returns boolean language plpgsql stable security definer set search_path='' as $$
declare job public.brand_jobs%rowtype; item text;
begin
  if p_claim is null or p_bucket is null or p_bucket not in ('brand-videos','brand-references')
     or coalesce(array_length(p_paths,1),0) not between 1 and 10 then return false; end if;
  select * into job from public.brand_jobs where id=p_id and status='done'
    and retention_status='deleting' and retention_claim_token=p_claim
    and retention_claimed_at>now()-interval '15 minutes';
  if not found then return false; end if;
  foreach item in array p_paths loop
    if item is null then return false; end if;
    if p_bucket='brand-references' then
      if job.reference_storage_provider<>'r2' or not exists(
        select 1 from public.brand_jobs j where j.id=p_id and j.reference_path=item and j.reference_expires_at<=now()
      ) then return false; end if;
    else
      if job.storage_provider<>'r2' or not exists(
        select 1 from public.brand_jobs j where j.id=p_id and j.final_path=item and j.output_expires_at<=now()
        union all select 1 from public.brand_scenes s where s.job_id=p_id and s.output_path=item and s.output_expires_at<=now()
      ) then return false; end if;
    end if;
  end loop;
  return true;
end $$;
revoke all on function public.authorize_r2_expiry(uuid,uuid,text,text[]) from public;
grant execute on function public.authorize_r2_expiry(uuid,uuid,text,text[]) to anon,authenticated;

-- Recover only a previously sent, oversized direct-media job; keep its receipt
-- and original conversation so the worker cannot issue a duplicate generation.
create function public.resume_oversize_job_in_r2(p_id uuid) returns public.brand_jobs
language plpgsql security definer set search_path='' as $$
declare job public.brand_jobs%rowtype; scene public.brand_scenes%rowtype;
begin
  if not exists(select 1 from private.r2_media_settings where singleton and enabled) then raise exception 'Kho R2 chưa được bật'; end if;
  if not exists(select 1 from public.profiles where id=auth.uid() and approved) then raise exception 'Tài khoản chưa được duyệt'; end if;
  select * into job from public.brand_jobs where id=p_id and (user_id=auth.uid() or public.is_admin()) for update;
  if not found then raise exception 'Không tìm thấy yêu cầu'; end if;
  if job.status in ('queued','planning','generating','joining','done') and job.storage_provider='r2' then return job; end if;
  if job.status<>'error' or job.error_code<>'MEDIA_TOO_LARGE' or job.schema_version<>2
     or job.scene_count<>1 or job.creation_mode not in ('video_free','image') or job.final_path is not null
     or nullif(job.conversation_ref->>'url','') is null then raise exception 'Yêu cầu chưa thể nhận lại qua R2'; end if;
  if job.reference_path is not null and job.reference_expires_at is not null and job.reference_expires_at<=now() then
    raise exception 'Ảnh tham chiếu của yêu cầu đã hết hạn';
  end if;
  select * into scene from public.brand_scenes where job_id=p_id and scene_index=1 for update;
  if not found or scene.output_path is not null or scene.submission_state not in ('sending','sent')
     or coalesce(jsonb_typeof(scene.request_receipt),'')<>'object' or nullif(scene.request_receipt->>'key','') is null then
    raise exception 'Không còn biên nhận Muse để nhận lại an toàn';
  end if;
  update public.brand_scenes set status='error',error_code='MUSE_TIMEOUT',error='Chờ nhận lại kết quả Muse đã tạo.',updated_at=now()
    where job_id=p_id and scene_index=1;
  update public.brand_jobs set storage_provider='r2',status='queued',attempt=0,error=null,error_code=null,retryable=true,
    worker_id=null,claim_token=null,lease_expires_at=null,updated_at=now() where id=p_id returning * into job;
  insert into public.brand_job_events(job_id,attempt,status,message) values(p_id,0,'queued','Nhận lại kết quả Muse đã gửi, lưu vào R2; không tạo mới');
  return job;
end $$;
revoke all on function public.resume_oversize_job_in_r2(uuid) from public,anon;
grant execute on function public.resume_oversize_job_in_r2(uuid) to authenticated;
notify pgrst,'reload schema';
