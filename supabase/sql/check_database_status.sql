-- =============================================================================
-- فحص الوضع الحالي — نظام الأرشيف (مؤسسة واحدة)
-- نفّذ في Supabase → SQL Editor (قراءة فقط — لا يغيّر البيانات)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) هل الجداول الأساسية موجودة؟
-- -----------------------------------------------------------------------------
select
  t.table_name,
  case when t.table_name is not null then 'موجود' else 'غير موجود' end as status
from (
  values
    ('app_settings'),
    ('profiles'),
    ('sections'),
    ('archive_cards'),
    ('card_attachments'),
    ('companies')
) as expected(name)
left join information_schema.tables t
  on t.table_schema = 'public'
 and t.table_name = expected.name
order by expected.name;

-- -----------------------------------------------------------------------------
-- 2) أعمدة profiles (يجب ألا يظهر company_id ولا is_super_admin)
-- -----------------------------------------------------------------------------
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'profiles'
order by ordinal_position;

-- -----------------------------------------------------------------------------
-- 3) عدد السجلات في كل جدول
-- -----------------------------------------------------------------------------
select 'app_settings' as table_name, count(*)::bigint as row_count from public.app_settings
union all select 'profiles', count(*) from public.profiles
union all select 'sections', count(*) from public.sections
union all select 'archive_cards', count(*) from public.archive_cards
union all select 'card_attachments', count(*) from public.card_attachments;

-- -----------------------------------------------------------------------------
-- 4) توزيع الأدوار (roles)
-- -----------------------------------------------------------------------------
select
  coalesce(lower(trim(role)), '(فارغ)') as role,
  count(*) as users_count
from public.profiles
group by 1
order by users_count desc;

-- -----------------------------------------------------------------------------
-- 5) إعدادات المؤسسة
-- -----------------------------------------------------------------------------
select id, name, phone, email, address, updated_at
from public.app_settings
where id = 1;

-- -----------------------------------------------------------------------------
-- 6) المستخدمون: Auth مقابل profiles (مهم لتسجيل الدخول)
-- -----------------------------------------------------------------------------
select
  u.id as auth_id,
  u.email as auth_email,
  u.email_confirmed_at is not null as email_confirmed,
  u.created_at as auth_created,
  p.id as profile_id,
  p.role,
  p.full_name,
  case
    when p.id is null then '❌ لا يوجد profiles — لن يعمل الدخول'
    when p.id <> u.id then '❌ profile_id ≠ auth_id'
    when lower(trim(coalesce(p.role, ''))) not in ('admin', 'user', 'viewer') then '⚠️ دور غير معروف'
    else '✅ جاهز'
  end as login_status
from auth.users u
left join public.profiles p on p.id = u.id
order by u.created_at desc;

-- -----------------------------------------------------------------------------
-- 7) حسابات Auth بدون ملف في profiles
-- -----------------------------------------------------------------------------
select u.id, u.email, u.created_at
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id)
order by u.created_at desc;

-- -----------------------------------------------------------------------------
-- 8) صفوف profiles بدون حساب Auth (يتيمة)
-- -----------------------------------------------------------------------------
select p.id, p.email, p.role, p.full_name
from public.profiles p
where not exists (select 1 from auth.users u where u.id = p.id);

-- -----------------------------------------------------------------------------
-- 9) الدوال المطلوبة للتطبيق
-- -----------------------------------------------------------------------------
select
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as args,
  'موجود' as status
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'current_user_role',
    'is_admin',
    'can_write_archive',
    'registration_open',
    'get_my_profile',
    'handle_new_user'
  )
order by p.proname;

-- دوال قديمة يجب ألا تكون مستخدمة (تحذير إن وُجدت)
select p.proname as legacy_function, '⚠️ قديمة — يُفضّل حذفها' as note
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('current_company_id', 'is_company_admin', 'user_is_super_admin');

-- -----------------------------------------------------------------------------
-- 10) محفّز إنشاء المستخدم على auth.users
-- -----------------------------------------------------------------------------
select
  tg.tgname as trigger_name,
  c.relname as on_table,
  p.proname as function_name,
  case tg.tgenabled
    when 'O' then 'مفعّل'
    when 'D' then 'معطّل'
    else tg.tgenabled::text
  end as trigger_status
from pg_trigger tg
join pg_class c on c.oid = tg.tgrelid
join pg_namespace ns on ns.oid = c.relnamespace
join pg_proc p on p.oid = tg.tgfoid
where ns.nspname = 'auth'
  and c.relname = 'users'
  and not tg.tgisinternal
  and tg.tgname = 'on_auth_user_created';

-- -----------------------------------------------------------------------------
-- 11) هل التسجيل العام مفتوح؟ (أول مستخدم فقط)
-- -----------------------------------------------------------------------------
select public.registration_open() as registration_open;

-- -----------------------------------------------------------------------------
-- 12) سياسات RLS الحالية
-- -----------------------------------------------------------------------------
select
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd
from pg_policies
where schemaname = 'public'
  and tablename in (
    'app_settings', 'profiles', 'sections', 'archive_cards', 'card_attachments'
  )
order by tablename, policyname;

-- -----------------------------------------------------------------------------
-- 13) هل RLS مفعّل على الجداول؟
-- -----------------------------------------------------------------------------
select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in (
    'app_settings', 'profiles', 'sections', 'archive_cards', 'card_attachments'
  )
order by c.relname;

-- -----------------------------------------------------------------------------
-- 14) فحص عمود company_id (يجب أن يكون غير موجود)
-- -----------------------------------------------------------------------------
select
  table_name,
  column_name,
  '❌ يجب إزالته — شغّل full_setup_single_org.sql' as warning
from information_schema.columns
where table_schema = 'public'
  and column_name in ('company_id', 'is_super_admin')
order by table_name, column_name;

-- -----------------------------------------------------------------------------
-- 15) اختياري: مستخدم محدد — غيّر البريد ثم شغّل هذا القسم فقط
-- -----------------------------------------------------------------------------
-- select
--   u.id as auth_id,
--   u.email,
--   p.id as profile_id,
--   p.role,
--   public.get_my_profile() as rpc_note
-- from auth.users u
-- left join public.profiles p on p.id = u.id
-- where lower(trim(u.email)) = lower(trim('بريدك@example.com'));
