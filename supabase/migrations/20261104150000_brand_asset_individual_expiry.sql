-- Track the 60-minute retention window per stored object, rather than starting
-- one shared clock when a multi-scene job finishes. Existing history stays
-- untouched because the new timestamps are NULL until an output is written.

alter table public.brand_jobs
  add column if not exists reference_expires_at timestamptz;
-- Keep the history row after the reference object is deleted by clearing only
-- its Storage path. New jobs still receive a required reference path through
-- the submission RPC before they can enter the worker queue.
alter table public.brand_jobs alter column reference_path drop not null;
alter table public.brand_scenes
  add column if not exists output_expires_at timestamptz;

create or replace function private.set_brand_output_expiry()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'done' and old.status is distinct from 'done' then
    if new.final_path is null or btrim(new.final_path) = '' then
      raise exception 'A completed brand job must have a final output path';
    end if;
    if new.output_expires_at is null then
      new.output_expires_at := pg_catalog.clock_timestamp() + interval '60 minutes';
    end if;
    if new.reference_path is not null and new.reference_expires_at is null then
      new.reference_expires_at := pg_catalog.clock_timestamp() + interval '60 minutes';
    end if;
    new.retention_status := 'active';
    new.retention_attempts := 0;
    new.retention_claimed_at := null;
    new.retention_claim_token := null;
    new.retention_next_attempt_at := null;
    new.retention_error := null;
    new.retention_deleted_at := null;

    -- A job already running during rollout may have saved scene clips before
    -- this migration installed the per-scene trigger. Start their clock now.
    update public.brand_scenes s
    set output_expires_at = pg_catalog.clock_timestamp() + interval '60 minutes'
    where s.job_id = new.id and s.output_path is not null and s.output_expires_at is null;
  end if;
  return new;
end;
$$;

create or replace function private.set_brand_final_asset_expiry()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' and new.final_path is not null)
    or (tg_op = 'UPDATE' and new.final_path is distinct from old.final_path and new.final_path is not null) then
    new.output_expires_at := pg_catalog.clock_timestamp() + interval '60 minutes';
    new.retention_status := 'active';
    new.retention_attempts := 0;
    new.retention_claimed_at := null;
    new.retention_claim_token := null;
    new.retention_next_attempt_at := null;
    new.retention_error := null;
    new.retention_deleted_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists brand_jobs_set_final_asset_expiry on public.brand_jobs;
create trigger brand_jobs_set_final_asset_expiry
before insert or update of final_path on public.brand_jobs
for each row execute function private.set_brand_final_asset_expiry();

create or replace function private.set_brand_reference_expiry()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.reference_path is distinct from old.reference_path then
    if new.reference_path is not null and new.status = 'done' then
      new.reference_expires_at := pg_catalog.clock_timestamp() + interval '60 minutes';
    else
      new.reference_expires_at := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists brand_jobs_set_reference_expiry on public.brand_jobs;
create trigger brand_jobs_set_reference_expiry
before update of reference_path on public.brand_jobs
for each row execute function private.set_brand_reference_expiry();

create or replace function private.set_brand_scene_output_expiry()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' and new.output_path is not null)
    or (tg_op = 'UPDATE' and new.output_path is distinct from old.output_path and new.output_path is not null) then
    new.output_expires_at := pg_catalog.clock_timestamp() + interval '60 minutes';
  end if;
  return new;
end;
$$;

drop trigger if exists brand_scenes_set_output_expiry on public.brand_scenes;
create trigger brand_scenes_set_output_expiry
before insert or update of output_path on public.brand_scenes
for each row execute function private.set_brand_scene_output_expiry();

create index if not exists brand_scenes_output_expiry
  on public.brand_scenes(output_expires_at, job_id)
  where output_path is not null;

-- Block expired files individually. A scene reaching its deadline must not
-- make a later scene or the final MP4 inaccessible before its own deadline.
drop policy if exists ref_read on storage.objects;
create policy ref_read on storage.objects for select to authenticated
using (
  bucket_id = 'brand-references'
  and exists (
    select 1 from public.brand_jobs j
    where j.reference_path = name
      and (j.user_id = (select auth.uid()) or (select public.is_admin()))
      and (j.reference_expires_at is null or j.reference_expires_at > pg_catalog.now())
  )
);

drop policy if exists video_read on storage.objects;
create policy video_read on storage.objects for select to authenticated
using (
  bucket_id = 'brand-videos'
  and exists (
    select 1 from public.brand_jobs j
    where (j.user_id = (select auth.uid()) or (select public.is_admin()))
      and (
        (j.status = 'done' and j.final_path = name
          and (j.output_expires_at is null or j.output_expires_at > pg_catalog.now()))
        or exists (
          select 1 from public.brand_scenes s
          where s.job_id = j.id and s.status = 'done' and s.output_path = name
            and (s.output_expires_at is null or s.output_expires_at > pg_catalog.now())
        )
      )
  )
);

-- Claims remain job-scoped to keep the existing lease and retry model. Each
-- claim returns only the paths that have individually reached their deadline.
drop function if exists public.claim_expired_brand_outputs(integer);
create function public.claim_expired_brand_outputs(p_limit integer default 20)
returns table (
  job_id uuid,
  user_id uuid,
  final_path text,
  reference_path text,
  scene_paths jsonb,
  retention_attempt integer,
  retention_claim_token uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 50));
begin
  with exhausted as (
    update public.brand_jobs j
    set retention_status = 'delete_failed',
        retention_claimed_at = null,
        retention_claim_token = null,
        retention_next_attempt_at = null,
        retention_error = 'Automatic deletion stopped after the retry limit.'
    where j.status = 'done'
      and j.retention_status = 'deleting'
      and j.retention_claimed_at < pg_catalog.now() - interval '15 minutes'
      and j.retention_attempts >= 5
      and (
        (j.final_path is not null and j.output_expires_at <= pg_catalog.now())
        or (j.reference_path is not null and j.reference_expires_at <= pg_catalog.now())
        or exists (select 1 from public.brand_scenes s where s.job_id=j.id and s.output_path is not null and s.output_expires_at <= pg_catalog.now())
      )
    returning j.id, j.attempt
  )
  insert into public.brand_job_events(job_id, attempt, status, error_code, message)
  select e.id, e.attempt, 'retention_delete_failed', 'RETENTION_RETRY_LIMIT_REACHED',
    'Deletion lease expired after the retry limit.'
  from exhausted e;

  return query
  with candidates as (
    select j.id
    from public.brand_jobs j
    where j.status = 'done'
      and j.retention_attempts < 5
      and (
        (j.final_path is not null and j.output_expires_at <= pg_catalog.now())
        or (j.reference_path is not null and j.reference_expires_at <= pg_catalog.now())
        or exists (select 1 from public.brand_scenes s where s.job_id=j.id and s.output_path is not null and s.output_expires_at <= pg_catalog.now())
      )
      and (
        j.retention_status = 'active'
        or (j.retention_status = 'delete_failed' and j.retention_next_attempt_at is not null and j.retention_next_attempt_at <= pg_catalog.now())
        or (j.retention_status = 'deleting' and j.retention_claimed_at < pg_catalog.now() - interval '15 minutes')
      )
    order by j.updated_at, j.id
    for update of j skip locked
    limit v_limit
  ), claimed as (
    update public.brand_jobs j
    set retention_status = 'deleting',
        retention_attempts = j.retention_attempts + 1,
        retention_claimed_at = pg_catalog.now(),
        retention_claim_token = extensions.gen_random_uuid(),
        retention_next_attempt_at = null,
        retention_error = null
    from candidates c
    where j.id = c.id
    returning j.id, j.user_id,
      case when j.final_path is not null and j.output_expires_at <= pg_catalog.now() then j.final_path end as final_path,
      case when j.reference_path is not null and j.reference_expires_at <= pg_catalog.now() then j.reference_path end as reference_path,
      j.retention_attempts, j.retention_claim_token, j.attempt
  ), logged as (
    insert into public.brand_job_events as inserted_event(job_id, attempt, status, message)
    select c.id, c.attempt, 'retention_deleting',
      'Storage cleanup attempt ' || c.retention_attempts::text || ' started.'
    from claimed c
    returning inserted_event.job_id as logged_job_id
  )
  select c.id, c.user_id, c.final_path, c.reference_path,
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('scene_index', s.scene_index, 'path', s.output_path)
        order by s.scene_index
      )
      from public.brand_scenes s
      where s.job_id = c.id and s.output_path is not null and s.output_expires_at <= pg_catalog.now()
    ), '[]'::jsonb),
    c.retention_attempts, c.retention_claim_token
  from claimed c
  join logged l on l.logged_job_id = c.id;
end;
$$;

drop function if exists public.complete_expired_brand_output(uuid, uuid, boolean, text);
create function public.complete_expired_brand_output(
  p_id uuid,
  p_claim_token uuid,
  p_success boolean,
  p_error text default null,
  p_final_path text default null,
  p_reference_path text default null,
  p_scene_paths jsonb default '[]'::jsonb
)
returns public.brand_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.brand_jobs%rowtype;
  v_delay interval;
  v_has_remaining boolean;
begin
  if p_success is null then raise exception 'p_success is required'; end if;
  if p_scene_paths is null or pg_catalog.jsonb_typeof(p_scene_paths) <> 'array' then
    raise exception 'p_scene_paths must be an array';
  end if;

  select * into v_job from public.brand_jobs j
  where j.id=p_id and j.retention_status='deleting' and j.retention_claim_token=p_claim_token
  for update;
  if not found then raise exception 'Retention claim is no longer current'; end if;

  if p_success then
    if p_final_path is not null then
      update public.brand_jobs set final_path=null where id=p_id and final_path=p_final_path;
    end if;
    if p_reference_path is not null then
      update public.brand_jobs set reference_path=null where id=p_id and reference_path=p_reference_path;
    end if;
    update public.brand_scenes s set output_path=null, updated_at=pg_catalog.now()
    from pg_catalog.jsonb_to_recordset(p_scene_paths) as claimed_scene(scene_index integer,path text)
    where s.job_id=p_id and s.scene_index=claimed_scene.scene_index and s.output_path=claimed_scene.path;

    select (j.final_path is not null or j.reference_path is not null
      or exists(select 1 from public.brand_scenes s where s.job_id=p_id and s.output_path is not null))
    into v_has_remaining from public.brand_jobs j where j.id=p_id;

    update public.brand_jobs set
      retention_status=case when v_has_remaining then 'active' else 'expired' end,
      retention_attempts=0,
      retention_claimed_at=null,
      retention_claim_token=null,
      retention_next_attempt_at=null,
      retention_error=null,
      retention_deleted_at=case when v_has_remaining then null else pg_catalog.now() end,
      updated_at=pg_catalog.now()
    where id=p_id returning * into v_job;

    insert into public.brand_job_events(job_id,attempt,status,message)
    values(p_id,v_job.attempt,
      case when v_has_remaining then 'retention_assets_deleted' else 'retention_expired' end,
      case when v_has_remaining then 'Expired Storage files deleted; later-expiring files remain available.'
        else 'All Storage files for this job have been deleted.' end);
  else
    v_delay := case v_job.retention_attempts
      when 1 then interval '1 minute' when 2 then interval '5 minutes'
      when 3 then interval '15 minutes' else interval '60 minutes' end;
    update public.brand_jobs set
      retention_status='delete_failed',
      retention_claimed_at=null,
      retention_claim_token=null,
      retention_next_attempt_at=case when v_job.retention_attempts < 5 then pg_catalog.now()+v_delay else null end,
      retention_error=case when v_job.retention_attempts < 5 then
        coalesce(nullif(pg_catalog.left(pg_catalog.regexp_replace(coalesce(p_error,''),'[[:cntrl:]]','','g'),250),''),'STORAGE_DELETE_FAILED')
        else 'STORAGE_DELETE_FAILED: retry limit reached' end,
      updated_at=pg_catalog.now()
    where id=p_id returning * into v_job;
    insert into public.brand_job_events(job_id,attempt,status,error_code,message)
    values(p_id,v_job.attempt,'retention_delete_failed','STORAGE_DELETE_FAILED',
      case when v_job.retention_attempts < 5 then
        'Storage cleanup attempt '||v_job.retention_attempts::text||' failed; a retry was scheduled.'
        else 'Storage cleanup attempt '||v_job.retention_attempts::text||' failed after the retry limit.' end);
  end if;
  return v_job;
end;
$$;

revoke all on function public.claim_expired_brand_outputs(integer) from public, anon, authenticated;
revoke all on function public.complete_expired_brand_output(uuid, uuid, boolean, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.claim_expired_brand_outputs(integer) to service_role;
grant execute on function public.complete_expired_brand_output(uuid, uuid, boolean, text, text, text, jsonb) to service_role;

comment on column public.brand_jobs.output_expires_at is
  'Server-set expiry 60 minutes after the final MP4 path is stored; NULL legacy rows are not auto-deleted.';
comment on column public.brand_jobs.reference_expires_at is
  'Server-set expiry 60 minutes after successful job completion for its temporary reference image.';
comment on column public.brand_scenes.output_expires_at is
  'Server-set expiry 60 minutes after this scene output path is stored.';
