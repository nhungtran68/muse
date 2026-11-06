# Private R2 storage rollout

New media can be stored in the private `muse-studio-media` R2 bucket. Existing
jobs remain in Supabase Storage; their paths, access rules and cleanup are not
migrated. R2 uploads and downloads go directly between the client/worker and R2
using short-lived signed URLs. Vercel receives only metadata, checks the current
Supabase session and the exact job, and never proxies the media bytes. The server
limit is 100 MiB for results and 10 MiB for reference images.

Deploy the database migrations with the R2 feature flag disabled, then the media
gateway and the retention function. Install worker 3.2.0 or later and confirm its
registered worker ID owns the Muse lease before enabling new R2 jobs. Existing
workers may continue old Supabase jobs but are not allowed to claim R2 jobs.
The browser can recover an existing oversized free-video result only when a
matching Muse receipt is already recorded; recovery polls that same request.

Server-side retention removes completed files through the R2 API after their
recorded expiry. Abandoned uploads are registered before signing and are
separately cleaned after 60 minutes once the job is no longer active. Deletion
is retried up to five times; failures stay recorded for an administrator. A
zero-byte Supabase marker preserves existing queue and ownership checks; it is
not a copy of the media. Expiration does not assert removal from Muse itself.

Required Vercel environment variables: `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, plus the existing Supabase URL and
publishable key. The R2 key must be restricted to this bucket; do not commit it.
The optional smoke test reads temporary credentials from stdin, writes a unique
100 MiB object, verifies the downloaded hash, then deletes only that test object.

## Rollback

Set `private.r2_media_settings.enabled` to false for **new jobs only**. Keep the
R2 gateway, credentials, cleanup function and compatible worker available until
all existing R2 jobs and files have expired. Reverting the website or deleting
the bucket immediately would make those files inaccessible. The additive schema
and legacy Supabase files may safely remain in place.
