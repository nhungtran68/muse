create table private.zalo_group_catalog (
  admin_id uuid primary key references public.profiles(id) on delete cascade,
  entries jsonb not null,
  refreshed_at timestamptz not null default now()
);
alter table private.zalo_group_catalog enable row level security;
revoke all on private.zalo_group_catalog from public,anon,authenticated;

create function public.publish_zalo_groups(p_worker uuid,p_token uuid,p_groups jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  perform private.assert_muse_lease(p_worker,p_token);
  if jsonb_typeof(p_groups) is distinct from 'array'
      or octet_length(p_groups::text)>200000 then raise exception 'INVALID_GROUP_CATALOG'; end if;
  if jsonb_array_length(p_groups)>500 or exists (
    select 1 from jsonb_array_elements(p_groups) g
    where coalesce(g->>'id','') !~ '^[0-9]{5,30}$'
      or coalesce(length(g->>'name'),0) not between 1 and 150
  ) then raise exception 'INVALID_GROUP_CATALOG'; end if;
  insert into private.zalo_group_catalog(admin_id,entries)
  values (auth.uid(),p_groups)
  on conflict(admin_id) do update set entries=excluded.entries,refreshed_at=now();
  return true;
end $$;

create function public.list_zalo_groups()
returns jsonb language plpgsql security definer set search_path='' as $$
declare catalog private.zalo_group_catalog%rowtype;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  select * into catalog from private.zalo_group_catalog where admin_id=auth.uid();
  return jsonb_build_object(
    'available', coalesce(catalog.refreshed_at > now()-interval '5 minutes',false),
    'groups', case when catalog.refreshed_at > now()-interval '5 minutes'
      then catalog.entries else '[]'::jsonb end
  );
end $$;

create function public.choose_zalo_group(p_enabled boolean,p_group_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_enabled and not exists (
    select 1 from private.zalo_group_catalog c, jsonb_array_elements(c.entries) g
    where c.admin_id=auth.uid() and c.refreshed_at > now()-interval '5 minutes'
      and g->>'id'=p_group_id
  ) then raise exception 'ZALO_GROUP_NOT_AVAILABLE'; end if;
  return public.set_zalo_delivery(p_enabled,p_group_id);
end $$;

revoke all on function public.publish_zalo_groups(uuid,uuid,jsonb),
  public.list_zalo_groups(),public.choose_zalo_group(boolean,text) from public,anon,authenticated;
grant execute on function public.publish_zalo_groups(uuid,uuid,jsonb),
  public.list_zalo_groups(),public.choose_zalo_group(boolean,text) to authenticated;
