-- مواءمة سوبر أدمن: عمود role = 'super_admin' مع is_super_admin

alter table public.profiles
  add column if not exists is_super_admin boolean not null default false;

update public.profiles
set is_super_admin = true
where lower(trim(coalesce(role, ''))) in ('super_admin')
   or lower(trim(coalesce(role, ''))) = 'سوبر أدمن';

create or replace function public.user_is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select coalesce(p.is_super_admin, false)
        or lower(trim(coalesce(p.role, ''))) in ('super_admin')
      from public.profiles p
      where p.id = auth.uid()
      limit 1
    ),
    false
  );
$$;
