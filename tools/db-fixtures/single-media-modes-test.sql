\set ON_ERROR_STOP on
-- Disposable local Supabase acceptance DB only. Every change rolls back.
begin;
do $$ declare member uuid; other uuid; admin uuid; begin
 select id into member from public.profiles where email like 'muse-acceptance-%@example.test' and role='member' and approved order by email limit 1;
 select id into other from public.profiles where email like 'muse-acceptance-%@example.test' and role='member' and approved and id<>member limit 1;
 select id into admin from public.profiles where email like 'muse-acceptance-%@example.test' and role='admin' and approved limit 1;
 if member is null or other is null or admin is null then raise exception 'Local acceptance fixture accounts required'; end if;
 perform set_config('muse.test.member',member::text,true);perform set_config('muse.test.other',other::text,true);perform set_config('muse.test.admin',admin::text,true);
 perform set_config('request.jwt.claim.sub',member::text,true);
end $$;
set local role authenticated;
do $$ declare free public.brand_jobs; image public.brand_jobs; fixed public.brand_jobs; repeated public.brand_jobs; key uuid=extensions.gen_random_uuid(); begin
 free=public.submit_single_media_job(extensions.gen_random_uuid(),key,'Disposable media acceptance prompt','video_free',null);
 if free.status<>'queued' or free.scene_seconds is not null or free.reference_path is not null or jsonb_array_length(free.plan)<>1 then raise exception 'Free mode was coerced or required an image'; end if;
 repeated=public.submit_single_media_job(extensions.gen_random_uuid(),key,'Disposable media acceptance prompt','video_free',null);
 if repeated.id<>free.id then raise exception 'Duplicate request key created another job'; end if;
 repeated=public.submit_single_media_job(extensions.gen_random_uuid(),extensions.gen_random_uuid(),'Disposable media acceptance prompt','video_free',null);
 if repeated.id<>free.id then raise exception 'Repeated active prompt created another job'; end if;
 image=public.submit_single_media_job(extensions.gen_random_uuid(),extensions.gen_random_uuid(),'Disposable media acceptance prompt','image',null);
 if image.id=free.id or image.plan->0->>'action'<>'single_image_request' then raise exception 'Mode isolation failed'; end if;
 fixed=public.submit_single_media_job(extensions.gen_random_uuid(),extensions.gen_random_uuid(),'Disposable 10-second acceptance prompt','video_10s',repeat('a',64));
 if fixed.scene_seconds<>10 or fixed.status<>'uploading' or fixed.creation_mode<>'video_10s' then raise exception '10-second mode changed'; end if;
 begin
   perform public.submit_single_media_job(extensions.gen_random_uuid(),extensions.gen_random_uuid(),'Missing image acceptance prompt','video_10s',null);
   raise exception '10-second mode accepted missing reference';
 exception when raise_exception then if sqlerrm='10-second mode accepted missing reference' then raise; end if; end;
 begin
   perform public.submit_single_media_job(extensions.gen_random_uuid(),key,'Disposable media acceptance prompt','image',null);
   raise exception 'Cross-mode request key accepted';
 exception when raise_exception then if sqlerrm='Cross-mode request key accepted' then raise; end if; end;
 perform set_config('muse.test.free',free.id::text,true);perform set_config('muse.test.image',image.id::text,true);
 perform set_config('request.jwt.claim.sub',current_setting('muse.test.other'),true);
 if exists(select 1 from public.brand_jobs where id in (free.id,image.id)) then raise exception 'Member can see another member outputs'; end if;
 begin
  perform public.retry_single_media_job(free.id);raise exception 'Cross-owner retry accepted';
 exception when raise_exception then if sqlerrm='Cross-owner retry accepted' then raise; end if; end;
end $$;
reset role;
do $$ declare worker uuid=extensions.gen_random_uuid(); token uuid=extensions.gen_random_uuid(); claim uuid=extensions.gen_random_uuid(); job public.brand_jobs; result public.brand_jobs; result_path text; probe jsonb; begin
 perform set_config('request.jwt.claim.sub',current_setting('muse.test.admin'),true);
 insert into private.muse_worker_lease(resource,worker_id,token,expires_at) values('primary',worker,token,now()+interval '10 minutes')
 on conflict(resource) do update set worker_id=excluded.worker_id,token=excluded.token,expires_at=excluded.expires_at;
 for job in select * from public.brand_jobs where id in (current_setting('muse.test.free')::uuid,current_setting('muse.test.image')::uuid) loop
  update public.brand_jobs set status='generating',worker_id=worker,claim_token=claim,lease_expires_at=now()+interval '5 minutes' where id=job.id;
  result_path=job.user_id::text||'/'||job.id::text||'/'||claim::text||'/result.'||(case when job.creation_mode='image' then 'png' else 'mp4' end);
  probe=jsonb_build_object('kind',case when job.creation_mode='image' then 'image' else 'video' end,'width',1280,'height',720,'duration',case when job.creation_mode='image' then null else 30 end);
  insert into storage.objects(bucket_id,name,metadata) values('brand-videos',result_path,jsonb_build_object('mimetype',case when job.creation_mode='image' then 'image/png' else 'video/mp4' end));
  begin
   perform public.complete_single_media_job(job.id,worker,token,claim,replace(result_path,job.user_id::text,current_setting('muse.test.other')),repeat('b',64),probe);
   raise exception 'Cross-owner file accepted';
  exception when raise_exception then if sqlerrm='Cross-owner file accepted' then raise; end if; end;
  result=public.complete_single_media_job(job.id,worker,token,claim,result_path,repeat('b',64),probe);
  if result.status<>'done' or result.final_path<>result_path or result.output_expires_at is null or abs(extract(epoch from result.output_expires_at-clock_timestamp()-interval '60 minutes'))>2 then raise exception 'Output or 60-minute expiry was not committed'; end if;
  if not exists(select 1 from public.brand_scenes where job_id=job.id and status='done' and output_path=result_path) then raise exception 'Scene result was not committed atomically'; end if;
  if job.creation_mode='video_free' and (result.final_probe->>'duration')::numeric<>30 then raise exception 'Free duration was altered'; end if;
  result=public.complete_single_media_job(job.id,worker,token,claim,result_path,repeat('b',64),probe);
  if result.status<>'done' then raise exception 'Completion retry is not idempotent'; end if;
 end loop;
 if has_function_privilege('anon','public.submit_single_media_job(uuid,uuid,text,text,text)','execute') then raise exception 'Anonymous submission exposed'; end if;
end $$;
rollback;
select 'SINGLE_MEDIA_MODES_IDEMPOTENCY_OWNERSHIP_VALIDATION_AND_EXPIRY_OK' as result;
