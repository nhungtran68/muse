\set ON_ERROR_STOP on
-- Run only against the disposable local acceptance database.
begin;
delete from private.muse_control_device;
do $$ declare admin uuid; member uuid; begin
 select id into admin from public.profiles where role='admin' and approved limit 1;
 select id into member from public.profiles where role='member' and approved limit 1;
 if admin is null or member is null then raise exception 'Local fixture accounts required'; end if;
 perform set_config('muse.test.admin',admin::text,true);
 perform set_config('muse.test.member',member::text,true);
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub',current_setting('muse.test.member'),true);
do $$ begin
 begin perform public.muse_control_status();raise exception 'member read allowed';exception when raise_exception then if sqlerrm='member read allowed' then raise;end if;end;
 begin perform public.muse_control_start();raise exception 'member start allowed';exception when raise_exception then if sqlerrm='member start allowed' then raise;end if;end;
 begin perform public.muse_control_enroll('11111111-1111-4111-8111-111111111111',repeat('1',64));raise exception 'member enroll allowed';exception when raise_exception then if sqlerrm='member enroll allowed' then raise;end if;end;
end $$;
select set_config('request.jwt.claim.sub',current_setting('muse.test.admin'),true);
select public.muse_control_enroll('11111111-1111-4111-8111-111111111111',encode(sha256(convert_to(repeat('a',64),'UTF8')),'hex'));
do $$ begin
 if (public.muse_control_status()->>'paired')::boolean is not true then raise exception 'device missing';end if;
 begin perform public.muse_control_start();raise exception 'offline start allowed';exception when raise_exception then if sqlerrm='offline start allowed' then raise;end if;end;
end $$;
reset role;
set local role anon;
do $$ declare req jsonb; begin
 begin perform public.muse_control_poll('11111111-1111-4111-8111-111111111111',repeat('b',64),'ready');raise exception 'bad secret accepted';exception when raise_exception then if sqlerrm='bad secret accepted' then raise;end if;end;
 perform public.muse_control_poll('11111111-1111-4111-8111-111111111111',repeat('a',64),'waiting_admin_login');
end $$;
reset role;
set local role authenticated;
do $$ declare first jsonb; again jsonb; begin
 if not (public.muse_control_status()->>'online')::boolean then raise exception 'heartbeat missing';end if;
 first=public.muse_control_start();again=public.muse_control_start();
 if not (again->>'already_requested')::boolean then raise exception 'duplicate request not suppressed';end if;
end $$;
reset role;
set local role anon;
do $$ declare pending jsonb; id uuid; begin
 pending=public.muse_control_poll('11111111-1111-4111-8111-111111111111',repeat('a',64),'waiting_admin_login');
 id=(pending->>'request_id')::uuid;if id is null then raise exception 'request not delivered';end if;
 if not public.muse_control_ack('11111111-1111-4111-8111-111111111111',repeat('a',64),id) then raise exception 'ack failed';end if;
 pending=public.muse_control_poll('11111111-1111-4111-8111-111111111111',repeat('a',64),'waiting_admin_login');
 if pending->>'request_id' is not null then raise exception 'acknowledged request repeated';end if;
end $$;
reset role;
do $$ begin
 if has_table_privilege('anon','private.muse_control_device','SELECT') or has_table_privilege('authenticated','private.muse_control_device','SELECT') then raise exception 'device table exposed';end if;
end $$;
rollback;
select 'ADMIN_WORKER_CONTROL_TEST_OK' as result;
