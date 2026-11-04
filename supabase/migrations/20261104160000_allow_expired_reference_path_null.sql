-- A completed history row stays in Postgres after its temporary reference
-- image is deleted. Clearing the path is the tombstone that prevents the
-- scheduler from trying it again and prevents the UI from signing it again.
alter table public.brand_jobs alter column reference_path drop not null;
