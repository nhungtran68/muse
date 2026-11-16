-- Optional distribution. Leave the existing R2 setting at its current value.
create table private.zalo_delivery_settings (
  admin_id uuid primary key references public.profiles(id) on delete cascade,
  group_id text not null check (group_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  enabled_since timestamptz
);
create table private.zalo_deliveries (
  job_id uuid primary key references public.brand_jobs(id) on delete cascade,
  admin_id uuid not null references public.profiles(id) on delete cascade,
  group_id text not null,
  state text not null default 'pending' check (state in ('pending','sending','sent','failed','uncertain','expired')),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  claim uuid,
  detail text
);
create index zalo_pending on private.zalo_deliveries(created_at) where state='pending';
alter table private.zalo_delivery_settings enable row level security;
alter table private.zalo_deliveries enable row level security;
revoke all on private.zalo_delivery_settings, private.zalo_deliveries from public,anon,authenticated;

create function public.get_video_delivery_settings() returns jsonb
language plpgsql security definer set search_path='' as $$
declare config private.zalo_delivery_settings%rowtype;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  select * into config from private.zalo_delivery_settings where admin_id=auth.uid();
  return jsonb_build_object(
    'r2', (select enabled from private.r2_media_settings where singleton),
    'zalo', config.enabled_since is not null,
    'group_id', config.group_id,
    'recent', coalesce((
      select jsonb_agg(to_jsonb(recent) order by recent.created_at desc)
      from (
        select job_id, case when state='sending' and claimed_at < now()-interval '2 minutes'
          then 'uncertain' else state end as state, created_at
        from private.zalo_deliveries where admin_id=auth.uid() order by created_at desc limit 5
      ) recent
    ), '[]'::jsonb)
  );
end $$;

create function public.set_video_storage(p_r2 boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_r2 is null then raise exception 'INVALID_STORAGE'; end if;
  update private.r2_media_settings set enabled=p_r2 where singleton;
  return public.get_video_delivery_settings();
end $$;

create function public.set_zalo_delivery(p_enabled boolean,p_group_id text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare target text := btrim(coalesce(p_group_id,''));
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_enabled is null or (p_enabled and target !~ '^[A-Za-z0-9_-]{1,100}$') then
    raise exception 'INVALID_ZALO_GROUP';
  end if;
  perform 1 from private.zalo_delivery_settings where admin_id=auth.uid() for update;
  if p_enabled then
    insert into private.zalo_delivery_settings as current_config(admin_id,group_id,enabled_since)
    values(auth.uid(),target,now())
    on conflict(admin_id) do update set
      group_id=excluded.group_id,
      enabled_since=case when current_config.group_id=excluded.group_id
        then coalesce(current_config.enabled_since,excluded.enabled_since)
        else excluded.enabled_since end;
  else
    update private.zalo_delivery_settings set enabled_since=null where admin_id=auth.uid();
  end if;
  update private.zalo_deliveries d set state='expired'
  where d.admin_id=auth.uid() and d.state='pending'
    and (not p_enabled or d.group_id<>target);
  return public.get_video_delivery_settings();
end $$;

create function private.enqueue_zalo_delivery() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.creation_mode <> 'image' and new.final_path like '%.mp4' then
    insert into private.zalo_deliveries(job_id,admin_id,group_id)
    select new.id,c.admin_id,c.group_id from private.zalo_delivery_settings c
    join public.profiles p on p.id=c.admin_id and p.role='admin' and p.approved
    where c.admin_id=new.user_id and new.created_at >= c.enabled_since
    for share of c
    on conflict(job_id) do nothing;
  end if;
  return new;
end $$;
revoke all on function private.enqueue_zalo_delivery() from public,anon,authenticated;
create trigger enqueue_zalo_delivery after update of status on public.brand_jobs
for each row when (new.status='done' and old.status is distinct from 'done')
execute function private.enqueue_zalo_delivery();

create function public.claim_zalo_delivery(p_worker uuid,p_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare item jsonb;
begin
  perform private.assert_muse_lease(p_worker,p_token);
  update private.zalo_deliveries d set state='expired'
  where d.state='pending' and d.created_at < now()-interval '60 minutes';
  with candidate as (
    select d.job_id,j.final_path,j.storage_provider,j.output_expires_at
    from private.zalo_deliveries d
    join public.brand_jobs j on j.id=d.job_id and j.user_id=d.admin_id and j.status='done'
    join private.zalo_delivery_settings c on c.admin_id=d.admin_id and c.group_id=d.group_id
    join public.profiles p on p.id=d.admin_id and p.role='admin' and p.approved
    where d.state='pending' and c.enabled_since<=j.created_at
      and j.retention_status='active' and j.output_expires_at>now()
    order by d.created_at limit 1 for update of d skip locked
  )
  update private.zalo_deliveries d set state='sending',claimed_at=now(),claim=extensions.gen_random_uuid()
  from candidate where d.job_id=candidate.job_id
  returning jsonb_build_object('id',d.job_id,'claim',d.claim,'group_id',d.group_id,
    'final_path',candidate.final_path,'storage_provider',candidate.storage_provider,
    'expires_at',candidate.output_expires_at) into item;
  return item;
end $$;

create function public.finish_zalo_delivery(p_job uuid,p_claim uuid,p_state text,p_detail text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_state is null or p_state not in ('sent','failed','uncertain') then raise exception 'INVALID_STATE'; end if;
  update private.zalo_deliveries set state=p_state,detail=left(p_detail,120)
  where job_id=p_job and claim=p_claim and state='sending';
  return found;
end $$;

revoke all on function public.get_video_delivery_settings(),public.set_video_storage(boolean),
  public.set_zalo_delivery(boolean,text),public.claim_zalo_delivery(uuid,uuid),
  public.finish_zalo_delivery(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.get_video_delivery_settings(),public.set_video_storage(boolean),
  public.set_zalo_delivery(boolean,text),public.claim_zalo_delivery(uuid,uuid),
  public.finish_zalo_delivery(uuid,uuid,text,text) to authenticated;
