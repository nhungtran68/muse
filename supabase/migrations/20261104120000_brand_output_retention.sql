-- Retain generated media for one hour after a successful job, then delete it
-- through the Supabase Storage API (never by deleting storage.objects rows).
-- Existing jobs intentionally keep output_expires_at = NULL and are not swept.

alter table public.brand_jobs
  add column if not exists output_expires_at timestamptz,
  add column if not exists retention_status text not null default 'active',
  add column if not exists retention_attempts integer not null default 0,
  add column if not exists retention_claimed_at timestamptz,
  add column if not exists retention_claim_token uuid,
  add column if not exists retention_next_attempt_at timestamptz,
  add column if not exists retention_error text,
  add column if not exists retention_deleted_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.brand_jobs'::regclass
      and conname = 'brand_jobs_retention_status_check'
  ) then
    alter table public.brand_jobs
      add constraint brand_jobs_retention_status_check
      check (retention_status in ('active','deleting','expired','delete_failed'));
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.brand_jobs'::regclass
      and conname = 'brand_jobs_retention_attempts_check'
  ) then
    alter table public.brand_jobs
      add constraint brand_jobs_retention_attempts_check
      check (retention_attempts between 0 and 5);
  end if;
end $$;

create index if not exists brand_jobs_retention_due
  on public.brand_jobs (output_expires_at, retention_next_attempt_at, created_at)
  where status = 'done' and retention_status in ('active','delete_failed','deleting');

-- Signed URLs are subject to Storage RLS at creation time. Block access as
-- soon as expiry is due, including while cleanup is retrying; NULL preserves
-- legacy and in-flight job access without starting a retention window.
drop policy if exists ref_read on storage.objects;
create policy ref_read on storage.objects for select to authenticated
using (
  bucket_id = 'brand-references'
  and exists (
    select 1 from public.brand_jobs j
    where j.reference_path = name
      and (j.user_id = (select auth.uid()) or (select public.is_admin()))
      and (j.output_expires_at is null
        or (j.retention_status = 'active' and j.output_expires_at > pg_catalog.now()))
  )
);

drop policy if exists video_read on storage.objects;
create policy video_read on storage.objects for select to authenticated
using (
  bucket_id = 'brand-videos'
  and exists (
    select 1
    from public.brand_jobs j
    where (j.user_id = (select auth.uid()) or (select public.is_admin()))
      and (j.output_expires_at is null
        or (j.retention_status = 'active' and j.output_expires_at > pg_catalog.now()))
      and (
        (j.status = 'done' and j.final_path = name)
        or exists (
          select 1 from public.brand_scenes s
          where s.job_id = j.id and s.status = 'done' and s.output_path = name
        )
      )
  )
);

-- Start the 60-minute window only on a new transition into done. Older done
-- rows remain NULL and the queue below will never select them.
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

drop trigger if exists brand_jobs_set_output_expiry on public.brand_jobs;
create trigger brand_jobs_set_output_expiry
before update of status on public.brand_jobs
for each row execute function private.set_brand_output_expiry();

-- A claim token fences off stale invocations if an Edge Function stalls and a
-- later Cron invocation reclaims its lease. SKIP LOCKED prevents duplicate
-- claims in overlapping Cron runs.
create or replace function public.claim_expired_brand_outputs(p_limit integer default 20)
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
  -- A final crashed attempt must not remain "deleting" forever.
  with exhausted as (
    update public.brand_jobs j
    set retention_status = 'delete_failed',
        retention_claimed_at = null,
        retention_claim_token = null,
        retention_next_attempt_at = null,
        retention_error = 'Automatic deletion stopped after the retry limit.'
    where j.status = 'done'
      and j.output_expires_at is not null
      and j.output_expires_at <= pg_catalog.now()
      and j.retention_status = 'deleting'
      and j.retention_claimed_at < pg_catalog.now() - interval '15 minutes'
      and j.retention_attempts >= 5
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
      and j.output_expires_at is not null
      and j.output_expires_at <= pg_catalog.now()
      and j.final_path is not null
      and j.retention_attempts < 5
      and (
        j.retention_status = 'active'
        or (j.retention_status = 'delete_failed'
            and j.retention_next_attempt_at is not null
            and j.retention_next_attempt_at <= pg_catalog.now())
        or (j.retention_status = 'deleting'
            and j.retention_claimed_at < pg_catalog.now() - interval '15 minutes')
      )
    order by j.output_expires_at, j.created_at, j.id
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
    returning j.id, j.user_id, j.final_path, j.reference_path,
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
      where s.job_id = c.id and s.output_path is not null
    ), '[]'::jsonb),
    c.retention_attempts, c.retention_claim_token
  from claimed c
  join logged l on l.logged_job_id = c.id;
end;
$$;

create or replace function public.complete_expired_brand_output(
  p_id uuid,
  p_claim_token uuid,
  p_success boolean,
  p_error text default null
)
returns public.brand_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.brand_jobs%rowtype;
  v_delay interval;
begin
  if p_success is null then raise exception 'p_success is required'; end if;

  select * into v_job
  from public.brand_jobs j
  where j.id = p_id
    and j.retention_status = 'deleting'
    and j.retention_claim_token = p_claim_token
  for update;

  if not found then
    raise exception 'Retention claim is no longer current';
  end if;

  if p_success then
    -- Only metadata is changed here. Storage objects have already been
    -- removed and confirmed by the Edge Function's Storage API calls.
    update public.brand_jobs
    set retention_status = 'expired',
        retention_deleted_at = pg_catalog.now(),
        retention_claimed_at = null,
        retention_claim_token = null,
        retention_next_attempt_at = null,
        retention_error = null,
        final_path = null,
        updated_at = pg_catalog.now()
    where id = p_id
    returning * into v_job;

    update public.brand_scenes
    set output_path = null, updated_at = pg_catalog.now()
    where job_id = p_id;

    insert into public.brand_job_events(job_id, attempt, status, message)
    values (
      p_id, v_job.attempt, 'retention_expired',
      'Output and reference files deleted through Storage API on cleanup attempt ' || v_job.retention_attempts::text || '.'
    );
  else
    v_delay := case v_job.retention_attempts
      when 1 then interval '1 minute'
      when 2 then interval '5 minutes'
      when 3 then interval '15 minutes'
      else interval '60 minutes'
    end;

    update public.brand_jobs
    set retention_status = 'delete_failed',
        retention_claimed_at = null,
        retention_claim_token = null,
        retention_next_attempt_at = case
          when v_job.retention_attempts < 5 then pg_catalog.now() + v_delay
          else null
        end,
        retention_error = case
          when v_job.retention_attempts < 5 then
            coalesce(nullif(pg_catalog.left(pg_catalog.regexp_replace(coalesce(p_error, ''), '[[:cntrl:]]', '', 'g'), 250), ''), 'STORAGE_DELETE_FAILED')
          else 'STORAGE_DELETE_FAILED: retry limit reached'
        end,
        updated_at = pg_catalog.now()
    where id = p_id
    returning * into v_job;

    insert into public.brand_job_events(job_id, attempt, status, error_code, message)
    values (
      p_id,
      v_job.attempt,
      'retention_delete_failed',
      'STORAGE_DELETE_FAILED',
      case when v_job.retention_attempts < 5 then
        'Storage cleanup attempt ' || v_job.retention_attempts::text || ' failed; a retry was scheduled.'
        else 'Storage cleanup attempt ' || v_job.retention_attempts::text || ' failed after the retry limit.' end
    );
  end if;

  return v_job;
end;
$$;

revoke all on function public.claim_expired_brand_outputs(integer) from public, anon, authenticated;
revoke all on function public.complete_expired_brand_output(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.claim_expired_brand_outputs(integer) to service_role;
grant execute on function public.complete_expired_brand_output(uuid, uuid, boolean, text) to service_role;

-- Configure the project URL and publishable key in Vault for each environment;
-- README documents the two public values. Only the public API key is sent
-- through pg_net. The Edge Function accepts no
-- job IDs or paths and claims only rows whose server-set expiry is due; its
-- service-role access stays server-side.
create extension if not exists pg_net with schema extensions;

create or replace function private.invoke_brand_output_retention()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project_url text;
  v_publishable_key text;
  v_net_schema text;
begin
  select s.decrypted_secret into v_project_url
  from vault.decrypted_secrets s where s.name = 'muse_retention_project_url';
  select s.decrypted_secret into v_publishable_key
  from vault.decrypted_secrets s where s.name = 'muse_retention_publishable_key';
  -- Deliberate no-op until an administrator provisions Vault secrets.
  if nullif(v_project_url, '') is null
    or nullif(v_publishable_key, '') is null then
    return;
  end if;

  select n.nspname into v_net_schema
  from pg_catalog.pg_extension e
  join pg_catalog.pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pg_net';
  if v_net_schema is null then
    raise warning 'Brand output retention is not scheduled: pg_net is unavailable.';
    return;
  end if;

  execute pg_catalog.format(
    'select %I.http_post(url := $1, headers := $2, body := $3)', v_net_schema
  ) using
    pg_catalog.rtrim(v_project_url, '/') || '/functions/v1/expire-brand-outputs',
    pg_catalog.jsonb_build_object('Content-Type', 'application/json', 'apikey', v_publishable_key),
    pg_catalog.jsonb_build_object('source', 'pg_cron', 'scheduled_at', pg_catalog.now());
end;
$$;
revoke all on function private.invoke_brand_output_retention() from public, anon, authenticated;

do $$
declare existing_job record;
begin
  for existing_job in select jobid from cron.job where jobname = 'brand-output-retention' loop
    perform cron.unschedule(existing_job.jobid);
  end loop;
  perform cron.schedule(
    'brand-output-retention',
    '* * * * *',
    'select private.invoke_brand_output_retention();'
  );
end $$;

comment on column public.brand_jobs.output_expires_at is
  'Server-set expiry, 60 minutes after a new successful done transition; NULL legacy rows are not auto-deleted.';
comment on column public.brand_jobs.retention_status is
  'Storage cleanup state: active, deleting, expired, or delete_failed.';
