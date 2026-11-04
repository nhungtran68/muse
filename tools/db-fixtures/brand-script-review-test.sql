\set ON_ERROR_STOP on
-- Disposable acceptance database only; all fixtures are rolled back.
begin;
update public.app_settings set enabled=true,max_scenes=4,daily_limit=30 where id=true;
update public.video_modes set enabled=true where seconds=10;
set role authenticated;
select set_config('request.jwt.claim.sub','e2f83e79-0133-4c73-9ddf-7ca7fac01b0d',false);
do $$
declare a public.brand_jobs%rowtype; duplicate public.brand_jobs%rowtype;
begin
 a=public.submit_brand_job_v3('90000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000001','Giới thiệu thương hiệu một bằng lời thật',2,repeat('a',64),false);
 duplicate=public.submit_brand_job_v3('90000000-0000-4000-8000-000000000002','91000000-0000-4000-8000-000000000002','Giới thiệu thương hiệu một bằng lời thật',2,repeat('a',64),false);
 if a.id<>duplicate.id then raise exception 'Duplicate script request created another job'; end if;
 insert into storage.objects(bucket_id,name) values('brand-references',a.reference_path);
 a=public.queue_brand_job(a.id);
 if a.status<>'script_queued' or a.scene_count<>2 or a.scene_seconds<>10 then raise exception 'Script was queued for video or duration changed'; end if;
end $$;

select set_config('request.jwt.claim.sub','3cda2513-82f4-4b80-9918-41f42d8839fb',false);
do $$
declare b public.brand_jobs%rowtype;
begin
 if exists(select 1 from public.brand_jobs where id='90000000-0000-4000-8000-000000000001') then raise exception 'Other member can read first script'; end if;
 b=public.submit_brand_job_v3('90000000-0000-4000-8000-000000000003','91000000-0000-4000-8000-000000000003','Giới thiệu thương hiệu hai bằng lời riêng',3,repeat('b',64),false);
 insert into storage.objects(bucket_id,name) values('brand-references',b.reference_path);
 b=public.queue_brand_job(b.id);
 if b.status<>'script_queued' or b.scene_count<>3 then raise exception 'Second member script count changed'; end if;
end $$;

select set_config('request.jwt.claim.sub','5e11b2b4-496e-4ac0-9c3c-1f83f69b8d00',false);
do $$
declare worker uuid='92000000-0000-4000-8000-000000000001'; token uuid; lease jsonb;
 a public.brand_jobs%rowtype; b public.brand_jobs%rowtype; blocked public.brand_jobs%rowtype;
begin
 lease=public.acquire_muse_worker(worker);token=(lease->>'token')::uuid;
 a=public.claim_brand_job_v3(worker,token);
 if a.id<>'90000000-0000-4000-8000-000000000001' or a.status<>'planning' then raise exception 'Wrong first script claim'; end if;
 blocked=public.claim_brand_job_v3(worker,token);
 if blocked.id is not null then raise exception 'Concurrent Muse claim allowed'; end if;
 a=public.complete_brand_script_v3(a.id,worker,token,a.claim_token,
  jsonb_build_array(
   jsonb_build_object('index',1,'seconds',10,'prompt','Same person and background','dialogue','Xin chào, đây là lời đầu của thành viên một, xin mời mọi người cùng lắng nghe câu chuyện của mình nha.','source_quotes',jsonb_build_array('Giới thiệu thương hiệu một')),
   jsonb_build_object('index',2,'seconds',10,'prompt','Same person and background','dialogue','Ở đoạn kế tiếp, mình tiếp tục câu chuyện bằng những lời gần gũi, rồi cảm ơn mọi người đã lắng nghe.','source_quotes',jsonb_build_array('Giới thiệu thương hiệu một'))),
  '{}'::jsonb,'Mở đầu rồi kết thúc');
 if a.status<>'script_ready' or a.script_revision<>1 or a.worker_id is not null then raise exception 'Script did not stop for customer review'; end if;
 if exists(select 1 from public.brand_scenes where job_id=a.id) then raise exception 'Video scenes created before customer approval'; end if;
 b=public.claim_brand_job_v3(worker,token);
 if b.id<>'90000000-0000-4000-8000-000000000003' then raise exception 'Second script not claimed after first review'; end if;
 b=public.complete_brand_script_v3(b.id,worker,token,b.claim_token,
  jsonb_build_array(
   jsonb_build_object('index',1,'seconds',10,'prompt','Same person','dialogue','Xin chào, đây là lời mở đầu riêng của thành viên hai, được chia thành ba đoạn nói tự nhiên và liền mạch.'),
   jsonb_build_object('index',2,'seconds',10,'prompt','Same person','dialogue','Đoạn thứ hai tiếp nối đúng chủ đề ban đầu, vẫn một nhân vật và bối cảnh như hình ảnh đã gửi.'),
   jsonb_build_object('index',3,'seconds',10,'prompt','Same person','dialogue','Cuối cùng, mình cảm ơn mọi người đã lắng nghe câu chuyện này và hẹn gặp lại trong những chia sẻ sau.')),
  '{}'::jsonb,'Ba phần liền mạch');
 if b.status<>'script_ready' or b.scene_count<>3 then raise exception 'Second member script invalid'; end if;
 perform public.release_muse_worker(worker,token);
end $$;

select set_config('request.jwt.claim.sub','e2f83e79-0133-4c73-9ddf-7ca7fac01b0d',false);
do $$
declare a public.brand_jobs%rowtype; edited jsonb=jsonb_build_array(
 'Xin chào, lời đầu này đã được khách chỉnh sửa chính xác, mình mong mọi người cùng nghe câu chuyện riêng của mình nha.',
 'Đây là lời thứ hai cũng do khách chỉnh sửa, mình cảm ơn mọi người đã dành thời gian lắng nghe thật trọn vẹn.');
begin
 begin
  perform public.commit_brand_script_v3('90000000-0000-4000-8000-000000000001',1,2,'["", "lời khác"]'::jsonb,true);
  raise exception 'EMPTY_DIALOGUE_ACCEPTED';
 exception when raise_exception then if sqlerrm='EMPTY_DIALOGUE_ACCEPTED' then raise; end if; end;
 begin
  perform public.commit_brand_script_v3('90000000-0000-4000-8000-000000000001',1,3,edited,true);
  raise exception 'SCENE_COUNT_MISMATCH_ACCEPTED';
 exception when raise_exception then if sqlerrm='SCENE_COUNT_MISMATCH_ACCEPTED' then raise; end if; end;
 a=public.commit_brand_script_v3('90000000-0000-4000-8000-000000000001',1,2,edited,false);
 if a.status<>'script_ready' or a.script_revision<>2 or a.plan->0->>'dialogue'<>edited->>0 then raise exception 'Customer draft not saved exactly'; end if;
 a=public.commit_brand_script_v3('90000000-0000-4000-8000-000000000001',2,2,edited,true);
 if a.status<>'video_queued' or a.scene_count*10<>20 or a.video_prompt_version<>'brand-video-10s-v1' then raise exception 'Video approval not queued correctly'; end if;
 if (select count(*) from public.brand_scenes where job_id=a.id)<>2 or
    (select dialogue from public.brand_scenes where job_id=a.id and scene_index=1)<>edited->>0 then raise exception 'Approved exact dialogue not copied to scenes'; end if;
 a=public.commit_brand_script_v3('90000000-0000-4000-8000-000000000001',2,2,edited,true);
 if a.status<>'video_queued' or (select count(*) from public.brand_job_events where job_id=a.id and status='video_queued')<>1 then raise exception 'Double click created duplicate video job'; end if;
end $$;

select set_config('request.jwt.claim.sub','3cda2513-82f4-4b80-9918-41f42d8839fb',false);
do $$
declare b public.brand_jobs%rowtype; lines jsonb='["Đoạn một của khách hai được giữ nguyên khi duyệt, cùng một nhân vật và đúng một hình ảnh tham chiếu ban đầu.","Đoạn hai của khách hai nối tiếp câu chuyện, với lời thoại khác hoàn toàn và không sử dụng bất cứ dữ liệu của khách một.","Đoạn ba của khách hai khép lại tự nhiên, cảm ơn mọi người đã dành thời gian nghe mình chia sẻ hôm nay."]'::jsonb;
begin
 if exists(select 1 from public.brand_jobs where id='90000000-0000-4000-8000-000000000001') then raise exception 'Other member can read first approved video'; end if;
 begin
  perform public.commit_brand_script_v3('90000000-0000-4000-8000-000000000001',2,2,lines,true);
  raise exception 'CROSS_USER_EDIT_ACCEPTED';
 exception when raise_exception then if sqlerrm='CROSS_USER_EDIT_ACCEPTED' then raise; end if; end;
 b=public.commit_brand_script_v3('90000000-0000-4000-8000-000000000003',1,3,lines,true);
 if b.status<>'video_queued' or b.scene_count*10<>30 or (select count(*) from public.brand_scenes where job_id=b.id)<>3 then raise exception 'Three-segment approval failed'; end if;
 if exists(select 1 from public.brand_scenes where job_id='90000000-0000-4000-8000-000000000001') then raise exception 'Other member can see first member scenes'; end if;
end $$;
rollback;
select 'BRAND_SCRIPT_REVIEW_TWO_MEMBERS_TWO_DURATIONS_OK' as result;
