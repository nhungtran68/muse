alter table public.brand_jobs add column output_r2_selected boolean;

create table private.video_distribution_access (
  member_id uuid primary key references public.profiles(id) on delete cascade,
  admin_id uuid not null references public.profiles(id) on delete cascade,
  allow_r2 boolean not null,
  group_id text
);
create table private.job_zalo_destination (
  job_id uuid primary key references public.brand_jobs(id) on delete cascade,
  admin_id uuid not null references public.profiles(id) on delete cascade,
  group_id text not null
);
alter table private.video_distribution_access enable row level security;
alter table private.job_zalo_destination enable row level security;
revoke all on private.video_distribution_access,private.job_zalo_destination from public,anon,authenticated;

create function private.video_distribution_for(p_user uuid)
returns table (allow_r2 boolean, admin_id uuid, group_id text, group_name text)
language sql stable set search_path='' as $$
  select coalesce((select enabled from private.r2_media_settings where singleton),false)
    and (p.role='admin' or coalesce(a.allow_r2,false)),
    case when p.role='admin' then p.id else a.admin_id end,
    g.item->>'id', g.item->>'name'
  from public.profiles p
  left join private.video_distribution_access a on a.member_id=p.id
  left join private.zalo_delivery_settings z on z.admin_id=p.id and z.enabled_since is not null
  left join public.profiles owner on owner.id=case when p.role='admin' then p.id else a.admin_id end
    and owner.role='admin' and owner.approved
  left join private.zalo_group_catalog c on c.admin_id=owner.id
    and c.refreshed_at>now()-interval '5 minutes'
  left join lateral (
    select item from jsonb_array_elements(c.entries) item
    where item->>'id'=case when p.role='admin' then z.group_id else a.group_id end limit 1
  ) g on true
  where p.id=p_user and p.approved
    and (p.role='admin' or owner.id is not null or a.member_id is null)
$$;
revoke all on function private.video_distribution_for(uuid) from public,anon,authenticated;

create function public.my_video_distribution() returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce((select jsonb_build_object('r2',allow_r2,'zalo_group',group_name,'zalo_group_id',group_id)
    from private.video_distribution_for(auth.uid())), '{"r2":false,"zalo_group":null}'::jsonb)
$$;

create function public.member_video_distribution(p_member uuid,p_r2 boolean default null,p_group text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if not exists(select 1 from public.profiles where id=p_member and role='member' and approved) then
    raise exception 'MEMBER_NOT_APPROVED';
  end if;
  if p_r2 is not null then
    if nullif(p_group,'') is not null and not exists(
      select 1 from private.zalo_group_catalog c, jsonb_array_elements(c.entries) g
      where c.admin_id=auth.uid() and c.refreshed_at>now()-interval '5 minutes' and g->>'id'=p_group
    ) then raise exception 'ZALO_GROUP_NOT_AVAILABLE'; end if;
    insert into private.video_distribution_access(member_id,admin_id,allow_r2,group_id)
    values(p_member,auth.uid(),p_r2,nullif(p_group,''))
    on conflict(member_id) do update set
      admin_id=excluded.admin_id,allow_r2=excluded.allow_r2,group_id=excluded.group_id;
  end if;
  select jsonb_build_object('r2',allow_r2,'group_id',group_id) into result
    from private.video_distribution_access where member_id=p_member;
  return coalesce(result,'{"r2":false,"group_id":null}'::jsonb);
end $$;

create function public.submit_video_with_distribution(
  p_id uuid,p_request_key uuid,p_content text,p_mode text,p_reference_sha256 text,
  p_r2 boolean,p_zalo_group text
) returns public.brand_jobs language plpgsql security definer set search_path='' as $$
declare job public.brand_jobs%rowtype; permissions record;
begin
  if p_mode is null or p_mode not in ('video_10s','video_free') or p_r2 is null then
    raise exception 'INVALID_VIDEO_OPTIONS';
  end if;
  select * into permissions from private.video_distribution_for(auth.uid());
  if p_r2 and permissions.allow_r2 is distinct from true then raise exception 'R2_NOT_ALLOWED'; end if;
  if p_zalo_group is not null and p_zalo_group is distinct from permissions.group_id then
    raise exception 'ZALO_NOT_ALLOWED';
  end if;
  job=public.submit_single_media_job(p_id,p_request_key,p_content,p_mode,p_reference_sha256);
  if job.id=p_id and job.output_r2_selected is null and job.attempt=0 and job.status in ('queued','uploading') then
    update public.brand_jobs set output_r2_selected=p_r2,storage_provider=case when p_r2 then 'r2' else 'supabase' end
      where id=job.id returning * into job;
    if p_zalo_group is not null then
      insert into private.job_zalo_destination(job_id,admin_id,group_id)
      values(job.id,permissions.admin_id,permissions.group_id);
    end if;
  end if;
  if job.output_r2_selected is distinct from p_r2 or p_zalo_group is distinct from
    (select group_id from private.job_zalo_destination where job_id=job.id) then
    raise exception 'VIDEO_OPTIONS_ALREADY_SET';
  end if;
  return job;
end $$;

create or replace function private.enqueue_zalo_delivery() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.creation_mode <> 'image' and new.final_path like '%.mp4' then
    insert into private.zalo_deliveries(job_id,admin_id,group_id)
    select job_id,admin_id,group_id from private.job_zalo_destination where job_id=new.id
    on conflict(job_id) do nothing;
  end if;
  return new;
end $$;

create or replace function public.claim_zalo_delivery(p_worker uuid,p_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare item jsonb;
begin
  perform private.assert_muse_lease(p_worker,p_token);
  update private.zalo_deliveries d set state='expired'
  where d.state='pending' and d.created_at < now()-interval '60 minutes';
  with candidate as (
    select d.job_id,j.final_path,j.storage_provider,j.output_expires_at
    from private.zalo_deliveries d
    join public.brand_jobs j on j.id=d.job_id and j.status='done'
    join lateral private.video_distribution_for(j.user_id) a
      on a.admin_id=d.admin_id and a.group_id=d.group_id
    where d.state='pending' and j.retention_status='active' and j.output_expires_at>now()
    order by d.created_at limit 1 for update of d skip locked
  )
  update private.zalo_deliveries d set state='sending',claimed_at=now(),claim=extensions.gen_random_uuid()
  from candidate where d.job_id=candidate.job_id
  returning jsonb_build_object('id',d.job_id,'claim',d.claim,'group_id',d.group_id,
    'final_path',candidate.final_path,'storage_provider',candidate.storage_provider,
    'expires_at',candidate.output_expires_at) into item;
  return item;
end $$;

create function private.respect_r2_choice() returns trigger
language plpgsql set search_path='' as $$
begin
  if new.output_r2_selected=false and new.storage_provider='r2' then raise exception 'R2_NOT_SELECTED'; end if;
  return new;
end $$;
revoke all on function private.respect_r2_choice() from public,anon,authenticated;
create trigger respect_r2_choice before update of storage_provider on public.brand_jobs
for each row execute function private.respect_r2_choice();

revoke all on function public.my_video_distribution(),public.member_video_distribution(uuid,boolean,text),
  public.submit_video_with_distribution(uuid,uuid,text,text,text,boolean,text) from public,anon,authenticated;
grant execute on function public.my_video_distribution(),public.member_video_distribution(uuid,boolean,text),
  public.submit_video_with_distribution(uuid,uuid,text,text,text,boolean,text) to authenticated;
