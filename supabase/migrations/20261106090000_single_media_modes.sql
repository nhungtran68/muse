-- Add two direct-output modes without changing existing 10-second or brand jobs.
alter table public.brand_jobs add column creation_mode text not null default 'legacy'
  check(creation_mode in ('legacy','video_10s','video_free','image'));
alter table public.brand_jobs alter column scene_seconds drop not null;
alter table public.brand_jobs add constraint brand_jobs_creation_duration_check check(
  (creation_mode='legacy' and scene_seconds is not null)
  or (creation_mode='video_10s' and scene_seconds is not null and scene_seconds=10 and scene_count=1 and schema_version=2)
  or (creation_mode in ('video_free','image') and scene_seconds is null and scene_count=1 and schema_version=2)
);
-- Keep the same private bucket, ownership policies, and server-side 60-minute cleanup.
update storage.buckets set allowed_mime_types=array['video/mp4','image/png','image/jpeg','image/webp']
where id='brand-videos';

create function public.submit_single_media_job(
  p_id uuid,p_request_key uuid,p_content text,p_mode text,p_reference_sha256 text default null
) returns public.brand_jobs language plpgsql security definer set search_path='' as $$
declare result public.brand_jobs%rowtype; settings public.app_settings%rowtype;
  fingerprint text; action text; reference_path text; single_plan jsonb;
begin
  if auth.uid() is null then raise exception 'Cần đăng nhập'; end if;
  if p_mode is null or p_mode not in ('video_10s','video_free','image') then raise exception 'Chế độ tạo không hợp lệ'; end if;
  if p_mode='video_10s' then
    result=public.submit_single_video_job(p_id,p_request_key,p_content,10,p_reference_sha256);
    if result.creation_mode='legacy' then
      update public.brand_jobs set creation_mode='video_10s' where id=result.id returning * into result;
    end if;
    return result;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text,17));
  if not exists(select 1 from public.profiles where id=auth.uid() and approved) then raise exception 'Tài khoản chưa được duyệt'; end if;
  if p_id is null or p_request_key is null or p_content is null or char_length(trim(p_content)) not between 10 and 4000
    or (p_reference_sha256 is not null and p_reference_sha256 !~ '^[0-9a-f]{64}$') then
    raise exception 'Thông tin yêu cầu không hợp lệ';
  end if;
  fingerprint=encode(extensions.digest(convert_to('single-media-v1|'||p_mode||'|'||trim(p_content)||'|'||coalesce(p_reference_sha256,''),'UTF8'),'sha256'),'hex');
  select * into result from public.brand_jobs where user_id=auth.uid() and request_key=p_request_key;
  if found then
    if result.input_hash<>fingerprint or result.creation_mode<>p_mode then raise exception 'Mã gửi đã được dùng cho nội dung khác'; end if;
    return result;
  end if;
  select * into result from public.brand_jobs where user_id=auth.uid() and input_hash=fingerprint
    and creation_mode=p_mode and status in ('uploading','queued','planning','generating','joining') order by created_at limit 1;
  if found then return result; end if;
  select * into settings from public.app_settings where id=true;
  if not settings.enabled then raise exception 'Đang tạm dừng nhận yêu cầu'; end if;
  if (select count(*) from public.brand_jobs where user_id=auth.uid()
    and created_at>=date_trunc('day',now() at time zone 'Asia/Ho_Chi_Minh') at time zone 'Asia/Ho_Chi_Minh')>=settings.daily_limit then
    raise exception 'Đã hết lượt trong ngày';
  end if;
  action=case when p_mode='image' then 'single_image_request' else 'single_free_video_request' end;
  reference_path=case when p_reference_sha256 is not null then auth.uid()::text||'/'||p_id::text||'/reference' end;
  single_plan=jsonb_build_array(jsonb_build_object('index',1,'seconds',null,'prompt',trim(p_content),'dialogue','','action',action,'source_quotes','[]'::jsonb));
  insert into public.brand_jobs(id,user_id,content,scene_count,scene_seconds,reference_path,schema_version,request_key,input_hash,reference_sha256,plan,workflow_phase,creation_mode,status)
    values(p_id,auth.uid(),trim(p_content),1,null,reference_path,2,p_request_key,fingerprint,p_reference_sha256,single_plan,'video',p_mode,case when reference_path is null then 'queued' else 'uploading' end)
    returning * into result;
  insert into public.brand_scenes(job_id,scene_index,prompt,dialogue,planned_seconds,action,source_quotes)
    values(p_id,1,trim(p_content),'',null,action,'[]'::jsonb);
  insert into public.brand_job_events(job_id,attempt,status,message) values(p_id,0,result.status,'Một yêu cầu Muse · '||p_mode);
  return result;
end $$;
revoke all on function public.submit_single_media_job(uuid,uuid,text,text,text) from public,anon;
grant execute on function public.submit_single_media_job(uuid,uuid,text,text,text) to authenticated;

create function public.complete_single_media_job(
  p_id uuid,p_worker uuid,p_token uuid,p_claim uuid,p_path text,p_sha256 text,p_probe jsonb
) returns public.brand_jobs language plpgsql security definer set search_path='' as $$
declare job public.brand_jobs%rowtype; scene public.brand_scenes%rowtype; expected_kind text; content_type text;
begin
  perform private.assert_muse_lease(p_worker,p_token);
  select * into job from public.brand_jobs where id=p_id and worker_id=p_worker and claim_token=p_claim and lease_expires_at>now() for update;
  if not found then raise exception 'JOB_LEASE_LOST'; end if;
  if job.status='done' and job.final_path=p_path then return job; end if;
  if job.creation_mode not in ('video_free','image') or job.schema_version<>2 or job.scene_count<>1 or job.status not in ('generating','joining') then raise exception 'INVALID_MEDIA_JOB'; end if;
  select * into scene from public.brand_scenes where job_id=p_id and scene_index=1 for update;
  if not found or scene.action<>(case when job.creation_mode='image' then 'single_image_request' else 'single_free_video_request' end) then raise exception 'INVALID_MEDIA_SCENE'; end if;
  if p_path is null or split_part(p_path,'/',1)<>job.user_id::text or split_part(p_path,'/',2)<>p_id::text
    or split_part(p_path,'/',3)<>p_claim::text or array_length(string_to_array(p_path,'/'),1)<>4 then raise exception 'INVALID_FINAL_PATH'; end if;
  select metadata->>'mimetype' into content_type from storage.objects where bucket_id='brand-videos' and name=p_path;
  expected_kind=case when job.creation_mode='image' then 'image' else 'video' end;
  if not found or coalesce(p_probe->>'kind','')<>expected_kind or coalesce(p_sha256,'')!~'^[0-9a-f]{64}$'
    or coalesce((p_probe->>'width')::numeric,0)<=0 or coalesce((p_probe->>'height')::numeric,0)<=0 then raise exception 'MEDIA_NOT_VERIFIED'; end if;
  if expected_kind='video' then
    if coalesce(content_type,'')<>'video/mp4' or split_part(p_path,'/',4)<>'result.mp4' or coalesce((p_probe->>'duration')::numeric,0)<=0 then raise exception 'VIDEO_NOT_VERIFIED'; end if;
  else
    if coalesce(content_type,'') not in ('image/png','image/jpeg','image/webp') or split_part(p_path,'/',4)!~'^result\.(png|jpg|webp)$' then raise exception 'IMAGE_NOT_VERIFIED'; end if;
  end if;
  update public.brand_scenes set status='done',submission_state='downloaded',output_path=p_path,output_sha256=p_sha256,
    duration=case when expected_kind='video' then (p_probe->>'duration')::numeric end,
    speech_audit=jsonb_build_object('ok',true,'verification','not_requested'),error=null,error_code=null,updated_at=now()
    where job_id=p_id and scene_index=1;
  update public.brand_jobs set status='done',final_path=p_path,final_probe=p_probe,current_scene=1,error=null,error_code=null,updated_at=now()
    where id=p_id returning * into job;
  insert into public.brand_job_events(job_id,attempt,status,message) values(p_id,job.attempt,'done','Đã xác minh và lưu một kết quả · '||job.creation_mode);
  return job;
end $$;
revoke all on function public.complete_single_media_job(uuid,uuid,uuid,uuid,text,text,jsonb) from public,anon;
grant execute on function public.complete_single_media_job(uuid,uuid,uuid,uuid,text,text,jsonb) to authenticated;

create function public.retry_single_media_job(p_id uuid) returns public.brand_jobs
language plpgsql security definer set search_path='' as $$
declare job public.brand_jobs%rowtype; scene public.brand_scenes%rowtype;
begin
  select * into job from public.brand_jobs where id=p_id and (user_id=auth.uid() or public.is_admin()) for update;
  if not found then raise exception 'Không tìm thấy yêu cầu'; end if;
  if job.creation_mode in ('legacy','video_10s') then return public.retry_single_video_job(p_id); end if;
  if not exists(select 1 from public.profiles where id=auth.uid() and approved) then raise exception 'Tài khoản chưa được duyệt'; end if;
  if job.status='queued' then return job; end if;
  if job.schema_version<>2 or job.scene_count<>1 or job.status<>'error' or not job.retryable then raise exception 'Yêu cầu này chưa thể gửi lại'; end if;
  if job.attempt>=job.max_attempts then raise exception 'Đã hết lượt gửi lại'; end if;
  select * into scene from public.brand_scenes where job_id=p_id and scene_index=1 for update;
  if not found or scene.request_receipt is not null or scene.submission_state in ('sending','sent') then raise exception 'Muse có thể vẫn đang xử lý. Hãy tiếp tục kiểm tra yêu cầu cũ trước khi gửi lại'; end if;
  update public.brand_scenes set status='waiting',generation=generation+1,error=null,error_code=null,submission_state='not_sent',request_receipt=null,updated_at=now() where job_id=p_id and scene_index=1;
  update public.brand_jobs set status='queued',error=null,error_code=null,worker_id=null,claim_token=null,lease_expires_at=null,updated_at=now() where id=p_id returning * into job;
  insert into public.brand_job_events(job_id,attempt,status,message) values(p_id,job.attempt,'queued','Gửi lại đúng yêu cầu · '||job.creation_mode);
  return job;
end $$;
revoke all on function public.retry_single_media_job(uuid) from public,anon;
grant execute on function public.retry_single_media_job(uuid) to authenticated;
notify pgrst,'reload schema';
