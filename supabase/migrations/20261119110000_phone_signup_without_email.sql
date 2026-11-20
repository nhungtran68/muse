-- Phone-only signups have no email address. Existing email accounts remain valid.
alter table public.profiles add column if not exists phone text;
alter table public.profiles alter column email drop not null;
create unique index if not exists profiles_phone_unique on public.profiles(phone) where phone is not null;

create or replace function public.create_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id,email,phone)
  values(new.id,lower(new.email),nullif(new.phone,''))
  on conflict (id) do nothing;
  return new;
end $$;

notify pgrst, 'reload schema';
