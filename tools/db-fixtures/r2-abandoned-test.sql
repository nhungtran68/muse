\set ON_ERROR_STOP on
-- Disposable local acceptance database only. All records roll back.
begin;
do $$ declare owner_id uuid; other_id uuid; old_id uuid=extensions.gen_random_uuid(); live_id uuid=extensions.gen_random_uuid(); p text; begin
 select id into owner_id from public.profiles where email like 'muse-acceptance-%@example.test' and role='member' and approved order by email limit 1;
 select id into other_id from public.profiles where email like 'muse-acceptance-%@example.test' and role='member' and approved and id<>owner_id limit 1;
 if owner_id is null or other_id is null then raise exception 'Local fixture accounts required'; end if;
 update private.r2_media_settings set enabled=true where singleton;
 p=owner_id::text||'/'||old_id::text||'/reference';
 insert into public.brand_jobs(id,user_id,content,scene_count,scene_seconds,reference_path,schema_version,status)
 values(old_id,owner_id,'Abandoned reference fixture',1,10,p,2,'uploading'),
       (live_id,owner_id,'Still processing reference fixture',1,10,owner_id::text||'/'||live_id::text||'/reference',2,'uploading');
 perform set_config('request.jwt.claim.sub',other_id::text,true);
 if public.register_r2_upload(old_id,'brand-references',p) then raise exception 'Another account registered a reference'; end if;
 perform set_config('request.jwt.claim.sub',owner_id::text,true);
 if not public.register_r2_upload(old_id,'brand-references',p) then raise exception 'Owner could not register reference'; end if;
 if not public.register_r2_upload(live_id,'brand-references',owner_id::text||'/'||live_id::text||'/reference') then raise exception 'Owner could not register active reference'; end if;
 update private.r2_pending_uploads set uploaded_at=now()-interval '61 minutes' where job_id in(old_id,live_id);
 update public.brand_jobs set status='queued' where id=live_id;
 perform set_config('muse.test.abandoned',old_id::text,true);perform set_config('muse.test.live',live_id::text,true);
end $$;
do $$ declare c record; begin
 select * into c from public.claim_abandoned_r2_uploads(20) where job_id=current_setting('muse.test.abandoned')::uuid;
 if c.job_id is null then raise exception 'Expired abandoned upload not claimed'; end if;
 if exists(select 1 from private.r2_pending_uploads where job_id=current_setting('muse.test.live')::uuid and claim_token is not null) then raise exception 'Active job was interrupted'; end if;
 if public.authorize_r2_abandoned_expiry(c.job_id,extensions.gen_random_uuid(),c.bucket,array[c.object_path]) then raise exception 'Wrong token accepted'; end if;
 if public.authorize_r2_abandoned_expiry(c.job_id,c.claim_token,c.bucket,array[c.object_path||'-other']) then raise exception 'Wrong path accepted'; end if;
 if not public.authorize_r2_abandoned_expiry(c.job_id,c.claim_token,c.bucket,array[c.object_path]) then raise exception 'Expected claim rejected'; end if;
 begin update public.brand_jobs set status='queued' where id=c.job_id; raise exception 'Retry started during cleanup';
 exception when raise_exception then if sqlerrm='Retry started during cleanup' then raise; end if; end;
 if not public.complete_abandoned_r2_upload(c.job_id,c.claim_token,false) then raise exception 'Failure not recorded'; end if;
 if not exists(select 1 from private.r2_pending_uploads where job_id=c.job_id and attempts=1 and next_attempt_at>now() and claim_token is null) then raise exception 'Retry not scheduled'; end if;
 update private.r2_pending_uploads set next_attempt_at=now()-interval '1 second' where job_id=c.job_id;
 select * into c from public.claim_abandoned_r2_uploads(20) where job_id=current_setting('muse.test.abandoned')::uuid;
 if not public.complete_abandoned_r2_upload(c.job_id,c.claim_token,true) then raise exception 'Success not recorded'; end if;
 if exists(select 1 from private.r2_pending_uploads where job_id=c.job_id) then raise exception 'Cleaned upload still pending'; end if;
 if not exists(select 1 from public.brand_jobs where id=c.job_id and reference_expires_at<=now() and retention_status='active') then raise exception 'Expired reference not marked'; end if;
 begin update public.brand_jobs set status='queued' where id=c.job_id; raise exception 'Expired reference could be reused';
 exception when raise_exception then if sqlerrm='Expired reference could be reused' then raise; end if; end;
end $$;
rollback;
select 'R2_ABANDONED_UPLOAD_ISOLATION_RETRY_AND_EXPIRY_OK' as result;
