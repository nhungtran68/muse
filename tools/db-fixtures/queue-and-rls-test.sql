\set ON_ERROR_STOP on
insert into auth.users(id,email,email_confirmed_at) values
 ('10000000-0000-4000-8000-000000000001','admin@example.test',now()),
 ('20000000-0000-4000-8000-000000000002','first@example.test',now()),
 ('30000000-0000-4000-8000-000000000003','second@example.test',now());
update public.profiles set approved=true,role=case when email='admin@example.test' then 'admin' else 'member' end;
update public.app_settings set enabled=true,daily_limit=30,max_scenes=8 where id=true;
set role authenticated;
select set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000002',false);
do $$
declare a public.brand_jobs; b public.brand_jobs;
begin
 a=public.submit_brand_job_v2('aaaaaaaa-0000-4000-8000-000000000001','11111111-0000-4000-8000-000000000001','Một nội dung thứ nhất đủ dài',2,10,repeat('1',64));
 b=public.submit_brand_job_v2('aaaaaaaa-0000-4000-8000-000000000002','11111111-0000-4000-8000-000000000002','Một nội dung thứ nhất đủ dài',2,10,repeat('1',64));
 if a.id<>b.id then raise exception 'active duplicate created'; end if;
 b=public.submit_brand_job_v2('aaaaaaaa-0000-4000-8000-000000000003','11111111-0000-4000-8000-000000000003','Một nội dung khác đủ dài',1,10,repeat('2',64));
 if a.id=b.id then raise exception 'distinct request collapsed'; end if;
end $$;
insert into storage.objects(bucket_id,name) select 'brand-references',reference_path from public.brand_jobs;
select public.queue_brand_job('aaaaaaaa-0000-4000-8000-000000000001');
select public.queue_brand_job('aaaaaaaa-0000-4000-8000-000000000003');
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',false);
do $$
declare n integer;
begin
 select count(*) into n from public.brand_jobs;if n<>0 then raise exception 'cross-user jobs visible';end if;
 select count(*) into n from storage.objects;if n<>0 then raise exception 'cross-user reference visible';end if;
 perform public.submit_brand_job_v2('bbbbbbbb-0000-4000-8000-000000000001','22222222-0000-4000-8000-000000000001','Một nội dung của khách thứ hai',1,10,repeat('3',64));
 begin perform public.queue_brand_job('aaaaaaaa-0000-4000-8000-000000000001');raise exception 'cross-user queue allowed';exception when raise_exception then if sqlerrm='cross-user queue allowed' then raise;end if;end;
end $$;
insert into storage.objects(bucket_id,name) select 'brand-references',reference_path from public.brand_jobs;
select public.queue_brand_job('bbbbbbbb-0000-4000-8000-000000000001');
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
do $$
declare l jsonb; other jsonb; first_job public.brand_jobs; second_job public.brand_jobs; worker uuid='44444444-0000-4000-8000-000000000001'; token uuid;
begin
 l=public.acquire_muse_worker(worker);token=(l->>'token')::uuid;
 other=public.acquire_muse_worker('44444444-0000-4000-8000-000000000002');if other is not null then raise exception 'two workers acquired same resource';end if;
 first_job=public.claim_brand_job_v2(worker,token);if first_job.id is null then raise exception 'missing first job';end if;
 second_job=public.claim_brand_job_v2(worker,token);if second_job.id is not null then raise exception 'multiple active jobs';end if;
 perform public.update_brand_job_v2(first_job.id,worker,token,first_job.claim_token,'{"status":"error","error":"test error","retryable":true}');
 second_job=public.claim_brand_job_v2(worker,token);if second_job.id is null or second_job.id=first_job.id then raise exception 'error blocks queue';end if;
 begin perform public.update_brand_job_v2(second_job.id,worker,token,'ffffffff-0000-4000-8000-000000000001','{"status":"error"}');raise exception 'bad claim accepted';exception when raise_exception then if sqlerrm='bad claim accepted' then raise;end if;end;
 perform public.update_brand_job_v2(second_job.id,worker,token,second_job.claim_token,'{"status":"error","error":"second test error"}');
 perform public.release_muse_worker(worker,token);
end $$;
select set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000002',false);
do $$
declare n integer; j public.brand_jobs;
begin
 select count(*) into n from public.brand_jobs;if n<>2 then raise exception 'wrong owner history count %',n;end if;
 if has_table_privilege('authenticated','public.brand_jobs','UPDATE') then raise exception 'member has direct write access';end if;
 select * into j from public.brand_jobs where status='error' limit 1;
 if j.id is not null then perform public.retry_brand_job(j.id);end if;
end $$;
select 'QUEUE_AND_RLS_TEST_OK' as result;
