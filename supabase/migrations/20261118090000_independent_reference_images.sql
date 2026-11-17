-- Each selected image remains a separate object. Existing one-image jobs keep
-- reference_images NULL and their established path, hash and retention flow.
alter table public.brand_jobs add column if not exists reference_images jsonb;

create or replace function public.set_job_reference_images(p_id uuid,p_hashes text[])
returns public.brand_jobs language plpgsql security definer set search_path='' as $$
declare j public.brand_jobs%rowtype; desired jsonb; count_images integer;
begin
  count_images=coalesce(array_length(p_hashes,1),0);
  if count_images not between 2 and 5 or exists(select 1 from unnest(p_hashes) h where h is null or h !~ '^[0-9a-f]{64}$') then
    raise exception 'Chọn từ 2 đến 5 ảnh JPG, PNG hoặc WebP hợp lệ';
  end if;
  select * into j from public.brand_jobs where id=p_id and user_id=auth.uid() for update;
  if not found or j.status<>'uploading' or j.reference_kind<>'image' or j.reference_path is null or j.reference_sha256<>p_hashes[1] then
    raise exception 'Yêu cầu không thể nhận danh sách ảnh này';
  end if;
  if j.reference_expires_at is not null and j.reference_expires_at<=now() then
    raise exception 'Ảnh của yêu cầu đã hết hạn. Hãy gửi yêu cầu mới';
  end if;
  if not exists(select 1 from public.profiles where id=auth.uid() and approved) then raise exception 'Tài khoản chưa được duyệt'; end if;
  select jsonb_agg(jsonb_build_object('path',j.user_id::text||'/'||j.id::text||'/reference'||case when ordinal=1 then '' else '-'||ordinal::text end,'sha256',image_hash) order by ordinal)
    into desired from unnest(p_hashes) with ordinality as selected(image_hash,ordinal);
  if j.reference_images is not null then
    if j.reference_images<>desired then raise exception 'Danh sách ảnh của yêu cầu đã được khóa'; end if;
    return j;
  end if;
  if exists(select 1 from storage.objects where bucket_id='brand-references' and name=j.reference_path) then
    raise exception 'Ảnh đầu tiên đã tải lên; không thể đổi số ảnh';
  end if;
  update public.brand_jobs set reference_images=desired,updated_at=now() where id=p_id returning * into j;
  return j;
end $$;
revoke all on function public.set_job_reference_images(uuid,text[]) from public,anon;
grant execute on function public.set_job_reference_images(uuid,text[]) to authenticated;

drop policy if exists ref_upload on storage.objects;
create policy ref_upload on storage.objects for insert to authenticated with check (
  bucket_id='brand-references' and exists(select 1 from public.brand_jobs j
    where j.user_id=(select auth.uid()) and j.status='uploading'
      and (j.reference_path=name or exists(select 1 from jsonb_array_elements(coalesce(j.reference_images,'[]'::jsonb)) item where item->>'path'=name)))
);
drop policy if exists ref_read on storage.objects;
create policy ref_read on storage.objects for select to authenticated using (
  bucket_id='brand-references' and exists(select 1 from public.brand_jobs j
    where (j.user_id=(select auth.uid()) or (select public.is_admin()))
      and (j.reference_expires_at is null or j.reference_expires_at>pg_catalog.now())
      and (j.reference_path=name or exists(select 1 from jsonb_array_elements(coalesce(j.reference_images,'[]'::jsonb)) item where item->>'path'=name)))
);
drop policy if exists ref_delete on storage.objects;
create policy ref_delete on storage.objects for delete to authenticated using (
  bucket_id='brand-references' and exists(select 1 from public.brand_jobs j
    where j.user_id=(select auth.uid()) and j.status='uploading'
      and (j.reference_path=name or exists(select 1 from jsonb_array_elements(coalesce(j.reference_images,'[]'::jsonb)) item where item->>'path'=name)))
);

create or replace function public.queue_brand_job(p_id uuid) returns public.brand_jobs
language plpgsql security definer set search_path='' as $$
declare j public.brand_jobs%rowtype;
begin
  select * into j from public.brand_jobs where id=p_id and user_id=auth.uid() for update;
  if not found then raise exception 'Không tìm thấy yêu cầu'; end if;
  if j.status<>'uploading' then return j; end if;
  if not exists(select 1 from public.profiles where id=auth.uid() and approved) then raise exception 'Tài khoản chưa được duyệt'; end if;
  if j.reference_expires_at is not null and j.reference_expires_at<=now() then
    raise exception 'Ảnh của yêu cầu đã hết hạn. Hãy gửi yêu cầu mới';
  end if;
  if j.reference_path is null or not exists(select 1 from storage.objects where bucket_id='brand-references' and name=j.reference_path) then
    raise exception 'Chưa tải xong ảnh tham chiếu';
  end if;
  if j.reference_images is not null and (
    jsonb_typeof(j.reference_images)<>'array' or jsonb_array_length(j.reference_images) not between 2 and 5
    or j.reference_images->0->>'path'<>j.reference_path or j.reference_images->0->>'sha256'<>j.reference_sha256
    or exists(select 1 from jsonb_array_elements(j.reference_images) item
      where not exists(select 1 from storage.objects where bucket_id='brand-references' and name=item->>'path'))
  ) then raise exception 'Chưa tải đủ ảnh tham chiếu'; end if;
  update public.brand_jobs set status=case when schema_version=3 then 'script_queued' else 'queued' end,updated_at=now()
    where id=p_id returning * into j;
  insert into public.brand_job_events(job_id,attempt,status) values(p_id,0,j.status);
  return j;
end $$;

create or replace function public.register_r2_upload(p_id uuid,p_bucket text,p_path text)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.brand_jobs%rowtype;
begin
  select * into j from public.brand_jobs where id=p_id for update;
  if not found or j.retention_status='deleting' or p_path is null
    or p_path not like j.user_id::text||'/'||j.id::text||'/%'
    or p_path ~ '(^|/)\.\.(/|$)' or position(E'\\' in p_path)>0 then return false; end if;
  if p_bucket='brand-references' then
    if j.reference_storage_provider<>'r2' or j.user_id is distinct from auth.uid() or j.status<>'uploading'
      or not (j.reference_path is not distinct from p_path or exists(select 1 from jsonb_array_elements(coalesce(j.reference_images,'[]'::jsonb)) item where item->>'path'=p_path)) then return false; end if;
  elsif p_bucket='brand-videos' then
    if j.storage_provider<>'r2' or public.can_upload_brand_video(p_path) is not true then return false; end if;
  else return false; end if;
  insert into private.r2_pending_uploads(job_id,bucket,object_path) values(p_id,p_bucket,p_path)
    on conflict(job_id,bucket,object_path) do update set uploaded_at=clock_timestamp(),attempts=0,
      next_attempt_at=null,claim_token=null,claimed_at=null,previous_status=null;
  return true;
end $$;

create or replace function public.authorize_r2_expiry(p_id uuid,p_claim uuid,p_bucket text,p_paths text[])
returns boolean language plpgsql stable security definer set search_path='' as $$
declare j public.brand_jobs%rowtype; item text;
begin
  if p_claim is null or p_bucket not in ('brand-videos','brand-references')
    or coalesce(array_length(p_paths,1),0) not between 1 and 10 then return false; end if;
  select * into j from public.brand_jobs where id=p_id and status='done'
    and retention_status='deleting' and retention_claim_token=p_claim
    and retention_claimed_at>now()-interval '15 minutes';
  if not found then return false; end if;
  foreach item in array p_paths loop
    if item is null then return false; end if;
    if p_bucket='brand-references' then
      if j.reference_storage_provider<>'r2' or j.reference_expires_at is null or j.reference_expires_at>now()
        or not (j.reference_path=item or exists(select 1 from jsonb_array_elements(coalesce(j.reference_images,'[]'::jsonb)) image where image->>'path'=item)) then return false; end if;
    else
      if j.storage_provider<>'r2' or not exists(
        select 1 from public.brand_jobs b where b.id=p_id and b.final_path=item and b.output_expires_at<=now()
        union all select 1 from public.brand_scenes s where s.job_id=p_id and s.output_path=item and s.output_expires_at<=now()
      ) then return false; end if;
    end if;
  end loop;
  return true;
end $$;

create function private.manage_independent_references() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.status='done' and old.status is distinct from 'done' and new.reference_images is not null then
    delete from private.r2_pending_uploads p where p.job_id=new.id and p.bucket='brand-references'
      and p.object_path<>new.reference_path
      and exists(select 1 from jsonb_array_elements(new.reference_images) item where item->>'path'=p.object_path);
  end if;
  if new.reference_path is null and old.reference_path is not null and new.reference_images is not null then
    update public.brand_jobs set reference_images=null where id=new.id;
  end if;
  return new;
end $$;
revoke all on function private.manage_independent_references() from public,anon,authenticated;
create trigger manage_independent_references after update of status,reference_path on public.brand_jobs
for each row execute function private.manage_independent_references();

-- An abandoned secondary upload invalidates the full reference set. A retry
-- must request the original images again rather than process a partial set.
create or replace function public.complete_abandoned_r2_upload(p_id uuid,p_claim uuid,p_success boolean)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.brand_jobs%rowtype; p private.r2_pending_uploads%rowtype;
begin
  select * into j from public.brand_jobs where id=p_id for update;
  if not found or j.retention_status<>'deleting' or j.retention_claim_token is not null then return false; end if;
  select * into p from private.r2_pending_uploads where job_id=p_id and claim_token=p_claim for update;
  if not found or p.claimed_at<=now()-interval '15 minutes' or p_success is null then return false; end if;
  if p_success then
    if p.bucket='brand-references' and j.status<>'done' and
      (j.reference_path=p.object_path or exists(select 1 from jsonb_array_elements(coalesce(j.reference_images,'[]'::jsonb)) image where image->>'path'=p.object_path)) then
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

notify pgrst,'reload schema';
