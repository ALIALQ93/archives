-- نظام الأرشيف: مخطط Postgres + RLS (بدون Supabase Storage — الملفات في card_attachments.content bytea)

create extension if not exists "pgcrypto";

-- الشركة: معرفها = معرف مالك الحساب (مطابق Firebase companies/{uid})
create table public.companies (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null default '',
  phone text,
  email text,
  address text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  full_name text,
  email text,
  role text not null default 'user',
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_profiles_company on public.profiles (company_id);

create table public.sections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  description text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_sections_company on public.sections (company_id);

create table public.archive_cards (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
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

create index idx_archive_cards_company on public.archive_cards (company_id);
create index idx_archive_cards_section on public.archive_cards (section_id);

create table public.card_attachments (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.archive_cards (id) on delete cascade,
  file_name text not null,
  mime_type text,
  size_bytes int,
  content bytea not null,
  uploaded_at timestamptz not null default now()
);

create index idx_card_attachments_card on public.card_attachments (card_id);

-- إنشاء شركة + ملف عند التسجيل، أو ملف فقط عند انضمام لمستخدم موجود (join_company)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cid uuid;
begin
  if coalesce(new.raw_user_meta_data->>'join_company', '') = 'true' then
    cid := (new.raw_user_meta_data->>'company_id')::uuid;
    if cid is null then
      raise exception 'company_id missing for join_company signup';
    end if;
    insert into public.profiles (id, company_id, full_name, email, role, phone)
    values (
      new.id,
      cid,
      coalesce(new.raw_user_meta_data->>'full_name', ''),
      new.email,
      coalesce(new.raw_user_meta_data->>'role', 'user'),
      nullif(trim(coalesce(new.raw_user_meta_data->>'phone', '')), '')
    );
  else
    insert into public.companies (id, name)
    values (
      new.id,
      coalesce(nullif(trim(new.raw_user_meta_data->>'company_name'), ''), 'شركتي')
    );
    insert into public.profiles (id, company_id, full_name, email, role, phone)
    values (
      new.id,
      new.id,
      coalesce(new.raw_user_meta_data->>'full_name', ''),
      new.email,
      coalesce(nullif(trim(new.raw_user_meta_data->>'role'), ''), 'admin'),
      nullif(trim(coalesce(new.raw_user_meta_data->>'phone', '')), '')
    );
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ========== RLS ==========
alter table public.companies enable row level security;
alter table public.profiles enable row level security;
alter table public.sections enable row level security;
alter table public.archive_cards enable row level security;
alter table public.card_attachments enable row level security;

-- مساعد: company الحالية للمستخدم
create or replace function public.current_company_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select company_id from public.profiles where id = auth.uid() limit 1;
$$;

create or replace function public.is_company_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role = 'admin' from public.profiles where id = auth.uid() limit 1),
    false
  );
$$;

-- companies
create policy companies_select on public.companies
  for select using (id = public.current_company_id());

-- إنشاء صف الشركة يتم عبر المحفّز عند أول تسجيل

create policy companies_update on public.companies
  for update using (id = public.current_company_id())
  with check (id = public.current_company_id());

-- profiles
create policy profiles_select on public.profiles
  for select using (company_id = public.current_company_id());

-- إدراج الملفات يتم عبر محفّز handle_new_user فقط (لا سياسة insert للعميل)

create policy profiles_update on public.profiles
  for update using (
    company_id = public.current_company_id()
    and (id = auth.uid() or public.is_company_admin())
  )
  with check (company_id = public.current_company_id());

create policy profiles_delete_admin on public.profiles
  for delete using (
    public.is_company_admin()
    and company_id = public.current_company_id()
    and id <> auth.uid()
  );

-- sections
create policy sections_all on public.sections
  for all using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- archive_cards
create policy cards_all on public.archive_cards
  for all using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- card_attachments (عبر البطاقة)
create policy attachments_all on public.card_attachments
  for all using (
    exists (
      select 1 from public.archive_cards c
      where c.id = card_attachments.card_id
        and c.company_id = public.current_company_id()
    )
  )
  with check (
    exists (
      select 1 from public.archive_cards c
      where c.id = card_attachments.card_id
        and c.company_id = public.current_company_id()
    )
  );

-- تفعيل Realtime للجداول أعلاه من لوحة Supabase: Database → Replication عند الحاجة
