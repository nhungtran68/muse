-- pg_net can register the extension itself in `extensions` while its HTTP
-- functions live in `net`. Resolve the actual extension-owned function rather
-- than assuming pg_extension.extnamespace is the function namespace.
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
  if nullif(v_project_url, '') is null
    or nullif(v_publishable_key, '') is null then
    return;
  end if;

  select n.nspname into v_net_schema
  from pg_catalog.pg_extension e
  join pg_catalog.pg_depend d
    on d.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
    and d.refobjid = e.oid and d.deptype = 'e'
    and d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
  join pg_catalog.pg_proc p on p.oid = d.objid
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where e.extname = 'pg_net' and p.proname = 'http_post'
    and p.prokind = 'f'
    and p.proargnames @> array['url','headers','body']::text[]
  order by p.oid
  limit 1;
  if v_net_schema is null then
    raise warning 'Brand output retention is not scheduled: pg_net http_post is unavailable.';
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
