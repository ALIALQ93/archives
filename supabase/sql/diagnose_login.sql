-- تشخيص سريع: شغّله في SQL Editor وقارن الأعمدة id (يجب أن تتطابق)

select u.id as auth_id, u.email as auth_email, u.email_confirmed_at
from auth.users u
where lower(trim(u.email)) = lower(trim('admin@example.com'));

select p.id as profile_id, p.email as profile_email, p.role
from public.profiles p
where lower(trim(p.email)) = lower(trim('admin@example.com'));

-- إن كان auth_id مختلفاً عن profile_id فلن يعمل التطبيق حتى يُصلح الصف في profiles
