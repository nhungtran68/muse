alter table public.app_settings
  add column if not exists output_storage text not null default 'r2'
    check (output_storage in ('r2','supabase')),
  add column if not exists send_outputs_to_zalo boolean not null default false,
  add column if not exists zalo_group_id text,
  add column if not exists delivery_updated_at timestamptz;

create table if not exists public.media_deliveries (
  id uuid primary key default extensions.gen_random_uuid(),
  job_id uuid not null references public.brand_jobs(id) on delete cascade,
  channel text not null check (channel in ('zalo_group')),
  target_id text not null,
  status text not null default 'sending' check (status in ('sending','sent','failed')),
  attempts integer not null default 1 check (attempts between 1 and 3),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  unique(job_id, channel, target_id)
);
create index if not exists media_deliveries_job on public.media_deliveries(job_id, channel);
alter table public.media_deliveries enable row level security;
drop policy if exists media_deliveries_read on public.media_deliveries;
create policy media_deliveries_read on public.media_deliveries for select to authenticated using(
  exists(select 1 from public.brand_jobs j where j.id=job_id and (j.user_id=auth.uid() or public.is_admin()))
);
drop policy if exists media_deliveries_admin_write on public.media_deliveries;
create policy media_deliveries_admin_write on public.media_deliveries for all to authenticated
  using(public.is_admin()) with check(public.is_admin());

create or replace function public.update_media_delivery_settings(
  p_output_storage text,
  p_send_outputs_to_zalo boolean,
  p_zalo_group_id text
) returns public.app_settings language plpgsql security definer set search_path='' as $$
declare result public.app_settings%rowtype;
begin
  if not public.is_admin() then raise exception 'Chỉ quản trị viên'; end if;
  if p_output_storage not in ('r2','supabase') then raise exception 'Kho lưu trữ không hợp lệ'; end if;
  if p_send_outputs_to_zalo and nullif(btrim(coalesce(p_zalo_group_id,'')),'') is null then
    raise exception 'Cần nhập mã nhóm Zalo trước khi bật gửi tự động';
  end if;
  update public.app_settings set
    output_storage=p_output_storage,
    send_outputs_to_zalo=p_send_outputs_to_zalo,
    zalo_group_id=nullif(btrim(coalesce(p_zalo_group_id,'')),''),
    delivery_updated_at=now(), updated_at=now()
  where id=true returning * into result;
  if to_regclass('private.r2_media_settings') is not null then
    update private.r2_media_settings set enabled=(p_output_storage='r2') where singleton;
  end if;
  return result;
end $$;
revoke all on function public.update_media_delivery_settings(text,boolean,text) from public,anon;
grant execute on function public.update_media_delivery_settings(text,boolean,text) to authenticated;

create or replace function public.claim_media_delivery(p_job uuid,p_channel text,p_target_id text)
returns boolean language plpgsql security definer set search_path='' as $$
declare row public.media_deliveries%rowtype;
begin
  if not public.is_admin() then raise exception 'Chỉ quản trị viên'; end if;
  insert into public.media_deliveries(job_id,channel,target_id,status,attempts)
  values(p_job,p_channel,p_target_id,'sending',1)
  on conflict (job_id,channel,target_id) do nothing;
  select * into row from public.media_deliveries where job_id=p_job and channel=p_channel and target_id=p_target_id for update;
  if row.status='sent' or (row.status='sending' and row.updated_at > now()-interval '15 minutes') then return false; end if;
  if row.attempts>=3 then return false; end if;
  update public.media_deliveries set status='sending',attempts=row.attempts+1,last_error=null,updated_at=now()
  where id=row.id;
  return true;
end $$;
revoke all on function public.claim_media_delivery(uuid,text,text) from public,anon;
grant execute on function public.claim_media_delivery(uuid,text,text) to authenticated;

create or replace function public.finish_media_delivery(p_job uuid,p_channel text,p_target_id text,p_ok boolean,p_error text default null)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not public.is_admin() then raise exception 'Chỉ quản trị viên'; end if;
  update public.media_deliveries set status=case when p_ok then 'sent' else 'failed' end,
    last_error=case when p_ok then null else left(coalesce(p_error,'Giao không thành công'),400) end,
    sent_at=case when p_ok then now() else sent_at end,updated_at=now()
  where job_id=p_job and channel=p_channel and target_id=p_target_id;
end $$;
revoke all on function public.finish_media_delivery(uuid,text,text,boolean,text) from public,anon;
grant execute on function public.finish_media_delivery(uuid,text,text,boolean,text) to authenticated;
