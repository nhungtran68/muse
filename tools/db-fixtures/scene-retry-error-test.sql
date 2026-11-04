\set ON_ERROR_STOP on
-- Use only the separate local Supabase acceptance database; leave no fixtures.
begin;
do $$
declare member uuid; job uuid=extensions.gen_random_uuid(); previous_audit jsonb='{"ok":false,"reason":"CUT_OFF_SPEECH"}'; receipt jsonb='{"key":"LOCAL_RETRY_ERROR_FIXTURE"}';
begin
 select id into member from public.profiles where email like 'muse-acceptance-%@example.test' and role='member' limit 1;
 if member is null then raise exception 'Disposable local fixture member required'; end if;
 insert into public.brand_jobs(id,user_id,content,scene_count,scene_seconds,reference_path,schema_version,status)
 values(job,member,'Local retry scene error fixture',1,10,member::text||'/'||job::text||'/reference',2,'generating');
 insert into public.brand_scenes(job_id,scene_index,prompt,status,error_code,error,speech_audit,request_receipt)
 values(job,1,'Local retry fixture prompt','error','CUT_OFF_SPEECH','Previous attempt failed',previous_audit,receipt);
 update public.brand_scenes set status='generating' where job_id=job;
 if not exists(select 1 from public.brand_scenes where job_id=job and status='generating' and error is null and error_code is null and speech_audit=previous_audit and request_receipt=receipt) then raise exception 'Retry retained current error or lost receipt/audit'; end if;
 update public.brand_scenes set status='error',error_code='SPEECH_TOO_SHORT',error='New failure' where job_id=job;
 if not exists(select 1 from public.brand_scenes where job_id=job and error_code='SPEECH_TOO_SHORT' and error='New failure') then raise exception 'Real current failure was cleared'; end if;
 update public.brand_scenes set status='done',speech_audit='{"ok":true}' where job_id=job;
 if not exists(select 1 from public.brand_scenes where job_id=job and status='done' and error is null and error_code is null and speech_audit='{"ok":true}' and request_receipt=receipt) then raise exception 'Completed scene retained a stale error'; end if;
 if has_function_privilege('authenticated','private.clear_brand_scene_error()','EXECUTE') or has_function_privilege('anon','private.clear_brand_scene_error()','EXECUTE') then raise exception 'Trigger function was exposed to clients'; end if;
end $$;
rollback;
select 'SCENE_RETRY_ERROR_RECEIPT_AND_AUDIT_OK' as result;
