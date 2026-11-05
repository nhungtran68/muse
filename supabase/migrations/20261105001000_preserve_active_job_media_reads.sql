-- The worker authenticates as an approved administrator. It must still be
-- able to fetch a previously completed scene while a long-running or resumed
-- job is assembling later scenes. Members keep their normal per-file expiry;
-- completed jobs never receive this operational access exception.
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
            and (
              s.output_expires_at is null
              or s.output_expires_at > pg_catalog.now()
              or (j.status <> 'done' and (select public.is_admin()))
            )
        )
      )
  )
);
