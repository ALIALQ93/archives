-- =============================================================================
-- نظام الأرشيف — إعداد شامل (مؤسسة واحدة)
-- نفّذ مرة واحدة في Supabase → SQL Editor (يمكن إعادة التشغيل بأمان)
--
-- يشمل: الجداول، إزالة تعدد الشركات، الدوال، محفّز التسجيل، RLS، get_my_profile
--
-- بعد التنفيذ:
--   1) غيّر البريد في قسم «إصلاح الملف الشخصي» أسفل الملف (اختياري)
--   2) Ctrl+Shift+R في المتصفح ثم جرّب تسجيل الدخول
-- =============================================================================

create extension if not exists "pgcrypto";

-- =============================================================================
-- 1) الجداول (الشكل النهائي بدون company_id)
-- =============================================================================

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

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  email text,
  role text not null default 'user',
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sections (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.archive_cards (
  id uuid primary key default gen_random_uuid(),
  section_id uuid references public.sections (id) on delete set null,
  title text not null default '',
  reference text,
  card_date date,
  status text not null default 'active',
  description text,
  file_url text,
  notes text,
  priority text not null default 'medium',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_archive_cards_section on public.archive_cards (section_id);

create table if not exists public.card_attachments (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.archive_cards (id) on delete cascade,
  file_name text not null,
  mime_type text,
  size_bytes int,
  content bytea not null,
  uploaded_at timestamptz not null default now()
);

create index if not exists idx_card_attachments_card on public.card_attachments (card_id);

-- =============================================================================
-- 2) ترحيل من مخطط الشركات القديم (إن وُجد)
-- =============================================================================

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

-- إسقاط سياسات companies قبل حذف الجدول
do $$
begin
  if to_regclass('public.companies') is not null then
    drop policy if exists companies_select on public.companies;
    drop policy if exists companies_update on public.companies;
  end if;
end $$;

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

-- =============================================================================
-- 3) دوال الأدوار والصلاحيات
-- =============================================================================

drop function if exists public.user_is_super_admin();
drop function if exists public.current_company_id();
drop function if exists public.is_company_admin();

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

-- =============================================================================
-- 4) آلية التسجيل / الدخول — محفّز auth.users
--    • أول مستخدم في النظام → admin
--    • دعوة من المدير (invited_by_admin) → الدور المختار
--    • غير ذلك → مرفوض (public_registration_closed)
-- =============================================================================

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

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =============================================================================
-- 5) قراءة الملف عند الدخول (تجاوز مشاكل RLS)
-- =============================================================================

create or replace function public.get_my_profile()
returns table (
  id uuid,
  full_name text,
  email text,
  role text,
  phone text
)
language sql
security definer
set search_path = public
stable
as $$
  select p.id, p.full_name, p.email, p.role, p.phone
  from public.profiles p
  where p.id = auth.uid()
  limit 1;
$$;

grant execute on function public.get_my_profile() to authenticated;

comment on function public.get_my_profile() is
  'قراءة profiles للمستخدم الحالي بعد تسجيل الدخول (security definer).';

-- =============================================================================
-- 6) Row Level Security — إسقاط ثم إنشاء جميع السياسات
-- =============================================================================

alter table public.app_settings enable row level security;
alter table public.profiles enable row level security;
alter table public.sections enable row level security;
alter table public.archive_cards enable row level security;
alter table public.card_attachments enable row level security;

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

-- app_settings
create policy app_settings_select on public.app_settings
  for select to authenticated using (true);

create policy app_settings_update on public.app_settings
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- profiles (لا insert من العميل — فقط المحفّز)
create policy profiles_select on public.profiles
  for select to authenticated using (true);

create policy profiles_update on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

create policy profiles_delete_admin on public.profiles
  for delete to authenticated
  using (public.is_admin() and id <> auth.uid());

-- sections
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

-- archive_cards
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

-- card_attachments
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

-- =============================================================================
-- 7) صلاحيات الجداول للواجهة (authenticated)
-- =============================================================================

grant usage on schema public to anon, authenticated;

grant select on table public.app_settings to authenticated;
grant update on table public.app_settings to authenticated;

grant select, update, delete on table public.profiles to authenticated;

grant select, insert, update, delete on table public.sections to authenticated;
grant select, insert, update, delete on table public.archive_cards to authenticated;
grant select, insert, update, delete on table public.card_attachments to authenticated;

-- =============================================================================
-- 8) إصلاح الملف الشخصي (اختياري — غيّر البريد ثم شغّل هذا القسم)
--     يُربط auth.users.id بصف profiles.id ويضبط الدور admin
-- =============================================================================

-- insert into public.profiles (id, full_name, email, role, phone)
-- select
--   u.id,
--   coalesce(nullif(trim(u.raw_user_meta_data->>'full_name'), ''), split_part(u.email, '@', 1)),
--   u.email,
--   'admin',
--   null
-- from auth.users u
-- where lower(trim(u.email)) = lower(trim('ضع_بريدك_هنا@example.com'))
-- on conflict (id) do update set
--   email = excluded.email,
--   full_name = coalesce(nullif(trim(excluded.full_name), ''), profiles.full_name),
--   role = 'admin';

-- =============================================================================
-- 9) تشخيص سريع بعد التنفيذ (اختياري)
-- =============================================================================

-- select 'app_settings' as tbl, count(*) from public.app_settings
-- union all select 'profiles', count(*) from public.profiles
-- union all select 'sections', count(*) from public.sections
-- union all select 'archive_cards', count(*) from public.archive_cards;

-- select u.id as auth_id, u.email, p.id as profile_id, p.role
-- from auth.users u
-- left join public.profiles p on p.id = u.id
-- where lower(trim(u.email)) = lower(trim('ضع_بريدك_هنا@example.com'));
