-- تحسين محفّز إنشاء المستخدم: قبول دعوة المدير وتحقق الدور

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  invited boolean;
  chosen_role text;
begin
  invited := coalesce(
    (new.raw_user_meta_data->>'invited_by_admin') in ('true', 't', '1'),
    (new.raw_user_meta_data->'invited_by_admin')::text = 'true',
    false
  );

  chosen_role := lower(trim(coalesce(new.raw_user_meta_data->>'role', 'user')));
  if chosen_role not in ('admin', 'user', 'viewer') then
    chosen_role := 'user';
  end if;

  if invited then
    insert into public.profiles (id, full_name, email, role, phone)
    values (
      new.id,
      coalesce(new.raw_user_meta_data->>'full_name', ''),
      new.email,
      chosen_role,
      nullif(trim(coalesce(new.raw_user_meta_data->>'phone', '')), '')
    );
  elsif not exists (select 1 from public.profiles limit 1) then
    insert into public.profiles (id, full_name, email, role, phone)
    values (
      new.id,
      coalesce(new.raw_user_meta_data->>'full_name', ''),
      new.email,
      'admin',
      nullif(trim(coalesce(new.raw_user_meta_data->>'phone', '')), '')
    );
  else
    raise exception 'public_registration_closed'
      using hint = 'اطلب من مدير النظام إنشاء حسابك.';
  end if;

  return new;
end;
$$;
