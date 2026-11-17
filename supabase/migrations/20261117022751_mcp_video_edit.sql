-- Video source jobs are opt-in and kept away from older workers. Rollback:
-- set enabled=false and deploy the previous code; retain columns and jobs.
alter table public.brand_jobs add column reference_kind text not null default 'image'
  check(reference_kind in ('image','video')),
  add column video_edit_retries integer not null default 0 check(video_edit_retries between 0 and 3),
  add column video_edit_retry_after timestamptz;

create table private.video_edit_settings(singleton boolean primary key default true check(singleton),enabled boolean not null default false,
  test_member_id uuid references public.profiles(id));
insert into private.video_edit_settings(singleton,enabled) values(true,false);
create table private.video_edit_worker_capabilities(worker_id uuid primary key,registered_at timestamptz not null default now());
alter table private.video_edit_settings enable row level security;
alter table private.video_edit_worker_capabilities enable row level security;
revoke all on private.video_edit_settings,private.video_edit_worker_capabilities from public,anon,authenticated;

-- R2 stores the content. Supabase Storage holds a zero-byte marker only,
-- used by the existing queue authorization and retention rules.
update storage.buckets set allowed_mime_types=array_append(allowed_mime_types,'video/mp4')
where id='brand-references' and not ('video/mp4'=any(allowed_mime_types));

create function public.register_video_edit_worker(p_worker uuid,p_token uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  perform private.assert_muse_lease(p_worker,p_token);
  insert into private.video_edit_worker_capabilities(worker_id,registered_at) values(p_worker,now())
    on conflict(worker_id) do update set registered_at=excluded.registered_at;
  return true;
end $$;
revoke all on function public.register_video_edit_worker(uuid,uuid) from public,anon;
grant execute on function public.register_video_edit_worker(uuid,uuid) to authenticated;

create function public.submit_video_edit_job(
  p_id uuid,p_request_key uuid,p_content text,p_reference_sha256 text,p_send_zalo boolean default false
) returns public.brand_jobs language plpgsql security definer set search_path='' as $$
declare result public.brand_jobs%rowtype; settings public.app_settings%rowtype;
  permissions record; fingerprint text; selected_group text; single_plan jsonb;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text,17));
  if not exists(select 1 from public.profiles where id=auth.uid() and approved) then raise exception 'MEMBER_NOT_APPROVED'; end if;
  if not exists(select 1 from private.video_edit_settings where singleton and enabled
    and (test_member_id is null or test_member_id=auth.uid())) then raise exception 'VIDEO_EDIT_UNAVAILABLE'; end if;
  if p_id is null or p_request_key is null or p_content is null or char_length(trim(p_content)) not between 10 and 4000
    or p_reference_sha256 is null or p_reference_sha256 !~ '^[0-9a-f]{64}$' or p_send_zalo is null then
    raise exception 'INVALID_VIDEO_EDIT_INPUT';
  end if;
  select * into permissions from private.video_distribution_for(auth.uid());
  if permissions.allow_r2 is distinct from true then raise exception 'R2_NOT_ALLOWED'; end if;
  if p_send_zalo and permissions.group_id is null then raise exception 'ZALO_NOT_ALLOWED'; end if;
  selected_group=case when p_send_zalo then permissions.group_id end;
  fingerprint=encode(extensions.digest(convert_to('video-edit-v1|'||trim(p_content)||'|'||p_reference_sha256||'|'||coalesce(selected_group,''),'UTF8'),'sha256'),'hex');
  select * into result from public.brand_jobs where user_id=auth.uid() and request_key=p_request_key;
  if found then
    if result.id<>p_id or result.input_hash<>fingerprint or result.reference_kind<>'video' then raise exception 'REQUEST_ID_CONFLICT'; end if;
    return result;
  end if;
  select * into result from public.brand_jobs where user_id=auth.uid() and reference_kind='video' and input_hash=fingerprint
    and status in ('uploading','queued','planning','generating','joining') order by created_at,id limit 1;
  if found then return result; end if;
  select * into settings from public.app_settings where id=true;
  if not settings.enabled then raise exception 'REQUESTS_PAUSED'; end if;
  if (select count(*) from public.brand_jobs where user_id=auth.uid()
    and created_at>=date_trunc('day',now() at time zone 'Asia/Ho_Chi_Minh') at time zone 'Asia/Ho_Chi_Minh')>=settings.daily_limit then
    raise exception 'DAILY_LIMIT_REACHED';
  end if;
  single_plan=jsonb_build_array(jsonb_build_object('index',1,'seconds',null,'prompt',trim(p_content),'dialogue','','action','single_free_video_request','source_quotes','[]'::jsonb));
  insert into public.brand_jobs(id,user_id,content,scene_count,scene_seconds,reference_path,schema_version,request_key,input_hash,
    reference_sha256,reference_kind,plan,workflow_phase,creation_mode,status,output_r2_selected)
  values(p_id,auth.uid(),trim(p_content),1,null,auth.uid()::text||'/'||p_id::text||'/reference',2,p_request_key,fingerprint,
    p_reference_sha256,'video',single_plan,'video','video_free','uploading',true) returning * into result;
  if result.storage_provider<>'r2' or result.reference_storage_provider<>'r2' then raise exception 'R2_NOT_AVAILABLE'; end if;
  insert into public.brand_scenes(job_id,scene_index,prompt,dialogue,planned_seconds,action,source_quotes)
    values(p_id,1,trim(p_content),'',null,'single_free_video_request','[]'::jsonb);
  if selected_group is not null then
    insert into private.job_zalo_destination(job_id,admin_id,group_id) values(p_id,permissions.admin_id,selected_group);
  end if;
  insert into public.brand_job_events(job_id,attempt,status,message) values(p_id,0,'uploading','Chờ tải video nguồn');
  return result;
end $$;
revoke all on function public.submit_video_edit_job(uuid,uuid,text,text,boolean) from public,anon;
grant execute on function public.submit_video_edit_job(uuid,uuid,text,text,boolean) to authenticated;

-- Preserve v2 queue order and R2 gating; old workers can never claim a video
-- input, even when they know how to use R2.
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
    and (j.reference_kind='image' or exists(select 1 from private.video_edit_worker_capabilities c where c.worker_id=p_worker))
    and (j.video_edit_retry_after is null or j.video_edit_retry_after<=now())
    order by j.created_at,j.id for update skip locked limit 1;
  if not found then return null; end if;
  update public.brand_jobs set status='planning',worker_id=p_worker,claim_token=extensions.gen_random_uuid(),lease_expires_at=now()+interval '90 seconds',attempt=attempt+1,error=null,error_code=null,updated_at=now() where id=result.id returning * into result;
  insert into public.brand_job_events(job_id,attempt,status) values(result.id,result.attempt,'planning');
  return result;
end $$;

-- Requeue at most three safe recovery attempts. A receipt always resumes the
-- original conversation; a missing receipt permits a new draft only before
-- Enter could have been pressed. An uncertain conversation is left for review.
create function public.schedule_video_edit_recovery(p_worker uuid,p_token uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare job public.brand_jobs%rowtype; scene public.brand_scenes%rowtype;
begin
  perform private.assert_muse_lease(p_worker,p_token);
  if not exists(select 1 from private.video_edit_worker_capabilities where worker_id=p_worker) then return false; end if;
  select j.* into job from public.brand_jobs j join public.brand_scenes s on s.job_id=j.id and s.scene_index=1
  where j.reference_kind='video' and j.status='error' and j.retryable and j.attempt<j.max_attempts
    and j.video_edit_retries<3 and j.updated_at<=now()-interval '10 seconds'
    and j.error_code in ('WORKER_INTERRUPTED','MUSE_TIMEOUT','SUBMISSION_NOT_FOUND','VIDEO_SOURCE_DOWNLOAD_FAILED')
    and j.retention_status<>'deleting' and (j.reference_expires_at is null or j.reference_expires_at>now())
    and ((s.request_receipt is null and s.submission_state='not_sent') or
      (s.request_receipt is not null and s.submission_state in ('sending','sent')
       and coalesce(j.conversation_ref->>'url','') ~ '^https://muse\.ai/thread/[0-9a-fA-F-]{36}$'))
  order by j.updated_at,j.id for update of j skip locked limit 1;
  if not found then return false; end if;
  select * into scene from public.brand_scenes where job_id=job.id and scene_index=1 for update;
  update public.brand_jobs set status='queued',error=null,error_code=null,worker_id=null,claim_token=null,lease_expires_at=null,
    conversation_ref=case when scene.request_receipt is null then null else conversation_ref end,
    video_edit_retries=video_edit_retries+1,video_edit_retry_after=now()+interval '30 seconds',updated_at=now() where id=job.id;
  insert into public.brand_job_events(job_id,attempt,status,message)
    values(job.id,job.attempt,'queued','Tự tiếp tục yêu cầu chỉnh sửa an toàn; không gửi trùng khi đã có biên nhận.');
  return true;
end $$;
revoke all on function public.schedule_video_edit_recovery(uuid,uuid) from public,anon;
grant execute on function public.schedule_video_edit_recovery(uuid,uuid) to authenticated;
notify pgrst,'reload schema';
