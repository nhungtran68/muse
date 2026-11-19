-- Supabase hosted phone auth needs an SMS provider. Map a phone-only web login
-- to an internal email identity, while profiles show only the phone number.
create or replace function public.create_profile() returns trigger
language plpgsql security definer set search_path = public as $$
declare phone_from_login text;
begin
  if lower(new.email) ~ '^[1-9][0-9]{7,14}@phone-login[.]ibeetool[.]com$' then
    phone_from_login='+'||split_part(new.email,'@',1);
  end if;
  insert into public.profiles(id,email,phone)
  values(new.id,
    case when phone_from_login is null then lower(new.email) else null end,
    coalesce(phone_from_login,nullif(new.phone,'')))
  on conflict (id) do nothing;
  return new;
end $$;
