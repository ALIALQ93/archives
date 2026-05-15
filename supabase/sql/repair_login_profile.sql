-- =============================================================================
-- إصلاح «لا يمكن الدخول» أو طرد فوري بعد تسجيل الدخول
-- السبب الأكثر شيوعاً: لا يوجد صف في public.profiles حيث id = معرف المستخدم في Auth
-- أو تم ضبط admin على صف قديم بمعرف مختلف عن حساب الدخول الحالي.
--
-- نفّذ هذا من Supabase → SQL Editor.
-- =============================================================================

-- 1) تأكيد قراءة الجدول للمستخدمين المسجلين
grant usage on schema public to anon, authenticated;
grant select on table public.profiles to authenticated;

-- 2) غيّر البريد أدناه إلى نفس البريد الذي تستخدمه في شاشة الدخول ثم شغّل الملف كاملاً.

insert into public.profiles (id, full_name, email, role, phone)
select
  u.id,
  coalesce(nullif(trim(u.raw_user_meta_data->>'full_name'), ''), split_part(u.email, '@', 1)),
  u.email,
  'admin',
  null
from auth.users u
where lower(trim(u.email)) = lower(trim('admin@example.com'))
on conflict (id) do update set
  email = excluded.email,
  full_name = coalesce(nullif(trim(excluded.full_name), ''), profiles.full_name),
  role = 'admin';

-- 3) تحقق:
-- select id, email, role from public.profiles where lower(email) = lower('admin@example.com');
