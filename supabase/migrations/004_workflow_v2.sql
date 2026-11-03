-- Workflow v2, additive schema. Rollback requires disabling submissions and
-- explicitly restoring the v1 RPCs and policies before redeploying v1 binaries.
-- Retain all v2 columns and history; do not drop customer data.
create schema if not exists private;
revoke all on schema private from public,anon,authenticated;

create table public.video_modes (
  seconds integer primary key check(seconds in (5,8,10)),
  enabled boolean not null default false,
  verified_at timestamptz,
  note text not null default ''
);
alter table public.video_modes enable row level security;
create policy modes_read on public.video_modes for select to authenticated using(true);
create policy modes_admin_update on public.video_modes for update to authenticated using((select public.is_admin())) with check((select public.is_admin()));
grant select,update on public.video_modes to authenticated;

alter table public.brand_jobs add column schema_version integer not null default 1,
 add column request_key uuid,
 add column input_hash text,
 add column reference_sha256 text,
 add column analysis jsonb not null default '{}'::jsonb,
 add column script_outline text,
 add column attempt integer not null default 0,
 add column max_attempts integer not null default 3,
 add column worker_id uuid,
 add column claim_token uuid,
 add column lease_expires_at timestamptz,
 add column conversation_ref jsonb,
 add column error_code text,
 add column retryable boolean not null default true,
 add column final_probe jsonb;
create unique index brand_jobs_request_key on public.brand_jobs(user_id,request_key) where request_key is not null;
create index brand_jobs_live_fingerprint on public.brand_jobs(user_id,input_hash) where status in ('uploading','queued','planning','generating','joining');
alter table public.brand_jobs drop constraint brand_jobs_status_check;
alter table public.brand_jobs add constraint brand_jobs_status_check check(status in ('uploading','queued','planning','generating','joining','done','error','needs_review','reviewed'));
alter table public.brand_jobs drop constraint brand_jobs_scene_seconds_check;
alter table public.brand_jobs add constraint brand_jobs_scene_seconds_check check(scene_seconds in (5,8,10));

alter table public.brand_scenes add column dialogue text not null default '',
 add column generation integer not null default 0,
 add column error_code text,
 add column planned_seconds integer,
 add column action text not null default '',
 add column source_quotes jsonb not null default '[]'::jsonb,
 add column speech_estimate jsonb,
 add column speech_audit jsonb,
 add column output_sha256 text,
 add column submission_state text not null default 'not_sent' check(submission_state in ('not_sent','sending','sent','downloaded')),
 add column request_receipt jsonb,
 add column error text,
 add column updated_at timestamptz not null default now();
alter table public.brand_scenes drop constraint brand_scenes_status_check;
alter table public.brand_scenes add constraint brand_scenes_status_check check(status in ('waiting','generating','done','error','needs_review'));

create table private.muse_worker_lease (
 resource text primary key check(resource='primary'),
 worker_id uuid not null,
 token uuid not null,
 expires_at timestamptz not null
);
create table public.brand_job_events (
 id bigint generated always as identity primary key,
 job_id uuid not null references public.brand_jobs(id) on delete cascade,
 attempt integer not null,
 status text not null,
 error_code text,
 message text,
 created_at timestamptz not null default now()
);
alter table public.brand_job_events enable row level security;
create policy events_read on public.brand_job_events for select to authenticated using(exists(select 1 from public.brand_jobs j where j.id=job_id and (j.user_id=(select auth.uid()) or (select public.is_admin()))));
grant select on public.brand_job_events to authenticated;

drop policy jobs_admin_update on public.brand_jobs;
drop policy scenes_admin_write on public.brand_scenes;
drop policy jobs_read on public.brand_jobs;
drop policy scenes_read on public.brand_scenes;
create policy jobs_read on public.brand_jobs for select to authenticated using(user_id=(select auth.uid()) or (select public.is_admin()));
create policy scenes_read on public.brand_scenes for select to authenticated using(exists(select 1 from public.brand_jobs j where j.id=job_id and (j.user_id=(select auth.uid()) or (select public.is_admin()))));
revoke insert,update,delete on public.brand_jobs,public.brand_scenes from authenticated;
grant select on public.brand_jobs,public.brand_scenes to authenticated;

-- Authenticated file reads must correspond to an owned, committed job.
drop policy ref_read on storage.objects;
drop policy video_read on storage.objects;
drop policy video_upload on storage.objects;
drop policy video_update on storage.objects;
create policy ref_read on storage.objects for select to authenticated using(bucket_id='brand-references' and exists(select 1 from public.brand_jobs j where j.reference_path=name and (j.user_id=(select auth.uid()) or (select public.is_admin()))));
create policy video_read on storage.objects for select to authenticated using(bucket_id='brand-videos' and ((select public.is_admin()) or exists(select 1 from public.brand_jobs j where j.user_id=(select auth.uid()) and ((j.status='done' and j.final_path=name) or exists(select 1 from public.brand_scenes s where s.job_id=j.id and s.status='done' and s.output_path=name)))));
create function public.can_upload_brand_video(p_name text) returns boolean language sql stable security definer set search_path='' as $$
 select public.is_admin() and exists(select 1 from public.brand_jobs j join private.muse_worker_lease l on l.resource='primary' and l.worker_id=j.worker_id where split_part(p_name,'/',1)=j.user_id::text and split_part(p_name,'/',2)=j.id::text and split_part(p_name,'/',3)=j.claim_token::text and j.lease_expires_at>now() and l.expires_at>now() and j.status in ('planning','generating','joining'));
$$;
revoke all on function public.can_upload_brand_video(text) from public,anon;
grant execute on function public.can_upload_brand_video(text) to authenticated;
create policy video_upload on storage.objects for insert to authenticated with check(bucket_id='brand-videos' and public.can_upload_brand_video(name));
-- An attempt has immutable objects. Retry uses a new claim token; never overwrite.
-- Grant no UPDATE/DELETE policy to authenticated for generated videos.

create or replace function public.submit_brand_job_v2(p_id uuid,p_request_key uuid,p_content text,p_scene_count integer,p_seconds integer,p_reference_sha256 text)
returns public.brand_jobs language plpgsql security definer set search_path='' as $$
declare result public.brand_jobs%rowtype; settings public.app_settings%rowtype; fingerprint text;
begin
 if auth.uid() is null then raise exception 'Cần đăng nhập'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text,17));
 if not exists(select 1 from public.profiles where id=auth.uid() and approved) then raise exception 'Tài khoản chưa được quản trị duyệt'; end if;
 if p_id is null or p_request_key is null or p_content is null or char_length(trim(p_content)) not between 10 and 4000 or p_reference_sha256 is null or p_reference_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'Thông tin yêu cầu không hợp lệ'; end if;
 fingerprint=encode(extensions.digest(convert_to(trim(p_content)||'|'||p_scene_count::text||'|'||p_seconds::text||'|'||p_reference_sha256,'UTF8'),'sha256'),'hex');
 select * into result from public.brand_jobs where user_id=auth.uid() and request_key=p_request_key;
 if found then
  if result.input_hash<>fingerprint then raise exception 'Mã gửi đã được dùng cho nội dung khác'; end if;
  return result;
 end if;
 select * into result from public.brand_jobs where user_id=auth.uid() and input_hash=fingerprint and status in ('uploading','queued','planning','generating','joining') order by created_at limit 1;
 if found then return result; end if;
 select * into settings from public.app_settings where id=true;
 if not settings.enabled then raise exception 'Đang bảo trì, vui lòng thử lại sau'; end if;
 if p_scene_count is null or p_scene_count not between 1 and settings.max_scenes then raise exception 'Số cảnh không hợp lệ'; end if;
 if not exists(select 1 from public.video_modes where seconds=p_seconds and enabled) then raise exception 'Mode thời lượng này chưa được xác nhận hỗ trợ'; end if;
 if (select count(*) from public.brand_jobs where user_id=auth.uid() and created_at>=date_trunc('day',now() at time zone 'Asia/Ho_Chi_Minh') at time zone 'Asia/Ho_Chi_Minh')>=settings.daily_limit then raise exception 'Đã hết lượt trong ngày'; end if;
 insert into public.brand_jobs(id,user_id,content,scene_count,scene_seconds,reference_path,schema_version,request_key,input_hash,reference_sha256)
 values(p_id,auth.uid(),trim(p_content),p_scene_count,p_seconds,auth.uid()::text||'/'||p_id::text||'/reference',2,p_request_key,fingerprint,p_reference_sha256) returning * into result;
 return result;
end $$;
revoke all on function public.submit_brand_job_v2(uuid,uuid,text,integer,integer,text) from public,anon;
grant execute on function public.submit_brand_job_v2(uuid,uuid,text,integer,integer,text) to authenticated;

create or replace function public.queue_brand_job(p_id uuid) returns public.brand_jobs language plpgsql security definer set search_path='' as $$
declare result public.brand_jobs%rowtype;
begin
 select * into result from public.brand_jobs where id=p_id and user_id=auth.uid() for update;
 if not found then raise exception 'Không tìm thấy yêu cầu'; end if;
 if result.status<>'uploading' then return result; end if;
 if not exists(select 1 from public.profiles where id=auth.uid() and approved) then raise exception 'Tài khoản chưa được duyệt'; end if;
 if not exists(select 1 from storage.objects where bucket_id='brand-references' and name=result.reference_path) then raise exception 'Chưa tải xong ảnh tham chiếu'; end if;
 update public.brand_jobs set status='queued',updated_at=now() where id=p_id returning * into result;
 insert into public.brand_job_events(job_id,attempt,status) values(p_id,0,'queued');return result;
end $$;

create function public.retry_brand_job(p_id uuid) returns public.brand_jobs language plpgsql security definer set search_path='' as $$
declare result public.brand_jobs%rowtype;
begin
 select * into result from public.brand_jobs where id=p_id and (user_id=auth.uid() or public.is_admin()) for update;
 if not found then raise exception 'Không tìm thấy yêu cầu'; end if;
 if result.status='queued' then return result; end if;
 if result.schema_version<>2 or result.status<>'error' or not result.retryable then raise exception 'Yêu cầu này cần quản trị kiểm tra trước khi thử lại'; end if;
 if result.attempt>=result.max_attempts then raise exception 'Đã hết số lần thử lại, cần quản trị kiểm tra'; end if;
 if not exists(select 1 from public.profiles where id=auth.uid() and approved) then raise exception 'Tài khoản chưa được duyệt'; end if;
 update public.brand_jobs set status='queued',error=null,error_code=null,updated_at=now(),worker_id=null,claim_token=null,lease_expires_at=null where id=p_id returning * into result;
 insert into public.brand_job_events(job_id,attempt,status,message) values(p_id,result.attempt,'queued','Thử lại; giữ nguyên cảnh đã hoàn tất');return result;
end $$;
revoke all on function public.retry_brand_job(uuid) from public,anon;
grant execute on function public.retry_brand_job(uuid) to authenticated;

create function public.review_legacy_brand_job(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 if not public.is_admin() then raise exception 'Chỉ quản trị viên'; end if;
 update public.brand_jobs set status='reviewed',updated_at=now() where id=p_id and schema_version=1 and status='needs_review';
 if not found then raise exception 'Không tìm thấy yêu cầu cũ cần kiểm tra'; end if;
end $$;
revoke all on function public.review_legacy_brand_job(uuid) from public,anon;
grant execute on function public.review_legacy_brand_job(uuid) to authenticated;

create function public.acquire_muse_worker(p_worker uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare lease private.muse_worker_lease%rowtype;
begin
 if not public.is_admin() then raise exception 'Chỉ quản trị viên được chạy worker'; end if;
 if p_worker is null then raise exception 'Thiếu mã worker'; end if;
 perform pg_catalog.pg_advisory_xact_lock(735105402);
 select * into lease from private.muse_worker_lease where resource='primary' for update;
 if found and lease.expires_at>now() and lease.worker_id<>p_worker then return null; end if;
 if not found or lease.worker_id<>p_worker or lease.expires_at<=now() then
  insert into private.muse_worker_lease(resource,worker_id,token,expires_at) values('primary',p_worker,extensions.gen_random_uuid(),now()+interval '90 seconds')
  on conflict(resource) do update set worker_id=excluded.worker_id,token=excluded.token,expires_at=excluded.expires_at returning * into lease;
 else
  update private.muse_worker_lease set expires_at=now()+interval '90 seconds' where resource='primary' returning * into lease;
 end if;
 return jsonb_build_object('token',lease.token,'expires_at',lease.expires_at);
end $$;

create function private.assert_muse_lease(p_worker uuid,p_token uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 if not public.is_admin() or not exists(select 1 from private.muse_worker_lease where resource='primary' and worker_id=p_worker and token=p_token and expires_at>now()) then raise exception 'WORKER_LEASE_LOST'; end if;
end $$;
revoke all on function private.assert_muse_lease(uuid,uuid) from public,anon,authenticated;

create function public.renew_muse_worker(p_worker uuid,p_token uuid) returns boolean language plpgsql security definer set search_path='' as $$
begin
 perform private.assert_muse_lease(p_worker,p_token);
 update private.muse_worker_lease set expires_at=now()+interval '90 seconds' where resource='primary' and worker_id=p_worker and token=p_token;
 update public.brand_jobs set lease_expires_at=now()+interval '90 seconds' where worker_id=p_worker and status in ('planning','generating','joining');
 update public.app_settings set worker_heartbeat=now() where id=true;return true;
end $$;

create function public.release_muse_worker(p_worker uuid,p_token uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 if not public.is_admin() then raise exception 'Chỉ quản trị viên'; end if;
 delete from private.muse_worker_lease where resource='primary' and worker_id=p_worker and token=p_token;
end $$;

create function public.claim_brand_job_v2(p_worker uuid,p_token uuid) returns public.brand_jobs language plpgsql security definer set search_path='' as $$
declare result public.brand_jobs%rowtype;
begin
 perform pg_catalog.pg_advisory_xact_lock(735105402);
 perform private.assert_muse_lease(p_worker,p_token);
 with expired as (
  update public.brand_jobs set status='error',error_code='WORKER_INTERRUPTED',error='Worker bị gián đoạn; có thể thử lại để nhận tiếp đúng cảnh đã gửi.',updated_at=now()
  where schema_version=2 and status in ('planning','generating','joining') and lease_expires_at<=now() returning id,attempt
 ) insert into public.brand_job_events(job_id,attempt,status,error_code) select id,attempt,'error','WORKER_INTERRUPTED' from expired;
 if exists(select 1 from public.brand_jobs where schema_version=2 and status in ('planning','generating','joining')) then return null; end if;
 select * into result from public.brand_jobs where schema_version=2 and status='queued' order by created_at,id for update skip locked limit 1;
 if not found then return null; end if;
 update public.brand_jobs set status='planning',worker_id=p_worker,claim_token=extensions.gen_random_uuid(),lease_expires_at=now()+interval '90 seconds',attempt=attempt+1,error=null,error_code=null,updated_at=now() where id=result.id returning * into result;
 insert into public.brand_job_events(job_id,attempt,status) values(result.id,result.attempt,'planning');return result;
end $$;

create function public.update_brand_job_v2(p_id uuid,p_worker uuid,p_token uuid,p_claim uuid,p_patch jsonb) returns public.brand_jobs language plpgsql security definer set search_path='' as $$
declare result public.brand_jobs%rowtype; next_status text; v_path text;
begin
 perform private.assert_muse_lease(p_worker,p_token);
 select * into result from public.brand_jobs where id=p_id and worker_id=p_worker and claim_token=p_claim and lease_expires_at>now() for update;
 if not found then raise exception 'JOB_LEASE_LOST'; end if;
 next_status=coalesce(p_patch->>'status',result.status);
 if not (next_status=result.status or (result.status='planning' and next_status in ('generating','error')) or (result.status='generating' and next_status in ('joining','error')) or (result.status='joining' and next_status in ('done','error'))) then raise exception 'INVALID_JOB_TRANSITION'; end if;
 if p_patch ? 'plan' then
  if result.status<>'planning' or jsonb_typeof(p_patch->'plan')<>'array' or jsonb_array_length(p_patch->'plan')<>result.scene_count then raise exception 'INVALID_PLAN'; end if;
  if exists(select 1 from jsonb_array_elements(p_patch->'plan') with ordinality as x(v,n) where (v->>'index')::integer<>n or (v->>'seconds')::integer<>result.scene_seconds or v->>'dialogue' is null) then raise exception 'INVALID_PLAN_SCENES'; end if;
  insert into public.brand_scenes(job_id,scene_index,prompt,dialogue,planned_seconds,action,source_quotes,speech_estimate)
  select p_id,(v->>'index')::integer,v->>'prompt',v->>'dialogue',(v->>'seconds')::integer,coalesce(v->>'action',''),coalesce(v->'source_quotes','[]'),v->'speech' from jsonb_array_elements(p_patch->'plan') v
  on conflict(job_id,scene_index) do nothing;
 end if;
 if next_status='done' then
  v_path=p_patch->>'final_path';
  if v_path is null or split_part(v_path,'/',1)<>result.user_id::text or split_part(v_path,'/',2)<>p_id::text or split_part(v_path,'/',3)<>p_claim::text or not exists(select 1 from storage.objects where bucket_id='brand-videos' and name=v_path) then raise exception 'INVALID_FINAL_PATH'; end if;
  if (select count(*) from public.brand_scenes where job_id=p_id and status='done' and (speech_audit->>'ok')::boolean)=result.scene_count
     and (select count(distinct output_sha256) from public.brand_scenes where job_id=p_id)=result.scene_count
     and coalesce((p_patch->'final_probe'->'speech_audit'->>'ok')::boolean,false)
     and abs((p_patch->'final_probe'->>'duration')::numeric-result.scene_count*result.scene_seconds)<0.7 then null;
  else raise exception 'FINAL_NOT_VERIFIED'; end if;
 end if;
 update public.brand_jobs set status=next_status,
 plan=case when p_patch ? 'plan' then p_patch->'plan' else plan end,
 analysis=case when p_patch ? 'analysis' then p_patch->'analysis' else analysis end,
 script_outline=case when p_patch ? 'script_outline' then p_patch->>'script_outline' else script_outline end,
 conversation_ref=case when p_patch ? 'conversation_ref' then p_patch->'conversation_ref' else conversation_ref end,
 final_path=case when p_patch ? 'final_path' then p_patch->>'final_path' else final_path end,
 final_probe=case when p_patch ? 'final_probe' then p_patch->'final_probe' else final_probe end,
 error=case when p_patch ? 'error' then p_patch->>'error' else error end,
 error_code=case when p_patch ? 'error_code' then p_patch->>'error_code' else error_code end,
 retryable=case when p_patch ? 'retryable' then (p_patch->>'retryable')::boolean else retryable end,
 current_scene=(select count(*) from public.brand_scenes where job_id=p_id and status='done'),
 updated_at=now() where id=p_id returning * into result;
 if p_patch ? 'status' then insert into public.brand_job_events(job_id,attempt,status,error_code,message) values(p_id,result.attempt,next_status,result.error_code,result.error); end if;
 return result;
end $$;

create function public.update_brand_scene_v2(p_id uuid,p_scene integer,p_worker uuid,p_token uuid,p_claim uuid,p_patch jsonb) returns public.brand_scenes language plpgsql security definer set search_path='' as $$
declare job public.brand_jobs%rowtype; result public.brand_scenes%rowtype; v_path text;
begin
 perform private.assert_muse_lease(p_worker,p_token);
 select * into job from public.brand_jobs where id=p_id and worker_id=p_worker and claim_token=p_claim and lease_expires_at>now() and status='generating' for update;
 if not found then raise exception 'JOB_LEASE_LOST'; end if;
 select * into result from public.brand_scenes where job_id=p_id and scene_index=p_scene for update;
 if not found then raise exception 'SCENE_NOT_FOUND'; end if;
 if result.status='done' then return result; end if;
 if p_patch->>'status'='done' then
  v_path=p_patch->>'output_path';
  if split_part(v_path,'/',1)<>job.user_id::text or split_part(v_path,'/',2)<>p_id::text or split_part(v_path,'/',3)<>p_claim::text or v_path is null or not exists(select 1 from storage.objects where bucket_id='brand-videos' and name=v_path) then raise exception 'INVALID_SCENE_PATH'; end if;
  if coalesce(abs((p_patch->>'duration')::numeric-job.scene_seconds),1000)>.4 or not coalesce((p_patch->'speech_audit'->>'ok')::boolean,false) or coalesce(p_patch->>'output_sha256','')!~'^[0-9a-f]{64}$' then raise exception 'SCENE_NOT_VERIFIED'; end if;
  if exists(select 1 from public.brand_scenes where job_id=p_id and scene_index<>p_scene and output_sha256=p_patch->>'output_sha256') then raise exception 'DUPLICATE_SCENE'; end if;
 end if;
 update public.brand_scenes set status=coalesce(p_patch->>'status',status),
 generation=coalesce((p_patch->>'generation')::integer,generation),
 error_code=case when p_patch ? 'error_code' then p_patch->>'error_code' else error_code end,
 submission_state=coalesce(p_patch->>'submission_state',submission_state),
 request_receipt=case when p_patch ? 'request_receipt' then p_patch->'request_receipt' else request_receipt end,
 output_path=case when p_patch ? 'output_path' then p_patch->>'output_path' else output_path end,
 duration=case when p_patch ? 'duration' then (p_patch->>'duration')::numeric else duration end,
 output_sha256=coalesce(p_patch->>'output_sha256',output_sha256),
 speech_audit=case when p_patch ? 'speech_audit' then p_patch->'speech_audit' else speech_audit end,
 error=case when p_patch ? 'error' then p_patch->>'error' else error end,
 updated_at=now() where job_id=p_id and scene_index=p_scene returning * into result;
 update public.brand_jobs set current_scene=(select count(*) from public.brand_scenes where job_id=p_id and status='done'),updated_at=now() where id=p_id;
 return result;
end $$;

-- Old binaries may not claim jobs after v2 is installed.
create or replace function public.claim_next_brand_job() returns public.brand_jobs language plpgsql security definer set search_path='' as $$
begin
 if not public.is_admin() then raise exception 'Chỉ quản trị viên'; end if;
 raise exception 'Cần nâng cấp worker lên phiên bản 2';
end $$;
create or replace function public.recover_orphaned_brand_jobs() returns integer language plpgsql security definer set search_path='' as $$
begin
 if not public.is_admin() then raise exception 'Chỉ quản trị viên'; end if;
 return 0;
end $$;
create or replace function public.submit_brand_job(p_id uuid,p_content text,p_scene_count integer,p_reference_path text) returns public.brand_jobs language plpgsql security definer set search_path='' as $$
begin raise exception 'Vui lòng tải lại trang để dùng quy trình mới'; end $$;

revoke all on function public.acquire_muse_worker(uuid),public.renew_muse_worker(uuid,uuid),public.release_muse_worker(uuid,uuid),public.claim_brand_job_v2(uuid,uuid),public.update_brand_job_v2(uuid,uuid,uuid,uuid,jsonb),public.update_brand_scene_v2(uuid,integer,uuid,uuid,uuid,jsonb) from public,anon;
grant execute on function public.acquire_muse_worker(uuid),public.renew_muse_worker(uuid,uuid),public.release_muse_worker(uuid,uuid),public.claim_brand_job_v2(uuid,uuid),public.update_brand_job_v2(uuid,uuid,uuid,uuid,jsonb),public.update_brand_scene_v2(uuid,integer,uuid,uuid,uuid,jsonb) to authenticated;
