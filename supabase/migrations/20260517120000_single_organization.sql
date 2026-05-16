-- مؤسسة واحدة: إلغاء تعدد الشركات، إعدادات موحدة، أدوار مستخدمين في RLS

-- ========== إعدادات النظام (صف واحد) ==========
create table if not exists public.app_settings (
  id int primary key default 1 check (id = 1),
  name text not null default 'نظام الأرشيف',
  phone text,
  email text,
  address text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- نقل بيانات الشركة إن وُجد الجدول (قد يكون محذوفاً مسبقاً)
do $$
begin
  if to_regclass('public.companies') is not null then
    insert into public.app_settings (id, name, phone, email, address, notes)
    select
      1,
      coalesce(nullif(trim(c.name), ''), 'نظام الأرشيف'),
      c.phone,
      c.email,
      c.address,
      c.notes
    from public.companies c
    order by c.created_at
    limit 1
    on conflict (id) do update set
      name = coalesce(nullif(excluded.name, ''), app_settings.name),
      phone = coalesce(excluded.phone, app_settings.phone),
      email = coalesce(excluded.email, app_settings.email),
      address = coalesce(excluded.address, app_settings.address),
      notes = coalesce(excluded.notes, app_settings.notes),
      updated_at = now();
  end if;
end $$;

insert into public.app_settings (id) values (1) on conflict (id) do nothing;

-- إزالة سياسات قديمة قبل حذف الجداول
do $$
begin
  if to_regclass('public.companies') is not null then
    drop policy if exists companies_select on public.companies;
    drop policy if exists companies_update on public.companies;
  end if;
end $$;
drop policy if exists profiles_select on public.profiles;
drop policy if exists profiles_update on public.profiles;
drop policy if exists profiles_delete_admin on public.profiles;
drop policy if exists sections_all on public.sections;
drop policy if exists cards_all on public.archive_cards;
drop policy if exists attachments_all on public.card_attachments;

-- ========== إزالة company_id و companies ==========
alter table public.sections drop constraint if exists sections_company_id_fkey;
alter table public.archive_cards drop constraint if exists archive_cards_company_id_fkey;
alter table public.profiles drop constraint if exists profiles_company_id_fkey;

drop index if exists public.idx_sections_company;
drop index if exists public.idx_archive_cards_company;
drop index if exists public.idx_profiles_company;

alter table public.sections drop column if exists company_id;
alter table public.archive_cards drop column if exists company_id;
alter table public.profiles drop column if exists company_id;
alter table public.profiles drop column if exists is_super_admin;

drop table if exists public.companies cascade;

-- ========== مساعدات الأدوار ==========
drop function if exists public.user_is_super_admin();
drop function if exists public.current_company_id();

create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select lower(trim(role)) from public.profiles where id = auth.uid() limit 1),
    ''
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_user_role() = 'admin';
$$;

create or replace function public.can_write_archive()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_user_role() in ('admin', 'user');
$$;

create or replace function public.registration_open()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (select 1 from public.profiles limit 1);
$$;

grant execute on function public.registration_open() to anon, authenticated;

-- ========== محفّز المستخدم الجديد ==========
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new.raw_user_meta_data->>'invited_by_admin', '') = 'true' then
    insert into public.profiles (id, full_name, email, role, phone)
    values (
      new.id,
      coalesce(new.raw_user_meta_data->>'full_name', ''),
      new.email,
      coalesce(nullif(trim(new.raw_user_meta_data->>'role'), ''), 'user'),
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
    raise exception 'public_registration_closed';
  end if;
  return new;
end;
$$;

-- ========== RLS ==========
alter table public.app_settings enable row level security;

drop function if exists public.is_company_admin();

-- إسقاط السياسات القديمة والجديدة (آمن لإعادة التشغيل)
drop policy if exists app_settings_select on public.app_settings;
drop policy if exists app_settings_update on public.app_settings;
drop policy if exists profiles_select on public.profiles;
drop policy if exists profiles_update on public.profiles;
drop policy if exists profiles_delete_admin on public.profiles;
drop policy if exists sections_all on public.sections;
drop policy if exists sections_select on public.sections;
drop policy if exists sections_write on public.sections;
drop policy if exists sections_update on public.sections;
drop policy if exists sections_delete on public.sections;
drop policy if exists cards_all on public.archive_cards;
drop policy if exists cards_select on public.archive_cards;
drop policy if exists cards_write on public.archive_cards;
drop policy if exists cards_update on public.archive_cards;
drop policy if exists cards_delete on public.archive_cards;
drop policy if exists attachments_all on public.card_attachments;
drop policy if exists attachments_select on public.card_attachments;
drop policy if exists attachments_write on public.card_attachments;
drop policy if exists attachments_update on public.card_attachments;
drop policy if exists attachments_delete on public.card_attachments;

create policy app_settings_select on public.app_settings
  for select to authenticated using (true);

create policy app_settings_update on public.app_settings
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy profiles_select on public.profiles
  for select to authenticated using (true);

create policy profiles_update on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

create policy profiles_delete_admin on public.profiles
  for delete to authenticated
  using (public.is_admin() and id <> auth.uid());

create policy sections_select on public.sections
  for select to authenticated using (true);

create policy sections_write on public.sections
  for insert to authenticated with check (public.can_write_archive());

create policy sections_update on public.sections
  for update to authenticated
  using (public.can_write_archive())
  with check (public.can_write_archive());

create policy sections_delete on public.sections
  for delete to authenticated using (public.can_write_archive());

create policy cards_select on public.archive_cards
  for select to authenticated using (true);

create policy cards_write on public.archive_cards
  for insert to authenticated with check (public.can_write_archive());

create policy cards_update on public.archive_cards
  for update to authenticated
  using (public.can_write_archive())
  with check (public.can_write_archive());

create policy cards_delete on public.archive_cards
  for delete to authenticated using (public.can_write_archive());

create policy attachments_select on public.card_attachments
  for select to authenticated using (
    exists (select 1 from public.archive_cards c where c.id = card_attachments.card_id)
  );

create policy attachments_write on public.card_attachments
  for insert to authenticated
  with check (
    public.can_write_archive()
    and exists (select 1 from public.archive_cards c where c.id = card_attachments.card_id)
  );

create policy attachments_update on public.card_attachments
  for update to authenticated
  using (
    public.can_write_archive()
    and exists (select 1 from public.archive_cards c where c.id = card_attachments.card_id)
  )
  with check (
    public.can_write_archive()
    and exists (select 1 from public.archive_cards c where c.id = card_attachments.card_id)
  );

create policy attachments_delete on public.card_attachments
  for delete to authenticated
  using (
    public.can_write_archive()
    and exists (select 1 from public.archive_cards c where c.id = card_attachments.card_id)
  );
