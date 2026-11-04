-- An active or completed scene must not expose the previous attempt's error.
-- Keep speech_audit and brand_job_events as the diagnostic history.
create function private.clear_brand_scene_error() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if new.status in ('generating','done') then
  new.error=null;
  new.error_code=null;
 end if;
 return new;
end $$;
revoke all on function private.clear_brand_scene_error() from public,anon,authenticated;

create trigger brand_scene_current_error
before insert or update on public.brand_scenes
for each row when (new.status in ('generating','done'))
execute function private.clear_brand_scene_error();

update public.brand_scenes s set error=null,error_code=null
where s.status in ('generating','done') and (s.error is not null or s.error_code is not null)
and exists(select 1 from public.brand_jobs j where j.id=s.job_id and j.schema_version=2);
