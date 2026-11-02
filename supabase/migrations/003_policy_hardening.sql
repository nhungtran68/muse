revoke execute on function public.create_profile() from public,anon,authenticated;
revoke execute on function public.is_admin() from public,anon;
grant execute on function public.is_admin() to authenticated;
