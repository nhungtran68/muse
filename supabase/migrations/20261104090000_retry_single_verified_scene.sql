-- A manual retry starts a fresh three-generation wave for exactly one scene.
-- Only a received invalid clip or an explicit Muse refusal is safe to resend.
-- Unknown submissions keep their receipt and use retry_brand_job for polling.
create function public.retry_brand_scene_v3(p_id uuid,p_scene integer)
returns public.brand_jobs language plpgsql security definer set search_path='' as $$
declare job public.brand_jobs%rowtype; scene public.brand_scenes%rowtype;
begin
 select * into job from public.brand_jobs where id=p_id and
  (user_id=(select auth.uid()) or (select public.is_admin())) for update;
 if not found then raise exception 'Không tìm thấy yêu cầu'; end if;
 if job.schema_version<>3 or job.workflow_phase<>'video' or job.status<>'error' then
  raise exception 'Chỉ có thể tạo lại đoạn của video đang lỗi'; end if;
 if not exists(select 1 from public.profiles where id=(select auth.uid()) and approved) then
  raise exception 'Tài khoản chưa được duyệt'; end if;
 select * into scene from public.brand_scenes where job_id=p_id and scene_index=p_scene for update;
 if not found or scene.status<>'error' or scene.error_code not in
  ('MUSE_OUTPUT_REJECTED','SCENE_MEDIA_INVALID','CUT_OFF_SPEECH',
   'SPEECH_TOO_SHORT','SPEECH_TIMING','SPEECH_MISMATCH','UNEXPECTED_SPEECH') then
  raise exception 'Đoạn này chưa xác nhận thất bại; không gửi tác vụ trùng'; end if;
 if exists(select 1 from public.brand_scenes where job_id=p_id and scene_index<p_scene and status<>'done') then
  raise exception 'Cần hoàn tất các đoạn trước trước khi thử lại'; end if;
 update public.brand_scenes set status='waiting',generation=3*(scene.generation/3+1),
  submission_state='not_sent',request_receipt=null,output_path=null,duration=null,
  output_sha256=null,speech_audit=null,error=null,error_code=null,updated_at=now()
  where job_id=p_id and scene_index=p_scene;
 update public.brand_jobs set status='video_queued',attempt=0,retryable=true,
  error=null,error_code=null,worker_id=null,claim_token=null,lease_expires_at=null,
  updated_at=now() where id=p_id returning * into job;
 insert into public.brand_job_events(job_id,attempt,status,message)
  values(p_id,0,'video_queued','Tạo lại riêng đoạn '||p_scene::text||'; giữ nguyên các đoạn đã hoàn thành');
 return job;
end $$;
revoke all on function public.retry_brand_scene_v3(uuid,integer) from public,anon;
grant execute on function public.retry_brand_scene_v3(uuid,integer) to authenticated;
