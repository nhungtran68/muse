-- One member action creates one queued job with one prebuilt video request.
-- Existing multi-scene jobs keep their stored plans and worker behavior.
create function public.submit_single_video_job(
  p_id uuid,
  p_request_key uuid,
  p_content text,
  p_seconds integer,
  p_reference_sha256 text
) returns public.brand_jobs
language plpgsql security definer set search_path='' as $$
declare
  result public.brand_jobs%rowtype;
  settings public.app_settings%rowtype;
  fingerprint text;
  single_plan jsonb;
begin
  if auth.uid() is null then raise exception 'Cần đăng nhập'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text,17));
  if not exists(select 1 from public.profiles where id=auth.uid() and approved) then
    raise exception 'Tài khoản chưa được duyệt';
  end if;
  if p_id is null or p_request_key is null or p_content is null
     or char_length(trim(p_content)) not between 10 and 4000
     or p_seconds not in (5,8,10)
     or p_reference_sha256 is null or p_reference_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Thông tin yêu cầu không hợp lệ';
  end if;
  fingerprint=encode(extensions.digest(convert_to(
    'single-video-v1|'||trim(p_content)||'|1|'||p_seconds::text||'|'||p_reference_sha256,'UTF8'),'sha256'),'hex');

  select * into result from public.brand_jobs
    where user_id=auth.uid() and request_key=p_request_key;
  if found then
    if result.schema_version<>2 or result.input_hash<>fingerprint then
      raise exception 'Mã gửi đã được dùng cho nội dung khác';
    end if;
    return result;
  end if;
  select * into result from public.brand_jobs
    where user_id=auth.uid() and schema_version=2 and input_hash=fingerprint
      and status in ('uploading','queued','planning','generating','joining')
    order by created_at limit 1;
  if found then return result; end if;

  select * into settings from public.app_settings where id=true;
  if not settings.enabled then raise exception 'Đang tạm dừng nhận yêu cầu'; end if;
  if not exists(select 1 from public.video_modes where seconds=p_seconds and enabled) then
    raise exception 'Chế độ video đã chọn chưa được bật';
  end if;
  if (select count(*) from public.brand_jobs where user_id=auth.uid()
      and created_at>=date_trunc('day',now() at time zone 'Asia/Ho_Chi_Minh') at time zone 'Asia/Ho_Chi_Minh')>=settings.daily_limit then
    raise exception 'Đã hết lượt trong ngày';
  end if;

  single_plan=jsonb_build_array(jsonb_build_object(
    'index',1,'seconds',p_seconds,'prompt',trim(p_content),'dialogue','','action','single_request','source_quotes','[]'::jsonb
  ));
  insert into public.brand_jobs(
    id,user_id,content,scene_count,scene_seconds,reference_path,schema_version,
    request_key,input_hash,reference_sha256,plan,workflow_phase
  ) values (
    p_id,auth.uid(),trim(p_content),1,p_seconds,auth.uid()::text||'/'||p_id::text||'/reference',2,
    p_request_key,fingerprint,p_reference_sha256,single_plan,'video'
  ) returning * into result;
  insert into public.brand_scenes(job_id,scene_index,prompt,dialogue,planned_seconds,action,source_quotes)
    values(p_id,1,trim(p_content),'',p_seconds,'single_request','[]'::jsonb);
  return result;
end $$;
revoke all on function public.submit_single_video_job(uuid,uuid,text,integer,text) from public,anon;
grant execute on function public.submit_single_video_job(uuid,uuid,text,integer,text) to authenticated;

create function public.retry_single_video_job(p_id uuid) returns public.brand_jobs
language plpgsql security definer set search_path='' as $$
declare result public.brand_jobs%rowtype; scene public.brand_scenes%rowtype;
begin
  select * into result from public.brand_jobs
    where id=p_id and (user_id=auth.uid() or public.is_admin()) for update;
  if not found or result.schema_version<>2 or result.scene_count<>1
     or result.status<>'error' or not result.retryable then
    raise exception 'Yêu cầu này chưa thể gửi lại';
  end if;
  if result.attempt>=result.max_attempts then raise exception 'Đã hết lượt gửi lại'; end if;
  if not exists(select 1 from public.profiles where id=auth.uid() and approved) then
    raise exception 'Tài khoản chưa được duyệt';
  end if;
  if not exists(select 1 from public.brand_scenes s where s.job_id=p_id and s.scene_index=1
      and s.action='single_request') then raise exception 'Đây không phải yêu cầu video đơn'; end if;
  select * into scene from public.brand_scenes where job_id=p_id and scene_index=1 for update;
  if scene.request_receipt is not null or scene.submission_state in ('sending','sent') then
    raise exception 'Muse có thể vẫn đang xử lý yêu cầu cũ. Hãy tiếp tục kiểm tra Muse trước khi gửi lại';
  end if;
  update public.brand_scenes set status='waiting',generation=coalesce(generation,0)+1,
    error=null,error_code=null,submission_state='not_sent',request_receipt=null,updated_at=now()
    where job_id=p_id and scene_index=1 and status='error' and output_path is null;
  update public.brand_jobs set status='queued',error=null,error_code=null,
    worker_id=null,claim_token=null,lease_expires_at=null,updated_at=now()
    where id=p_id returning * into result;
  insert into public.brand_job_events(job_id,attempt,status,message)
    values(p_id,result.attempt,'queued','Thành viên gửi lại một yêu cầu video đơn sau lỗi đã xác nhận');
  return result;
end $$;
revoke all on function public.retry_single_video_job(uuid) from public,anon;
grant execute on function public.retry_single_video_job(uuid) to authenticated;

-- A timeout with a durable Muse receipt is safe to poll again, never to resend.
create or replace function public.resume_uncertain_brand_job(p_id uuid)
returns public.brand_jobs
language plpgsql security definer set search_path='' as $$
declare result public.brand_jobs%rowtype; next_status text;
begin
  select * into result from public.brand_jobs
    where id=p_id and (user_id=auth.uid() or public.is_admin()) for update;
  if not found then raise exception 'Không tìm thấy yêu cầu'; end if;
  if result.status<>'error' or result.schema_version not in (2,3)
     or not (result.error_code in ('SUBMISSION_NOT_FOUND','MUSE_TIMEOUT')
       or (result.error_code='UNCERTAIN_SUBMISSION' and result.error like 'Không tìm thấy yêu cầu cảnh % đã gửi%'))
     or (result.schema_version=3 and result.workflow_phase<>'video') then
    raise exception 'Tác vụ này không có yêu cầu Muse chưa xác nhận';
  end if;
  if not exists(select 1 from public.profiles where id=auth.uid() and approved) then
    raise exception 'Tài khoản chưa được duyệt';
  end if;
  if not exists(select 1 from public.brand_scenes s where s.job_id=p_id
      and s.status in ('generating','error') and s.submission_state in ('sending','sent')
      and s.request_receipt is not null and s.output_path is null) then
    raise exception 'Không còn biên nhận an toàn để tiếp tục';
  end if;
  update public.brand_scenes set status='error',error_code=coalesce(error_code,'MUSE_TIMEOUT'),
    error='Đang chờ kiểm tra lại yêu cầu đã gửi trong Muse; không gửi clip mới.',updated_at=now()
    where job_id=p_id and status in ('generating','error')
      and submission_state in ('sending','sent') and request_receipt is not null and output_path is null;
  next_status=case when result.schema_version=2 then 'queued'
    when result.workflow_phase='script' then 'script_queued' else 'video_queued' end;
  update public.brand_jobs set status=next_status,attempt=0,error=null,error_code=null,
    retryable=true,worker_id=null,claim_token=null,lease_expires_at=null,updated_at=now()
    where id=p_id returning * into result;
  insert into public.brand_job_events(job_id,attempt,status,message)
    values(p_id,0,result.status,'Tiếp tục dò biên nhận Muse đã lưu; không gửi lại yêu cầu khi chưa xác nhận video cũ');
  return result;
end $$;
revoke all on function public.resume_uncertain_brand_job(uuid) from public,anon;
grant execute on function public.resume_uncertain_brand_job(uuid) to authenticated;
