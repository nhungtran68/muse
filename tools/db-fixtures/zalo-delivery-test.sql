do $$
declare
  administrator uuid;
  member uuid;
  video uuid := extensions.gen_random_uuid();
  customer_video uuid := extensions.gen_random_uuid();
  old_video uuid := extensions.gen_random_uuid();
  worker uuid := extensions.gen_random_uuid();
  lease uuid;
  receipt jsonb;
  r2 boolean;
begin
  select id into strict administrator from public.profiles
  where role='admin' and approved and email like 'muse-acceptance-%@example.test' limit 1;
  select id into strict member from public.profiles
  where role='member' and approved and email like 'muse-acceptance-%@example.test' limit 1;
  select enabled into strict r2 from private.r2_media_settings where singleton;
  perform set_config('request.jwt.claim.sub',member::text,true);
  begin
    perform public.set_zalo_delivery(true,'123456');
    raise exception 'Member wrote Zalo settings';
  exception when raise_exception then
    if sqlerrm <> 'ADMIN_REQUIRED' then raise; end if;
  end;
  begin
    perform public.set_video_storage(not r2);
    raise exception 'Member wrote R2 settings';
  exception when raise_exception then
    if sqlerrm <> 'ADMIN_REQUIRED' then raise; end if;
  end;
  perform set_config('request.jwt.claim.sub',administrator::text,true);
  if (public.get_video_delivery_settings()->>'zalo')::boolean then raise exception 'Zalo default must be off'; end if;
  perform public.set_video_storage(not r2);
  if (public.get_video_delivery_settings()->>'r2')::boolean is distinct from (not r2)
    then raise exception 'R2 setting was not saved'; end if;
  perform public.set_zalo_delivery(true,'123456');
  insert into public.brand_jobs(id,user_id,content,scene_count,scene_seconds,status,created_at)
  values(video,administrator,'Acceptance fixture admin video',1,10,'generating',now()),
        (customer_video,member,'Acceptance fixture customer video',1,10,'generating',now()),
        (old_video,administrator,'Acceptance fixture old video',1,10,'generating',now()-interval '1 hour');
  update public.brand_jobs set status='done', final_path=user_id::text||'/'||id::text||'/final.mp4'
  where id in (video,customer_video,old_video);
  if (select count(*) from private.zalo_deliveries)<>1 then raise exception 'Queue owner or activation scope wrong'; end if;
  update private.muse_worker_lease set expires_at=now()-interval '1 second' where resource='primary';
  select (public.acquire_muse_worker(worker)->>'token')::uuid into lease;
  receipt := public.claim_zalo_delivery(worker,lease);
  if receipt->>'id' is distinct from video::text then raise exception 'First claim did not return the expected video'; end if;
  if receipt->>'group_id' is distinct from '123456' then raise exception 'Incorrect destination'; end if;
  if public.claim_zalo_delivery(worker,lease) is not null then raise exception 'Duplicate claim'; end if;
  if not public.finish_zalo_delivery(video,(receipt->>'claim')::uuid,'sent','fixture-receipt')
    then raise exception 'Receipt did not persist'; end if;
  if public.finish_zalo_delivery(video,(receipt->>'claim')::uuid,'failed','late')
    then raise exception 'Receipt allowed overwrite'; end if;
  perform public.set_zalo_delivery(false,null);
  if (public.get_video_delivery_settings()->>'zalo')::boolean then raise exception 'Zalo was not disabled'; end if;
end $$;
select 'ZALO_ADMIN_ONLY_R2_FIRST_CLAIM_DEDUPLICATION_AND_RECEIPT_OK' as result;
