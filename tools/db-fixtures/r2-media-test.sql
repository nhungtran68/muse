\set ON_ERROR_STOP on
-- Run only against the local disposable acceptance database. All writes roll back.
begin;
do $$ declare member uuid; other uuid; administrator uuid; old_job uuid; expired_job uuid; token uuid=extensions.gen_random_uuid(); begin
 select id into member from public.profiles where email like 'muse-acceptance-%@example.test' and role='member' and approved order by email limit 1;
 select id into other from public.profiles where email like 'muse-acceptance-%@example.test' and role='member' and approved and id<>member limit 1;
 select id into administrator from public.profiles where email like 'muse-acceptance-%@example.test' and role='admin' and approved limit 1;
 if member is null or other is null or administrator is null then raise exception 'Local fixture accounts required'; end if;
 perform set_config('muse.test.owner',member::text,true);perform set_config('muse.test.other',other::text,true);perform set_config('request.jwt.claim.sub',member::text,true);
 perform set_config('muse.test.admin',administrator::text,true);
 old_job=extensions.gen_random_uuid();
 perform public.submit_single_media_job(old_job,extensions.gen_random_uuid(),'Local oversize R2 recovery fixture','video_free',null);
 if (select storage_provider from public.brand_jobs where id=old_job)<>'supabase' then raise exception 'Feature flag did not preserve legacy storage'; end if;
 update public.brand_jobs set status='error',error_code='MEDIA_TOO_LARGE',retryable=false,conversation_ref=jsonb_build_object('url','https://muse.ai/thread/12345678-1234-1234-1234-123456789abc') where id=old_job;
 update public.brand_scenes set status='generating',submission_state='sent',request_receipt=jsonb_build_object('key','RECEIPT_GEN_0') where job_id=old_job and scene_index=1;
 perform set_config('muse.test.old_job',old_job::text,true);
 update private.r2_media_settings set enabled=true where singleton;
 expired_job=extensions.gen_random_uuid();
 insert into public.brand_jobs(id,user_id,content,scene_count,scene_seconds,reference_path,schema_version,status,final_path,retention_status,retention_claimed_at,retention_claim_token)
 values(expired_job,member,'Local expiry authorization fixture',2,10,member::text||'/'||expired_job::text||'/reference',2,'done',member::text||'/'||expired_job::text||'/claim/final.mp4','deleting',now(),token);
 update public.brand_jobs set retention_status='deleting',retention_claimed_at=now(),retention_claim_token=token,output_expires_at=now()-interval '1 minute',reference_expires_at=now()-interval '1 minute' where id=expired_job;
 insert into public.brand_scenes(job_id,scene_index,prompt,status,output_path,output_expires_at)
 values(expired_job,1,'Expired scene','done',member::text||'/'||expired_job::text||'/claim/expired.mp4',now()-interval '1 minute'),
       (expired_job,2,'Still active scene','done',member::text||'/'||expired_job::text||'/claim/live.mp4',now()+interval '10 minutes');
 update public.brand_scenes set output_expires_at=case when scene_index=1 then now()-interval '1 minute' else now()+interval '10 minutes' end where job_id=expired_job;
 if (select storage_provider from public.brand_jobs where id=expired_job)<>'r2' then raise exception 'R2 feature flag did not apply to new jobs'; end if;
 perform set_config('muse.test.expired',expired_job::text,true);perform set_config('muse.test.claim',token::text,true);
end $$;
set local role authenticated;
do $$ declare item public.brand_jobs; owner uuid=current_setting('muse.test.owner')::uuid; begin
 perform set_config('request.jwt.claim.sub',current_setting('muse.test.other'),true);
 begin perform public.resume_oversize_job_in_r2(current_setting('muse.test.old_job')::uuid);raise exception 'Cross-account recovery accepted';
 exception when raise_exception then if sqlerrm='Cross-account recovery accepted' then raise; end if; end;
 perform set_config('request.jwt.claim.sub',owner::text,true);
 item=public.resume_oversize_job_in_r2(current_setting('muse.test.old_job')::uuid);
 if item.status<>'queued' or item.storage_provider<>'r2' or item.reference_storage_provider<>'supabase' then raise exception 'Recovery changed the old reference provider or did not queue R2'; end if;
 if not exists(select 1 from public.brand_scenes where job_id=item.id and generation=0 and request_receipt->>'key'='RECEIPT_GEN_0' and submission_state='sent') then raise exception 'Recovery lost the original Muse receipt'; end if;
 item=public.resume_oversize_job_in_r2(item.id);if item.status<>'queued' then raise exception 'Recovery is not idempotent'; end if;
end $$;
set local role anon;
do $$ declare job uuid=current_setting('muse.test.expired')::uuid; owner uuid=current_setting('muse.test.owner')::uuid; claim uuid=current_setting('muse.test.claim')::uuid; prefix text=owner::text||'/'||job::text||'/'; begin
 if public.authorize_r2_expiry(job,extensions.gen_random_uuid(),'brand-videos',array[prefix||'claim/final.mp4']) then raise exception 'Wrong cleanup claim accepted'; end if;
 if not public.authorize_r2_expiry(job,claim,'brand-videos',array[prefix||'claim/final.mp4',prefix||'claim/expired.mp4']) then raise exception 'Expired files rejected'; end if;
 if public.authorize_r2_expiry(job,claim,'brand-videos',array[prefix||'claim/live.mp4']) then raise exception 'Unexpired file accepted'; end if;
 if public.authorize_r2_expiry(job,claim,'brand-videos',array['another-user/another-job/file.mp4']) then raise exception 'Another job file accepted'; end if;
 if public.authorize_r2_expiry(job,claim,null,array[prefix||'claim/final.mp4']) then raise exception 'Null bucket accepted'; end if;
 if not public.authorize_r2_expiry(job,claim,'brand-references',array[prefix||'reference']) then raise exception 'Expired reference rejected'; end if;
 if has_function_privilege('anon','public.resume_oversize_job_in_r2(uuid)','execute') then raise exception 'Anonymous recovery exposed'; end if;
end $$;
reset role;
do $$ declare worker uuid=extensions.gen_random_uuid(); token uuid=extensions.gen_random_uuid(); legacy uuid=extensions.gen_random_uuid(); item public.brand_jobs; begin
 perform set_config('request.jwt.claim.sub',current_setting('muse.test.admin'),true);
 -- Isolate local fixture queues inside this rolled-back transaction.
 update public.brand_jobs set status='error' where status in ('queued','script_queued','video_queued','planning','generating','joining') and id<>current_setting('muse.test.old_job')::uuid;
 insert into private.muse_worker_lease(resource,worker_id,token,expires_at) values('primary',worker,token,now()+interval '10 minutes')
 on conflict(resource) do update set worker_id=excluded.worker_id,token=excluded.token,expires_at=excluded.expires_at;
 update private.r2_media_settings set enabled=false where singleton;
 insert into public.brand_jobs(id,user_id,content,scene_count,scene_seconds,schema_version,status,created_at)
 values(legacy,current_setting('muse.test.owner')::uuid,'Legacy job compatibility fixture',1,10,2,'queued',now()-interval '1 day');
 item=public.claim_brand_job_v2(worker,token);if item.id is distinct from legacy then raise exception 'An old worker could not claim a legacy Supabase job'; end if;
 update public.brand_jobs set status='error' where id=legacy;
 item=public.claim_brand_job_v2(worker,token);if item.id is not null then raise exception 'An unregistered worker claimed an R2 job'; end if;
 if not public.register_r2_worker(worker,token) then raise exception 'R2 capability registration failed'; end if;
 item=public.claim_brand_job_v2(worker,token);if item.id is distinct from current_setting('muse.test.old_job')::uuid then raise exception 'Registered worker did not claim the R2 job'; end if;
end $$;
rollback;
select 'R2_FLAG_OWNERSHIP_RECEIPT_EXPIRY_AND_WORKER_COMPATIBILITY_OK' as result;
