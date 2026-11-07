-- A single paired machine can only report health and acknowledge a start request.
-- Its random device secret is never stored in the database, only its SHA-256 hash.
create table private.muse_control_device (
  singleton boolean primary key default true check (singleton),
  device_id uuid not null,
  secret_hash text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  state text not null default 'offline',
  last_seen timestamptz,
  request_id uuid,
  requested_at timestamptz,
  requested_by uuid,
  acknowledged_at timestamptz
);
alter table private.muse_control_device enable row level security;
revoke all on private.muse_control_device from public, anon, authenticated;

create function public.muse_control_enroll(p_device_id uuid, p_secret_hash text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Chỉ quản trị viên'; end if;
  if p_device_id is null or p_secret_hash !~ '^[0-9a-f]{64}$' then raise exception 'Thiết bị không hợp lệ'; end if;
  insert into private.muse_control_device(singleton,device_id,secret_hash) values(true,p_device_id,p_secret_hash)
  on conflict(singleton) do nothing;
  if not exists(select 1 from private.muse_control_device where singleton and device_id=p_device_id and secret_hash=p_secret_hash) then
    raise exception 'Một máy khác đã được kết nối; cần quản trị viên ngắt kết nối máy cũ trước.';
  end if;
end $$;

create function public.muse_control_status()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare device private.muse_control_device%rowtype;
begin
  if not public.is_admin() then raise exception 'Chỉ quản trị viên'; end if;
  select * into device from private.muse_control_device where singleton;
  if not found then return jsonb_build_object('paired',false); end if;
  return jsonb_build_object('paired',true,'state',device.state,'last_seen',device.last_seen,
    'online',coalesce(device.last_seen > now()-interval '45 seconds',false),
    'pending',coalesce(device.request_id is not null and device.acknowledged_at is null and device.requested_at > now()-interval '5 minutes',false));
end $$;

create function public.muse_control_start()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare device private.muse_control_device%rowtype;
begin
  if not public.is_admin() then raise exception 'Chỉ quản trị viên'; end if;
  select * into device from private.muse_control_device where singleton for update;
  if not found or device.last_seen is null or device.last_seen <= now()-interval '45 seconds' then
    raise exception 'Máy chạy Muse chưa kết nối. Hãy bật máy và đăng nhập Windows.';
  end if;
  if device.requested_at > now()-interval '20 seconds' then
    return jsonb_build_object('accepted',true,'already_requested',true);
  end if;
  update private.muse_control_device set request_id=gen_random_uuid(),requested_at=now(),requested_by=auth.uid(),acknowledged_at=null where singleton;
  return jsonb_build_object('accepted',true,'already_requested',false);
end $$;

create function public.muse_control_poll(p_device_id uuid,p_secret text,p_state text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare device private.muse_control_device%rowtype;
begin
  if p_secret is null or p_secret !~ '^[0-9a-f]{64}$' or p_state not in
    ('checking_tools','waiting_docker','waiting_asr','starting_worker','waiting_admin_login','waiting_muse_login',
     'waiting_worker_lease','ready','error','waiting_setup','asr_container_missing','waiting_retry','stopped') then
    raise exception 'Thiết bị không hợp lệ';
  end if;
  update private.muse_control_device set last_seen=now(),state=p_state
    where singleton and device_id=p_device_id and secret_hash=encode(sha256(convert_to(p_secret,'UTF8')),'hex')
    returning * into device;
  if not found then raise exception 'Thiết bị không hợp lệ'; end if;
  return jsonb_build_object('request_id',case when device.acknowledged_at is null and device.requested_at > now()-interval '5 minutes' then device.request_id else null end);
end $$;

create function public.muse_control_ack(p_device_id uuid,p_secret text,p_request_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_secret is null or p_secret !~ '^[0-9a-f]{64}$' then raise exception 'Thiết bị không hợp lệ'; end if;
  update private.muse_control_device set acknowledged_at=now()
    where singleton and device_id=p_device_id and secret_hash=encode(sha256(convert_to(p_secret,'UTF8')),'hex')
      and request_id=p_request_id and requested_at > now()-interval '5 minutes';
  return found;
end $$;

revoke all on function public.muse_control_enroll(uuid,text) from public,anon,authenticated;
revoke all on function public.muse_control_status() from public,anon,authenticated;
revoke all on function public.muse_control_start() from public,anon,authenticated;
revoke all on function public.muse_control_poll(uuid,text,text) from public,anon,authenticated;
revoke all on function public.muse_control_ack(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.muse_control_enroll(uuid,text),public.muse_control_status(),public.muse_control_start() to authenticated;
grant execute on function public.muse_control_poll(uuid,text,text),public.muse_control_ack(uuid,text,uuid) to anon,authenticated;
