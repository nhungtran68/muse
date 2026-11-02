create or replace function public.claim_next_brand_job() returns public.brand_jobs
language plpgsql security definer set search_path = public as $$
declare result public.brand_jobs%rowtype;
begin
  if not public.is_admin() then raise exception 'Chỉ quản trị viên'; end if;
  if exists(select 1 from public.brand_jobs where status in ('planning','generating','joining','needs_review')) then
    return null;
  end if;
  select * into result from public.brand_jobs where status='queued' order by created_at for update skip locked limit 1;
  if found then
    update public.brand_jobs set status='planning',updated_at=now() where id=result.id returning * into result;
  end if;
  return result;
end $$;

create function public.recover_orphaned_brand_jobs() returns integer
language plpgsql security definer set search_path = public as $$
declare changed integer;
begin
  if not public.is_admin() then raise exception 'Chỉ quản trị viên'; end if;
  update public.brand_jobs set status='needs_review',error='Worker đã khởi động lại khi tác vụ đang chạy. Kiểm tra Muse trước khi tạo lại.',updated_at=now()
  where status in ('planning','generating','joining');
  get diagnostics changed = row_count;
  return changed;
end $$;
revoke all on function public.recover_orphaned_brand_jobs() from public,anon;
grant execute on function public.recover_orphaned_brand_jobs() to authenticated;
