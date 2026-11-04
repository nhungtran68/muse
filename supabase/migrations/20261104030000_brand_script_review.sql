-- Two explicit phases for new brand jobs. Existing schema_version=2 jobs and
-- their worker RPCs remain valid until the installed worker is upgraded.
alter table public.brand_jobs
 add column allow_summarize boolean not null default false,
 add column script_revision integer not null default 0 check(script_revision>=0),
 add column workflow_phase text not null default 'video' check(workflow_phase in ('script','video')),
 add column video_prompt_version text;

alter table public.brand_jobs drop constraint brand_jobs_status_check;
alter table public.brand_jobs add constraint brand_jobs_status_check check(status in
 ('uploading','queued','script_queued','planning','script_ready','video_queued',
  'generating','joining','done','error','needs_review','reviewed'));
drop index public.brand_jobs_live_fingerprint;
create index brand_jobs_live_fingerprint on public.brand_jobs(user_id,input_hash)
 where status in ('uploading','queued','script_queued','planning','script_ready','video_queued','generating','joining');
create index brand_jobs_script_queue on public.brand_jobs(created_at,id) where status in ('script_queued','video_queued');

create function public.submit_brand_job_v3(p_id uuid,p_request_key uuid,p_content text,
 p_scene_count integer,p_reference_sha256 text,p_allow_summarize boolean default false)
returns public.brand_jobs language plpgsql security definer set search_path='' as $$
declare result public.brand_jobs%rowtype; settings public.app_settings%rowtype; fingerprint text;
begin
 if auth.uid() is null then raise exception 'Cần đăng nhập'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text,17));
 if not exists(select 1 from public.profiles where id=auth.uid() and approved) then raise exception 'Tài khoản chưa được duyệt'; end if;
 if p_id is null or p_request_key is null or p_content is null or char_length(trim(p_content)) not between 10 and 4000
    or p_reference_sha256 is null or p_reference_sha256 !~ '^[0-9a-f]{64}$' or p_allow_summarize is null then raise exception 'Thông tin yêu cầu không hợp lệ'; end if;
 fingerprint=encode(extensions.digest(convert_to('v3|'||trim(p_content)||'|'||p_scene_count::text||'|10|'||p_reference_sha256||'|'||p_allow_summarize::text,'UTF8'),'sha256'),'hex');
 select * into result from public.brand_jobs where user_id=auth.uid() and request_key=p_request_key;
 if found then
  if result.schema_version<>3 or result.input_hash<>fingerprint then raise exception 'Mã gửi đã được dùng cho nội dung khác'; end if;
  return result;
 end if;
 select * into result from public.brand_jobs where user_id=auth.uid() and schema_version=3 and input_hash=fingerprint
  and status in ('uploading','script_queued','planning','script_ready','video_queued','generating','joining') order by created_at limit 1;
 if found then return result; end if;
 select * into settings from public.app_settings where id=true;
 if not settings.enabled then raise exception 'Đang tạm dừng nhận yêu cầu'; end if;
 if p_scene_count is null or p_scene_count not between 1 and settings.max_scenes then raise exception 'Số đoạn không hợp lệ'; end if;
 if not exists(select 1 from public.video_modes where seconds=10 and enabled) then raise exception 'Đoạn 10 giây chưa được xác nhận hỗ trợ'; end if;
 if (select count(*) from public.brand_jobs where user_id=auth.uid() and created_at>=date_trunc('day',now() at time zone 'Asia/Ho_Chi_Minh') at time zone 'Asia/Ho_Chi_Minh')>=settings.daily_limit then raise exception 'Đã hết lượt trong ngày'; end if;
 insert into public.brand_jobs(id,user_id,content,scene_count,scene_seconds,reference_path,
   schema_version,request_key,input_hash,reference_sha256,allow_summarize,workflow_phase)
 values(p_id,auth.uid(),trim(p_content),p_scene_count,10,auth.uid()::text||'/'||p_id::text||'/reference',
   3,p_request_key,fingerprint,p_reference_sha256,p_allow_summarize,'script') returning * into result;
 return result;
end $$;
revoke all on function public.submit_brand_job_v3(uuid,uuid,text,integer,text,boolean) from public,anon;
grant execute on function public.submit_brand_job_v3(uuid,uuid,text,integer,text,boolean) to authenticated;

create or replace function public.queue_brand_job(p_id uuid) returns public.brand_jobs
language plpgsql security definer set search_path='' as $$
declare result public.brand_jobs%rowtype;
begin
 select * into result from public.brand_jobs where id=p_id and user_id=auth.uid() for update;
 if not found then raise exception 'Không tìm thấy yêu cầu'; end if;
 if result.status<>'uploading' then return result; end if;
 if not exists(select 1 from public.profiles where id=auth.uid() and approved) then raise exception 'Tài khoản chưa được duyệt'; end if;
 if not exists(select 1 from storage.objects where bucket_id='brand-references' and name=result.reference_path) then raise exception 'Chưa tải xong ảnh tham chiếu'; end if;
 update public.brand_jobs set status=case when schema_version=3 then 'script_queued' else 'queued' end,updated_at=now()
  where id=p_id returning * into result;
 insert into public.brand_job_events(job_id,attempt,status) values(p_id,0,result.status);
 return result;
end $$;

-- The existing scheduled recovery must also cover jobs in the review workflow.
create or replace function private.expire_stalled_muse_jobs() returns integer
language plpgsql set search_path='' as $$
declare changed integer;
begin
 perform pg_catalog.pg_advisory_xact_lock(735105402);
 with expired as (
  update public.brand_jobs set status='error',error_code='WORKER_INTERRUPTED',
   error='Worker đã ngừng phản hồi. Có thể thử lại mà không gửi trùng các đoạn đã tạo.',
   retryable=retryable and attempt<max_attempts,updated_at=now()
  where schema_version in (2,3) and status in ('planning','generating','joining')
   and lease_expires_at is not null and lease_expires_at<=now()
  returning id,attempt,error_code,error
 ), scenes_updated as (
  update public.brand_scenes s set status='error',error_code=e.error_code,error=e.error,updated_at=now()
  from expired e where s.job_id=e.id and s.status='generating' returning s.job_id
 ), logged as (
  insert into public.brand_job_events(job_id,attempt,status,error_code,message)
  select id,attempt,'error',error_code,error from expired returning id
 ) select count(*) into changed from logged;
 return changed;
end $$;
revoke all on function private.expire_stalled_muse_jobs() from public,anon,authenticated;

create function public.claim_brand_job_v3(p_worker uuid,p_token uuid) returns public.brand_jobs
language plpgsql security definer set search_path='' as $$
declare result public.brand_jobs%rowtype;
begin
 perform pg_catalog.pg_advisory_xact_lock(735105402);
 perform private.assert_muse_lease(p_worker,p_token);
 perform private.expire_stalled_muse_jobs();
 if exists(select 1 from public.brand_jobs where schema_version in (2,3) and status in ('planning','generating','joining')) then return null; end if;
 select * into result from public.brand_jobs where schema_version=3 and status in ('script_queued','video_queued')
  order by created_at,id for update skip locked limit 1;
 if not found then return null; end if;
 update public.brand_jobs set status=case when status='script_queued' then 'planning' else 'generating' end,
  worker_id=p_worker,claim_token=extensions.gen_random_uuid(),lease_expires_at=now()+interval '90 seconds',
  attempt=attempt+1,error=null,error_code=null,updated_at=now() where id=result.id returning * into result;
 insert into public.brand_job_events(job_id,attempt,status) values(result.id,result.attempt,result.status);
 return result;
end $$;
revoke all on function public.claim_brand_job_v3(uuid,uuid) from public,anon;
grant execute on function public.claim_brand_job_v3(uuid,uuid) to authenticated;

create function public.complete_brand_script_v3(p_id uuid,p_worker uuid,p_token uuid,p_claim uuid,
 p_plan jsonb,p_analysis jsonb,p_outline text) returns public.brand_jobs
language plpgsql security definer set search_path='' as $$
declare result public.brand_jobs%rowtype;
begin
 perform private.assert_muse_lease(p_worker,p_token);
 select * into result from public.brand_jobs where id=p_id and schema_version=3 and workflow_phase='script'
  and status='planning' and worker_id=p_worker and claim_token=p_claim and lease_expires_at>now() for update;
 if not found then raise exception 'JOB_LEASE_LOST'; end if;
 if p_plan is null or jsonb_typeof(p_plan)<>'array' or jsonb_array_length(p_plan)<>result.scene_count
    or exists(select 1 from jsonb_array_elements(p_plan) with ordinality as x(v,n)
      where (v->>'index')::integer<>n or (v->>'seconds')::integer<>10
        or char_length(trim(coalesce(v->>'dialogue','')))=0) then raise exception 'INVALID_SCRIPT'; end if;
 update public.brand_jobs set status='script_ready',plan=p_plan,analysis=coalesce(p_analysis,'{}'::jsonb),
  script_outline=p_outline,script_revision=script_revision+1,worker_id=null,claim_token=null,
  lease_expires_at=null,error=null,error_code=null,updated_at=now() where id=p_id returning * into result;
 insert into public.brand_job_events(job_id,attempt,status,message) values(p_id,result.attempt,'script_ready','Kịch bản sẵn sàng để khách chỉnh sửa');
 return result;
end $$;
revoke all on function public.complete_brand_script_v3(uuid,uuid,uuid,uuid,jsonb,jsonb,text) from public,anon;
grant execute on function public.complete_brand_script_v3(uuid,uuid,uuid,uuid,jsonb,jsonb,text) to authenticated;

create function public.commit_brand_script_v3(p_id uuid,p_revision integer,p_scene_count integer,
 p_dialogues jsonb,p_submit boolean default false) returns public.brand_jobs
language plpgsql security definer set search_path='' as $$
declare result public.brand_jobs%rowtype; next_plan jsonb; same_lines boolean; line record;
begin
 if auth.uid() is null then raise exception 'Cần đăng nhập'; end if;
 select * into result from public.brand_jobs where id=p_id and user_id=auth.uid() and schema_version=3 for update;
 if not found then raise exception 'Không tìm thấy kịch bản'; end if;
 if not exists(select 1 from public.profiles where id=auth.uid() and approved) then raise exception 'Tài khoản chưa được duyệt'; end if;
 if p_submit is null or p_revision is null or p_scene_count is null or p_scene_count<>result.scene_count or result.scene_seconds<>10
    or p_dialogues is null or jsonb_typeof(p_dialogues)<>'array'
    or jsonb_array_length(p_dialogues)<>result.scene_count
    or jsonb_array_length(result.plan)<>result.scene_count then raise exception 'Số đoạn đã thay đổi; hãy cập nhật kịch bản trước'; end if;
 if exists(select 1 from jsonb_array_elements(p_dialogues) v where jsonb_typeof(v)<>'string') then raise exception 'Lời thoại phải là văn bản'; end if;
 for line in select value from jsonb_array_elements_text(p_dialogues) loop
  if char_length(trim(line.value))=0 or char_length(line.value)>600 or line.value ~ '\{\{|\}\}|…' then
   raise exception 'Có đoạn lời thoại trống, quá dài hoặc còn biến chưa thay';
  end if;
 end loop;
 select jsonb_agg(case when parts.value->>'dialogue'=lines.value then parts.value
   else jsonb_set(parts.value-'speech','{dialogue}',to_jsonb(lines.value),false) end order by parts.n)
 into next_plan from jsonb_array_elements(result.plan) with ordinality as parts(value,n)
 join jsonb_array_elements_text(p_dialogues) with ordinality as lines(value,n) using(n);
 same_lines=next_plan=result.plan;
 if result.status in ('video_queued','generating','joining','done') and p_submit and same_lines then return result; end if;
 if result.status<>'script_ready' or result.workflow_phase<>'script' then raise exception 'Kịch bản không còn ở bước chỉnh sửa'; end if;
 if p_revision<>result.script_revision then
  if not p_submit and same_lines then return result; end if;
  raise exception 'Kịch bản đã được cập nhật ở nơi khác; hãy tải lại trước khi tiếp tục';
 end if;
 if not p_submit and same_lines then return result; end if;
 if p_submit then
  if not exists(select 1 from storage.objects where bucket_id='brand-references' and name=result.reference_path) then raise exception 'Thiếu ảnh tham chiếu'; end if;
  if not exists(select 1 from public.video_modes where seconds=10 and enabled) then raise exception 'Đoạn 10 giây chưa được xác nhận hỗ trợ'; end if;
  update public.brand_jobs set plan=next_plan,script_revision=script_revision+1,
   status='video_queued',workflow_phase='video',video_prompt_version='brand-video-10s-v1',
   attempt=0,error=null,error_code=null,updated_at=now() where id=p_id returning * into result;
  insert into public.brand_scenes(job_id,scene_index,prompt,dialogue,planned_seconds,action,source_quotes,speech_estimate)
   select p_id,(v->>'index')::integer,coalesce(v->>'prompt','Cùng nhân vật và bối cảnh'),v->>'dialogue',10,
    coalesce(v->>'action',''),coalesce(v->'source_quotes','[]'),v->'speech'
   from jsonb_array_elements(next_plan) v;
  insert into public.brand_job_events(job_id,attempt,status,message) values(p_id,0,'video_queued','Khách đã duyệt lời thoại');
 else
  update public.brand_jobs set plan=next_plan,script_revision=script_revision+1,updated_at=now() where id=p_id returning * into result;
 end if;
 return result;
end $$;
revoke all on function public.commit_brand_script_v3(uuid,integer,integer,jsonb,boolean) from public,anon;
grant execute on function public.commit_brand_script_v3(uuid,integer,integer,jsonb,boolean) to authenticated;

create function public.replan_brand_script_v3(p_id uuid,p_revision integer,p_scene_count integer)
returns public.brand_jobs language plpgsql security definer set search_path='' as $$
declare result public.brand_jobs%rowtype; settings public.app_settings%rowtype;
begin
 if auth.uid() is null then raise exception 'Cần đăng nhập'; end if;
 select * into result from public.brand_jobs where id=p_id and user_id=auth.uid() and schema_version=3 for update;
 if not found or result.status<>'script_ready' or result.workflow_phase<>'script' then raise exception 'Kịch bản không còn ở bước chỉnh sửa'; end if;
 if p_revision is null or p_revision<>result.script_revision then raise exception 'Kịch bản đã thay đổi; hãy tải lại trước khi tiếp tục'; end if;
 select * into settings from public.app_settings where id=true;
 if not settings.enabled then raise exception 'Đang tạm dừng nhận yêu cầu'; end if;
 if not exists(select 1 from public.profiles where id=auth.uid() and approved) then raise exception 'Tài khoản chưa được duyệt'; end if;
 if p_scene_count is null or p_scene_count not between 1 and settings.max_scenes then raise exception 'Số đoạn không hợp lệ'; end if;
 if p_scene_count=result.scene_count then return result; end if;
 if exists(select 1 from public.brand_scenes where job_id=p_id) then raise exception 'Yêu cầu này đã bắt đầu tạo video'; end if;
 update public.brand_jobs set scene_count=p_scene_count,
  input_hash=encode(extensions.digest(convert_to('v3|'||result.content||'|'||p_scene_count::text||'|10|'||result.reference_sha256||'|'||result.allow_summarize::text,'UTF8'),'sha256'),'hex'),
  plan='[]'::jsonb,analysis='{}'::jsonb,
  script_outline=null,conversation_ref=null,script_revision=script_revision+1,
  attempt=0,status='script_queued',error=null,error_code=null,updated_at=now()
  where id=p_id returning * into result;
 insert into public.brand_job_events(job_id,attempt,status,message) values(p_id,0,'script_queued','Khách đổi số đoạn và yêu cầu viết lại kịch bản');
 return result;
end $$;
revoke all on function public.replan_brand_script_v3(uuid,integer,integer) from public,anon;
grant execute on function public.replan_brand_script_v3(uuid,integer,integer) to authenticated;

create or replace function public.retry_brand_job(p_id uuid) returns public.brand_jobs
language plpgsql security definer set search_path='' as $$
declare result public.brand_jobs%rowtype; next_status text;
begin
 select * into result from public.brand_jobs where id=p_id and (user_id=auth.uid() or public.is_admin()) for update;
 if not found then raise exception 'Không tìm thấy yêu cầu'; end if;
 if result.status in ('queued','script_queued','video_queued') then return result; end if;
 if result.schema_version not in (2,3) or result.status<>'error' or not result.retryable then raise exception 'Yêu cầu cần quản trị viên kiểm tra trước khi thử lại'; end if;
 if result.attempt>=result.max_attempts then raise exception 'Đã hết số lần thử lại'; end if;
 if not exists(select 1 from public.profiles where id=auth.uid() and approved) then raise exception 'Tài khoản chưa được duyệt'; end if;
 next_status=case when result.schema_version=2 then 'queued' when result.workflow_phase='script' then 'script_queued' else 'video_queued' end;
 update public.brand_jobs set status=next_status,error=null,error_code=null,updated_at=now(),
  worker_id=null,claim_token=null,lease_expires_at=null where id=p_id returning * into result;
 insert into public.brand_job_events(job_id,attempt,status,message) values(p_id,result.attempt,result.status,'Thử lại đúng bước đang lỗi');
 return result;
end $$;
