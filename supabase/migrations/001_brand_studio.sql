create extension if not exists pgcrypto with schema extensions;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'member' check (role in ('admin','member')),
  approved boolean not null default false,
  created_at timestamptz not null default now()
);

create function public.create_profile() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id,email) values(new.id,lower(new.email))
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.create_profile();

create function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role = 'admin' and approved);
$$;

create table public.app_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  max_scenes integer not null default 4 check (max_scenes between 1 and 8),
  daily_limit integer not null default 3 check (daily_limit between 1 and 30),
  scene_seconds integer not null default 10 check (scene_seconds in (5,10)),
  worker_heartbeat timestamptz,
  updated_at timestamptz not null default now()
);
insert into public.app_settings(id) values(true);

create table public.brand_jobs (
  id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  content text not null check (char_length(content) between 10 and 4000),
  scene_count integer not null check (scene_count between 1 and 8),
  scene_seconds integer not null check (scene_seconds in (5,10)),
  reference_path text not null,
  status text not null default 'uploading' check (status in ('uploading','queued','planning','generating','joining','done','needs_review','reviewed')),
  plan jsonb not null default '[]'::jsonb,
  current_scene integer not null default 0,
  final_path text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index brand_jobs_user_created on public.brand_jobs(user_id,created_at desc);
create index brand_jobs_queue on public.brand_jobs(created_at) where status = 'queued';

create table public.brand_scenes (
  job_id uuid not null references public.brand_jobs(id) on delete cascade,
  scene_index integer not null,
  prompt text not null,
  status text not null default 'waiting' check (status in ('waiting','generating','done','needs_review')),
  output_path text,
  duration numeric,
  primary key(job_id,scene_index)
);

create table public.admin_bootstrap (
  id boolean primary key default true check (id),
  email text not null,
  code_hash text not null,
  used_at timestamptz
);
revoke all on public.admin_bootstrap from anon,authenticated;

create function public.claim_admin(setup_code text) returns boolean
language plpgsql security definer set search_path = public,auth,extensions as $$
declare target public.admin_bootstrap%rowtype;
begin
  if auth.uid() is null then raise exception 'Đăng nhập trước khi thiết lập quản trị'; end if;
  select * into target from public.admin_bootstrap where id = true for update;
  if not found or target.used_at is not null then raise exception 'Mã thiết lập không còn hiệu lực'; end if;
  if not exists(select 1 from auth.users where id = auth.uid() and lower(email) = target.email and email_confirmed_at is not null) then
    raise exception 'Email quản trị chưa được xác nhận';
  end if;
  if encode(digest(setup_code,'sha256'),'hex') <> target.code_hash then raise exception 'Mã thiết lập không đúng'; end if;
  update public.profiles set role='admin',approved=true where id=auth.uid();
  update public.admin_bootstrap set used_at=now() where id=true;
  return true;
end $$;
revoke all on function public.claim_admin(text) from public,anon;
grant execute on function public.claim_admin(text) to authenticated;

create function public.submit_brand_job(p_id uuid,p_content text,p_scene_count integer,p_reference_path text)
returns public.brand_jobs language plpgsql security definer set search_path = public as $$
declare settings public.app_settings%rowtype; result public.brand_jobs%rowtype;
begin
  if auth.uid() is null then raise exception 'Cần đăng nhập'; end if;
  if not exists(select 1 from public.profiles where id=auth.uid() and approved) then raise exception 'Tài khoản chưa được quản trị duyệt'; end if;
  select * into settings from public.app_settings where id=true;
  if not settings.enabled then raise exception 'Quản trị đang tạm dừng tạo video'; end if;
  if p_id is null or p_content is null or char_length(trim(p_content)) not between 10 and 4000
     or p_scene_count is null or p_scene_count not between 1 and settings.max_scenes
     or p_reference_path is null or p_reference_path <> auth.uid()::text || '/' || p_id::text || '/reference'
  then raise exception 'Thông tin tạo video không hợp lệ'; end if;
  if (select count(*) from public.brand_jobs where user_id=auth.uid() and created_at >= date_trunc('day',now() at time zone 'Asia/Ho_Chi_Minh') at time zone 'Asia/Ho_Chi_Minh') >= settings.daily_limit then
    raise exception 'Đã hết lượt tạo video hôm nay';
  end if;
  if exists(select 1 from public.brand_jobs where user_id=auth.uid() and status in ('uploading','queued','planning','generating','joining','needs_review')) then
    raise exception 'Bạn đã có tác vụ đang chờ hoặc cần kiểm tra';
  end if;
  insert into public.brand_jobs(id,user_id,content,scene_count,scene_seconds,reference_path)
  values(p_id,auth.uid(),trim(p_content),p_scene_count,settings.scene_seconds,p_reference_path)
  returning * into result;
  return result;
end $$;
revoke all on function public.submit_brand_job(uuid,text,integer,text) from public,anon;
grant execute on function public.submit_brand_job(uuid,text,integer,text) to authenticated;

create function public.queue_brand_job(p_id uuid) returns public.brand_jobs
language plpgsql security definer set search_path = public,storage as $$
declare result public.brand_jobs%rowtype;
begin
  select * into result from public.brand_jobs where id=p_id and user_id=auth.uid() and status='uploading' for update;
  if not found then raise exception 'Không có tác vụ đang tải ảnh'; end if;
  if not exists(select 1 from storage.objects where bucket_id='brand-references' and name=result.reference_path) then
    raise exception 'Chưa tải ảnh tham chiếu lên';
  end if;
  update public.brand_jobs set status='queued',updated_at=now() where id=p_id returning * into result;
  return result;
end $$;
revoke all on function public.queue_brand_job(uuid) from public,anon;
grant execute on function public.queue_brand_job(uuid) to authenticated;

create function public.cancel_brand_upload(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.brand_jobs where id=p_id and user_id=auth.uid() and status='uploading';
end $$;
revoke all on function public.cancel_brand_upload(uuid) from public,anon;
grant execute on function public.cancel_brand_upload(uuid) to authenticated;

create function public.claim_next_brand_job() returns public.brand_jobs
language plpgsql security definer set search_path = public as $$
declare result public.brand_jobs%rowtype;
begin
  if not public.is_admin() then raise exception 'Chỉ quản trị viên'; end if;
  select * into result from public.brand_jobs where status='queued' order by created_at for update skip locked limit 1;
  if found then
    update public.brand_jobs set status='planning',updated_at=now() where id=result.id returning * into result;
  end if;
  return result;
end $$;
revoke all on function public.claim_next_brand_job() from public,anon;
grant execute on function public.claim_next_brand_job() to authenticated;

alter table public.profiles enable row level security;
alter table public.app_settings enable row level security;
alter table public.brand_jobs enable row level security;
alter table public.brand_scenes enable row level security;
alter table public.admin_bootstrap enable row level security;

create policy profile_read on public.profiles for select to authenticated using(id=auth.uid() or public.is_admin());
create policy profile_admin_update on public.profiles for update to authenticated using(public.is_admin()) with check(public.is_admin());
create policy settings_read on public.app_settings for select to authenticated using(true);
create policy settings_admin_update on public.app_settings for update to authenticated using(public.is_admin()) with check(public.is_admin());
create policy jobs_read on public.brand_jobs for select to authenticated using(user_id=auth.uid() or public.is_admin());
create policy jobs_admin_update on public.brand_jobs for update to authenticated using(public.is_admin()) with check(public.is_admin());
create policy scenes_read on public.brand_scenes for select to authenticated using(
  exists(select 1 from public.brand_jobs where id=job_id and (user_id=auth.uid() or public.is_admin()))
);
create policy scenes_admin_write on public.brand_scenes for all to authenticated using(public.is_admin()) with check(public.is_admin());

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('brand-references','brand-references',false,10485760,array['image/png','image/jpeg','image/webp']),
      ('brand-videos','brand-videos',false,52428800,array['video/mp4']);

create policy ref_upload on storage.objects for insert to authenticated with check(
  bucket_id='brand-references' and exists(
    select 1 from public.brand_jobs where reference_path=name and user_id=auth.uid() and status='uploading'
  )
);
create policy ref_read on storage.objects for select to authenticated using(
  bucket_id='brand-references' and (split_part(name,'/',1)=auth.uid()::text or public.is_admin())
);
create policy ref_delete on storage.objects for delete to authenticated using(
  bucket_id='brand-references' and exists(
    select 1 from public.brand_jobs where reference_path=name and user_id=auth.uid() and status='uploading'
  )
);
create policy video_read on storage.objects for select to authenticated using(
  bucket_id='brand-videos' and (split_part(name,'/',1)=auth.uid()::text or public.is_admin())
);
create policy video_upload on storage.objects for insert to authenticated with check(
  bucket_id='brand-videos' and public.is_admin()
);
create policy video_update on storage.objects for update to authenticated using(
  bucket_id='brand-videos' and public.is_admin()
) with check(bucket_id='brand-videos' and public.is_admin());
