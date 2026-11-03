-- Independent of the worker process: expired jobs must not remain Processing
-- when a crashed or blocked worker cannot run its own cleanup loop.
create extension if not exists pg_cron;

create function private.expire_stalled_muse_jobs() returns integer
language plpgsql set search_path='' as $$
declare changed integer;
begin
 perform pg_catalog.pg_advisory_xact_lock(735105402);
 with expired as (
  update public.brand_jobs set status='error',error_code='WORKER_INTERRUPTED',
   error='Worker đã ngừng phản hồi. Các cảnh và biên nhận đã gửi được giữ nguyên để thử lại an toàn.',
   retryable=retryable and attempt<max_attempts,updated_at=now()
  where schema_version=2 and status in ('planning','generating','joining')
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

create or replace function public.claim_brand_job_v2(p_worker uuid,p_token uuid)
returns public.brand_jobs language plpgsql security definer set search_path='' as $$
declare result public.brand_jobs%rowtype;
begin
 perform pg_catalog.pg_advisory_xact_lock(735105402);
 perform private.assert_muse_lease(p_worker,p_token);
 perform private.expire_stalled_muse_jobs();
 if exists(select 1 from public.brand_jobs where schema_version=2 and status in ('planning','generating','joining')) then return null; end if;
 select * into result from public.brand_jobs where schema_version=2 and status='queued' order by created_at,id for update skip locked limit 1;
 if not found then return null; end if;
 update public.brand_jobs set status='planning',worker_id=p_worker,claim_token=extensions.gen_random_uuid(),lease_expires_at=now()+interval '90 seconds',attempt=attempt+1,error=null,error_code=null,updated_at=now() where id=result.id returning * into result;
 insert into public.brand_job_events(job_id,attempt,status) values(result.id,result.attempt,'planning');return result;
end $$;
