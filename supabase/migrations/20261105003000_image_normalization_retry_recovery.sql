-- A claimed job always has a lease. Treat an active row with a missing lease
-- as an orphan so it cannot block the shared Muse queue forever.
create or replace function private.expire_stalled_muse_jobs() returns integer
language plpgsql set search_path='' as $$
declare changed integer;
begin
 perform pg_catalog.pg_advisory_xact_lock(735105402);
 with expired as (
  update public.brand_jobs set status='error',error_code='WORKER_INTERRUPTED',
   error='Worker đã ngừng phản hồi. Các đoạn và biên nhận đã gửi được giữ nguyên để tiếp tục an toàn.',
   retryable=true,worker_id=null,claim_token=null,lease_expires_at=null,updated_at=now()
  where schema_version in (2,3) and status in ('planning','generating','joining')
   and (lease_expires_at is null or lease_expires_at<=now())
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

-- Earlier worker releases exhausted whole-job attempts even when a saved
-- Muse receipt made timeout recovery safe. Restore retry for those failed jobs.
update public.brand_jobs set retryable=true,updated_at=now()
where schema_version in (2,3) and status='error'
 and error_code in ('MUSE_TIMEOUT','WORKER_INTERRUPTED');

-- Retrying the same failed job is idempotent: queued requests are returned as
-- is, while failed requests resume their saved plan, receipts and completed clips.
create or replace function public.retry_brand_job(p_id uuid) returns public.brand_jobs
language plpgsql security definer set search_path='' as $$
declare result public.brand_jobs%rowtype; next_status text;
begin
 select * into result from public.brand_jobs where id=p_id and (user_id=auth.uid() or public.is_admin()) for update;
 if not found then raise exception 'Không tìm thấy yêu cầu'; end if;
 if result.status in ('queued','script_queued','video_queued') then return result; end if;
 if result.schema_version not in (2,3) or result.status<>'error' or not result.retryable then
  raise exception 'Tác vụ lỗi này chưa thể tự thử lại an toàn; cần quản trị viên kiểm tra';
 end if;
 if not exists(select 1 from public.profiles where id=auth.uid() and approved) then raise exception 'Tài khoản chưa được duyệt'; end if;
 next_status=case when result.schema_version=2 then 'queued' when result.workflow_phase='script' then 'script_queued' else 'video_queued' end;
 update public.brand_jobs set status=next_status,attempt=0,error=null,error_code=null,
  worker_id=null,claim_token=null,lease_expires_at=null,updated_at=now()
  where id=p_id returning * into result;
 insert into public.brand_job_events(job_id,attempt,status,message)
  values(p_id,0,result.status,'Tiếp tục tác vụ đã lỗi; giữ nguyên kịch bản, biên nhận và các đoạn đã hoàn thành');
 return result;
end $$;
revoke all on function public.retry_brand_job(uuid) from public,anon;
grant execute on function public.retry_brand_job(uuid) to authenticated;
