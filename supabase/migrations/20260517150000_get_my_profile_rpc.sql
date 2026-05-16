-- دالة قراءة ملف المستخدم الحالي بتجاوز مشاكل RLS عند الدخول
-- نفّذ من SQL Editor مرة واحدة إذا فشل الاستعلام المباشر على profiles.

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

comment on function public.get_my_profile() is 'قراءة صف profiles للمستخدم المسجّل؛ security definer للقراءة الموثوقة.';
