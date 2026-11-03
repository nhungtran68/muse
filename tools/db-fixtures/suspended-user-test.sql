\set ON_ERROR_STOP on
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',false);
select (public.submit_brand_job_v2('cccccccc-0000-4000-8000-000000000001','33333333-0000-4000-8000-000000000001','Nội dung đang tải trước khi tạm khóa',1,10,repeat('4',64))).id;
insert into storage.objects(bucket_id,name) select 'brand-references',reference_path from public.brand_jobs where id='cccccccc-0000-4000-8000-000000000001';
reset role;
update public.profiles set approved=false where id='30000000-0000-4000-8000-000000000003';
set role authenticated;
do $$ begin
 begin perform public.queue_brand_job('cccccccc-0000-4000-8000-000000000001');raise exception 'suspended account accepted';
 exception when raise_exception then if sqlerrm='suspended account accepted' then raise;end if;end;
end $$;
reset role;
update public.profiles set approved=true where id='30000000-0000-4000-8000-000000000003';
select 'SUSPENDED_USER_TEST_OK' as result;
