\set ON_ERROR_STOP on
begin;
update public.app_settings set enabled=true,max_scenes=4 where id=true;
update public.video_modes set enabled=true where seconds=10;
insert into public.brand_jobs(id,user_id,content,scene_count,scene_seconds,reference_path,
 schema_version,reference_sha256,status,workflow_phase,script_revision,plan)
values('90000000-0000-4000-8000-000000000004','e2f83e79-0133-4c73-9ddf-7ca7fac01b0d',
 'Giới thiệu một thương hiệu bằng bốn đoạn',2,10,
 'e2f83e79-0133-4c73-9ddf-7ca7fac01b0d/90000000-0000-4000-8000-000000000004/reference',
 3,repeat('c',64),'script_ready','script',1,
 '[{"index":1,"seconds":10,"prompt":"same person","dialogue":"Lời cũ một"},{"index":2,"seconds":10,"prompt":"same person","dialogue":"Lời cũ hai"}]'::jsonb);
insert into storage.objects(bucket_id,name) values('brand-references',
 'e2f83e79-0133-4c73-9ddf-7ca7fac01b0d/90000000-0000-4000-8000-000000000004/reference');
set role authenticated;
select set_config('request.jwt.claim.sub','e2f83e79-0133-4c73-9ddf-7ca7fac01b0d',false);
do $$
declare j public.brand_jobs%rowtype;
begin
 begin
  perform public.commit_brand_script_v3('90000000-0000-4000-8000-000000000004',null,2,'["Lời một","Lời hai"]',true);
  raise exception 'NULL_REVISION_ACCEPTED';
 exception when raise_exception then if sqlerrm='NULL_REVISION_ACCEPTED' then raise; end if; end;
 j=public.replan_brand_script_v3('90000000-0000-4000-8000-000000000004',1,4);
 if j.status<>'script_queued' or j.scene_count<>4 or j.script_revision<>2 or j.plan<>'[]'::jsonb or j.input_hash is null then raise exception 'Old two-segment script was not invalidated'; end if;
 if exists(select 1 from public.brand_scenes where job_id=j.id) then raise exception 'Video scenes appeared during replan'; end if;
 begin
  perform public.commit_brand_script_v3(j.id,2,2,'["Lời một","Lời hai"]',true);
  raise exception 'STALE_COUNT_APPROVED';
 exception when raise_exception then if sqlerrm='STALE_COUNT_APPROVED' then raise; end if; end;
end $$;
select set_config('request.jwt.claim.sub','5e11b2b4-496e-4ac0-9c3c-1f83f69b8d00',false);
do $$
declare j public.brand_jobs%rowtype; worker uuid='92000000-0000-4000-8000-000000000002'; token uuid;
begin
 token=(public.acquire_muse_worker(worker)->>'token')::uuid;
 j=public.claim_brand_job_v3(worker,token);
 if j.id<>'90000000-0000-4000-8000-000000000004' or j.scene_count<>4 then raise exception 'Replanned job was not claimed with four segments'; end if;
 j=public.complete_brand_script_v3(j.id,worker,token,j.claim_token,
  jsonb_build_array(
   jsonb_build_object('index',1,'seconds',10,'prompt','same','dialogue','Đoạn mới một'),
   jsonb_build_object('index',2,'seconds',10,'prompt','same','dialogue','Đoạn mới hai'),
   jsonb_build_object('index',3,'seconds',10,'prompt','same','dialogue','Đoạn mới ba'),
   jsonb_build_object('index',4,'seconds',10,'prompt','same','dialogue','Đoạn mới bốn')),
  '{}'::jsonb,'Bốn đoạn mới');
 if j.status<>'script_ready' or j.script_revision<>3 then raise exception 'Replanned script did not return for review'; end if;
 perform public.release_muse_worker(worker,token);
end $$;
select set_config('request.jwt.claim.sub','e2f83e79-0133-4c73-9ddf-7ca7fac01b0d',false);
do $$
declare j public.brand_jobs%rowtype;
begin
 j=public.commit_brand_script_v3('90000000-0000-4000-8000-000000000004',3,4,
  '["Đoạn một sau khi sửa của khách, mình nói chậm rãi và giữ nguyên ý chính của câu chuyện ban đầu nha.","Đoạn hai sau khi sửa của khách, câu chuyện tiếp tục liền mạch và vẫn cùng một người đang nói trước camera.","Đoạn ba sau khi sửa của khách, mình kể thêm một ý khác mà không tự bịa bất cứ thông tin nào.","Đoạn bốn sau khi sửa của khách, mình kết thúc tự nhiên và cảm ơn mọi người đã ở lại lắng nghe."]'::jsonb,true);
 if j.status<>'video_queued' or j.scene_count*10<>40 or (select count(*) from public.brand_scenes where job_id=j.id)<>4 then raise exception 'Replanned four-segment video not queued'; end if;
end $$;
rollback;
select 'BRAND_SCRIPT_REPLAN_FOUR_SEGMENTS_OK' as result;
