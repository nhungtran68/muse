# Brand output retention

This scheduled function deletes each final or scene video 60 minutes after
the server records that file's Storage path. The temporary reference image is
kept through generation, then deleted 60 minutes after the job succeeds.
Expiry is tracked per file so an early scene does not extend past its own
window or shorten the window for a later scene. Deletion uses
`storage.from(bucket).remove(paths)`; it never deletes from `storage.objects`
with SQL.

This cleanup covers files managed in this project's Supabase buckets. It does
not delete Muse.ai conversation history or remote provider-side copies; no
verified Muse deletion API is integrated in this application.

## Configuration

1. Deploy this function with `supabase functions deploy expire-brand-outputs`.
   JWT verification is disabled. The gateway receives only the project's
   public API key and the function has no caller-controlled job/path input.
2. Apply `20261104120000_brand_output_retention.sql` and
   `20261104150000_brand_asset_individual_expiry.sql`, then
   `20261104160000_allow_expired_reference_path_null.sql`. They schedule Cron
   and do not backfill existing history.
3. Add this environment's public project URL and publishable key to Vault once
   (for example, in the Supabase SQL editor):

   ```sql
   select vault.create_secret('https://<project-ref>.supabase.co', 'muse_retention_project_url');
   select vault.create_secret('<publishable-key>', 'muse_retention_publishable_key');
   ```

   These are public values. Use the URL and key configured for the same
   environment as this Edge Function. The scheduled call stays idle until both
   Vault entries exist. Do not place a service-role key in `pg_net` headers.

If the Vercel deployment overrides the project URL or publishable key through
environment variables, update the matching Vault value after applying the
migration. The Cron runs once a minute and sends only the public API key, not a
service credential.
The Edge Function uses its runtime `SUPABASE_SERVICE_ROLE_KEY` to make Storage
API calls and invoke the restricted claim/completion RPCs. Anyone with the public
key can trigger a run, but cannot choose targets or bypass the database expiry
condition; the response contains counts only.

## Retry and recovery

The database claims jobs with `FOR UPDATE SKIP LOCKED` and a per-claim token,
returning only files whose individual expiry has passed. Overlapping
invocations cannot claim the same live lease. A `deleting` claim that remains
for 15 minutes can be reclaimed; the token fences out completion from the
stale invocation. Failed API calls retry after 1, 5, 15, and 60 minutes, for
at most five claims per cleanup batch. A fifth failure remains `delete_failed`
and is not silently marked expired. The safe generic error is stored on the
job and detailed Storage diagnostics are available in Edge Function logs.

Because deleting Storage objects and committing Postgres metadata are separate
transactions, the function may retry an already removed object if the RPC
completion fails. The Storage `remove` call is safe to repeat; the database
claim token prevents an old request from overwriting a newer claim.

## Rollback

To stop future cleanup, unschedule the `brand-output-retention` Cron job and
disable or remove this Edge Function. Keep the retention columns and Storage
read policies: they record which files were deleted and prevent links from
working after expiry. Files that a successful cleanup already deleted cannot
be restored by rolling back. The migrations do not delete existing files or
backfill existing history; newly stored outputs enter their own 60-minute
window. Do not drop `pg_net` or Vault secrets if other project features use them.
