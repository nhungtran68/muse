-- Track direct uploads before issuing a signed URL so abandoned uploads can
-- be removed. Active/queued jobs are never interrupted by this cleanup.
create table private.r2_pending_uploads (
  job_id uuid not null references public.brand_jobs(id) on delete cascade,
  bucket text not null check(bucket in ('brand-references','brand-videos')),
  object_path text not null,
  uploaded_at timestamptz not null default clock_timestamp(),
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  claim_token uuid,
  claimed_at timestamptz,
  previous_status text,
  primary key(job_id,bucket,object_path)
);
revoke all on private.r2_pending_uploads from public,anon,authenticated;

create function public.register_r2_upload(p_id uuid,p_bucket text,p_path text)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.brand_jobs%rowtype;
begin
  select * into j from public.brand_jobs where id=p_id for update;
  if not found or j.retention_status='deleting' or p_path is null
    or p_path not like j.user_id::text||'/'||j.id::text||'/%'
    or p_path ~ '(^|/)\.\.(/|$)' or position(E'\\' in p_path)>0 then return false; end if;
  if p_bucket='brand-references' then
    if j.reference_storage_provider<>'r2' or j.user_id is distinct from auth.uid() or j.status<>'uploading'
      or j.reference_path is distinct from p_path then return false; end if;
  elsif p_bucket='brand-videos' then
    if j.storage_provider<>'r2' or public.can_upload_brand_video(p_path) is not true then return false; end if;
  else return false;
  end if;
  insert into private.r2_pending_uploads(job_id,bucket,object_path)
    values(p_id,p_bucket,p_path)
    on conflict(job_id,bucket,object_path) do update set uploaded_at=clock_timestamp(),attempts=0,
      next_attempt_at=null,claim_token=null,claimed_at=null,previous_status=null;
  return true;
end $$;
revoke all on function public.register_r2_upload(uuid,text,text) from public,anon;
grant execute on function public.register_r2_upload(uuid,text,text) to authenticated;

-- A retry must not start while its old files are being deleted, and cannot
-- silently reuse an expired reference image.
create function private.guard_r2_abandoned_cleanup() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.status is distinct from old.status and new.status in ('queued','script_queued','video_queued','planning','generating','joining')
     and (old.storage_provider='r2' or old.reference_storage_provider='r2') then
    if old.retention_status='deleting' then raise exception 'Ảnh của yêu cầu đang được dọn dẹp, hãy thử lại sau'; end if;
    if old.reference_path is not null and old.reference_expires_at is not null and old.reference_expires_at<=now() then
      raise exception 'Ảnh tham chiếu đã hết hạn. Hãy tạo yêu cầu mới với ảnh của bạn';
    end if;
  end if;
  return new;
end $$;
revoke all on function private.guard_r2_abandoned_cleanup() from public,anon,authenticated;
create trigger guard_r2_abandoned_cleanup before update of status on public.brand_jobs
for each row execute function private.guard_r2_abandoned_cleanup();

create or replace function public.claim_abandoned_r2_uploads(p_limit integer default 20)
returns table(job_id uuid,user_id uuid,bucket text,object_path text,claim_token uuid,attempt integer)
language plpgsql security definer set search_path='' as $$
declare r record; token uuid;
begin
  -- A cleanup process may itself die on its last attempt. Release its job
  -- while keeping the failed upload record available for administration.
  for r in select j.id,q.bucket,q.object_path,q.previous_status from public.brand_jobs j
    join private.r2_pending_uploads q on q.job_id=j.id
    where j.retention_status='deleting' and j.retention_claim_token is null
      and j.retention_claimed_at<now()-interval '15 minutes' and q.attempts>=5
      and q.claimed_at<now()-interval '15 minutes' for update of j skip locked
  loop
    update private.r2_pending_uploads q set claim_token=null,claimed_at=null,next_attempt_at=null
      where q.job_id=r.id and q.bucket=r.bucket and q.object_path=r.object_path;
    update public.brand_jobs set retention_status=coalesce(r.previous_status,'active'),retention_claimed_at=null where id=r.id;
    insert into public.brand_job_events(job_id,attempt,status,error_code,message)
      select id,attempt,'retention_delete_failed','R2_ABANDONED_RETRY_LIMIT','Dừng dọn file R2 sau giới hạn thử lại.' from public.brand_jobs where id=r.id;
  end loop;
  for r in
    select j.id,j.user_id,j.retention_status,p.bucket,p.object_path,p.attempts,p.previous_status
    from public.brand_jobs j
    cross join lateral (
      select q.* from private.r2_pending_uploads q
      where q.job_id=j.id and q.attempts<5 and q.uploaded_at<=now()-interval '60 minutes'
        and (q.next_attempt_at is null or q.next_attempt_at<=now())
        and (q.claimed_at is null or q.claimed_at<now()-interval '15 minutes')
        and (q.bucket<>'brand-videos' or not exists(select 1 from public.brand_scenes s
          where s.job_id=j.id and s.output_path=q.object_path and s.output_expires_at>now()))
        and (j.status<>'done' or (j.reference_path is distinct from q.object_path
          and j.final_path is distinct from q.object_path and not exists(select 1 from public.brand_scenes s
          where s.job_id=j.id and s.output_path=q.object_path)))
      order by q.uploaded_at,q.bucket,q.object_path limit 1
    ) p
    where j.status in ('uploading','error','done')
      and (j.retention_status in ('active','expired') or
        (j.retention_status='deleting' and j.retention_claim_token is null
          and j.retention_claimed_at<now()-interval '15 minutes'))
    order by j.updated_at,j.id for update of j skip locked
    limit greatest(1,least(coalesce(p_limit,20),50))
  loop
    token=extensions.gen_random_uuid();
    update private.r2_pending_uploads q set claim_token=token,claimed_at=now(),attempts=q.attempts+1,
      previous_status=case when r.retention_status='deleting' then coalesce(r.previous_status,'active') else r.retention_status end
      where q.job_id=r.id and q.bucket=r.bucket and q.object_path=r.object_path;
    update public.brand_jobs set retention_status='deleting',retention_claim_token=null,retention_claimed_at=now() where id=r.id;
    job_id=r.id;user_id=r.user_id;bucket=r.bucket;object_path=r.object_path;claim_token=token;attempt=r.attempts+1;
    return next;
  end loop;
end $$;
revoke all on function public.claim_abandoned_r2_uploads(integer) from public,anon,authenticated;
grant execute on function public.claim_abandoned_r2_uploads(integer) to service_role;

create function public.authorize_r2_abandoned_expiry(p_id uuid,p_claim uuid,p_bucket text,p_paths text[])
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce(array_length(p_paths,1),0)=1 and exists(
    select 1 from private.r2_pending_uploads p join public.brand_jobs j on j.id=p.job_id
    where p.job_id=p_id and p.claim_token=p_claim and p.bucket=p_bucket and p.object_path=p_paths[1]
      and p.claimed_at>now()-interval '15 minutes' and p.uploaded_at<=now()-interval '60 minutes'
      and j.status in ('uploading','error','done') and j.retention_status='deleting'
      and j.retention_claim_token is null and j.retention_claimed_at>now()-interval '15 minutes'
      and (j.status<>'done' or (j.reference_path is distinct from p.object_path and j.final_path is distinct from p.object_path
        and not exists(select 1 from public.brand_scenes s where s.job_id=j.id and s.output_path=p.object_path)))
  );
$$;
revoke all on function public.authorize_r2_abandoned_expiry(uuid,uuid,text,text[]) from public;
grant execute on function public.authorize_r2_abandoned_expiry(uuid,uuid,text,text[]) to anon,authenticated;

create or replace function public.complete_abandoned_r2_upload(p_id uuid,p_claim uuid,p_success boolean)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.brand_jobs%rowtype; p private.r2_pending_uploads%rowtype;
begin
  select * into j from public.brand_jobs where id=p_id for update;
  if not found or j.retention_status<>'deleting' or j.retention_claim_token is not null then return false; end if;
  select * into p from private.r2_pending_uploads where job_id=p_id and claim_token=p_claim for update;
  if not found or p.claimed_at<=now()-interval '15 minutes' or p_success is null then return false; end if;
  if p_success then
    if p.bucket='brand-references' and j.reference_path=p.object_path and j.status<>'done' then
      update public.brand_jobs set reference_expires_at=now() where id=p_id;
    elsif p.bucket='brand-videos' and j.status<>'done' then
      update public.brand_scenes set output_path=null,updated_at=now() where job_id=p_id and output_path=p.object_path;
    end if;
    delete from private.r2_pending_uploads where job_id=p_id and bucket=p.bucket and object_path=p.object_path;
  else
    update private.r2_pending_uploads set claim_token=null,claimed_at=null,
      next_attempt_at=case when attempts>=5 then null else now()+case attempts when 1 then interval '1 minute'
        when 2 then interval '5 minutes' when 3 then interval '15 minutes' else interval '60 minutes' end end
      where job_id=p_id and bucket=p.bucket and object_path=p.object_path;
  end if;
  update public.brand_jobs set retention_status=coalesce(p.previous_status,'active'),retention_claimed_at=null where id=p_id;
  insert into public.brand_job_events(job_id,attempt,status,error_code,message)
    values(p_id,j.attempt,case when p_success then 'retention_assets_deleted' else 'retention_delete_failed' end,
      case when p_success then null else 'R2_ABANDONED_DELETE_FAILED' end,
      case when p_success then 'Đã xóa file R2 hết hạn.' when p.attempts>=5 then 'Không thể xóa file R2 sau giới hạn thử lại.' else 'Không thể xóa file R2 hết hạn; sẽ thử lại theo giới hạn.' end);
  return true;
end $$;
revoke all on function public.complete_abandoned_r2_upload(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.complete_abandoned_r2_upload(uuid,uuid,boolean) to service_role;
notify pgrst,'reload schema';
