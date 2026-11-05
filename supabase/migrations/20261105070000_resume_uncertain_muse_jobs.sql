-- A receipt proves that a Muse request was prepared and may have been sent.
-- Let members resume polling that exact request without resubmitting it.
update public.brand_scenes s
set status='error',
    error_code='SUBMISSION_NOT_FOUND',
    error='Muse chưa hiển thị yêu cầu đã gửi. Có thể tiếp tục kiểm tra; hệ thống giữ biên nhận và không gửi clip mới.',
    updated_at=now()
from public.brand_jobs j
where j.id=s.job_id
  and j.status='error'
  and j.error_code='UNCERTAIN_SUBMISSION'
  and j.error like 'Không tìm thấy yêu cầu cảnh % đã gửi%'
  and s.status='generating'
  and s.submission_state='sending'
  and s.request_receipt is not null
  and s.output_path is null;

update public.brand_jobs j
set error_code='SUBMISSION_NOT_FOUND',
    error='Muse chưa hiển thị yêu cầu đã gửi. Nhấn “Tiếp tục kiểm tra Muse”; hệ thống sẽ dò kết quả cũ và không gửi clip trùng.',
    retryable=true,
    updated_at=now()
where j.status='error'
  and j.error_code='UNCERTAIN_SUBMISSION'
  and j.error like 'Không tìm thấy yêu cầu cảnh % đã gửi%'
  and exists (
    select 1 from public.brand_scenes s
    where s.job_id=j.id and s.status='error'
      and s.error_code='SUBMISSION_NOT_FOUND'
      and s.submission_state='sending'
      and s.request_receipt is not null and s.output_path is null
  );

create or replace function public.resume_uncertain_brand_job(p_id uuid)
returns public.brand_jobs
language plpgsql security definer set search_path='' as $$
declare result public.brand_jobs%rowtype; next_status text;
begin
 select * into result from public.brand_jobs
 where id=p_id and (user_id=auth.uid() or public.is_admin()) for update;
 if not found then raise exception 'Không tìm thấy yêu cầu'; end if;
 if result.status<>'error' or result.schema_version not in (2,3)
    or not (result.error_code='SUBMISSION_NOT_FOUND'
      or (result.error_code='UNCERTAIN_SUBMISSION' and result.error like 'Không tìm thấy yêu cầu cảnh % đã gửi%'))
    or (result.schema_version=3 and result.workflow_phase<>'video') then
  raise exception 'Tác vụ này không có yêu cầu Muse chưa xác nhận';
 end if;
 if not exists(select 1 from public.profiles where id=auth.uid() and approved) then
  raise exception 'Tài khoản chưa được duyệt';
 end if;
 if not exists (
   select 1 from public.brand_scenes s
   where s.job_id=p_id and s.status in ('generating','error')
     and s.submission_state='sending' and s.request_receipt is not null
     and s.output_path is null
 ) then raise exception 'Không còn biên nhận cảnh an toàn để tiếp tục'; end if;

 update public.brand_scenes set status='error',error_code='SUBMISSION_NOT_FOUND',
  error='Đang chờ kiểm tra lại yêu cầu đã gửi trong Muse; không gửi clip mới.',updated_at=now()
 where job_id=p_id and status in ('generating','error')
   and submission_state='sending' and request_receipt is not null and output_path is null;

 next_status=case when result.schema_version=2 then 'queued'
   when result.workflow_phase='script' then 'script_queued' else 'video_queued' end;
 update public.brand_jobs set status=next_status,attempt=0,error=null,error_code=null,
  retryable=true,worker_id=null,claim_token=null,lease_expires_at=null,updated_at=now()
 where id=p_id returning * into result;
 insert into public.brand_job_events(job_id,attempt,status,message)
  values(p_id,0,result.status,'Tiếp tục dò biên nhận Muse đã lưu; không gửi lại yêu cầu khi chưa xác nhận kết quả cũ');
 return result;
end $$;

revoke all on function public.resume_uncertain_brand_job(uuid) from public,anon;
grant execute on function public.resume_uncertain_brand_job(uuid) to authenticated;
