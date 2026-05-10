-- سوبر أدمن: يمكنه قراءة/تعديل كل الشركات عبر RLS؛ الواجهة تفلتر حسب الشركة المختارة.

alter table public.profiles
  add column if not exists is_super_admin boolean not null default false;

comment on column public.profiles.is_super_admin is 'يُعرَّف يدوياً من SQL؛ لا ترفعه العميل من الواجهة العادية.';

create or replace function public.user_is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select p.is_super_admin from public.profiles p where p.id = auth.uid() limit 1),
    false
  );
$$;

-- استبدال سياسات RLS
drop policy if exists companies_select on public.companies;
drop policy if exists companies_update on public.companies;
drop policy if exists profiles_select on public.profiles;
drop policy if exists profiles_update on public.profiles;
drop policy if exists profiles_delete_admin on public.profiles;
drop policy if exists sections_all on public.sections;
drop policy if exists cards_all on public.archive_cards;
drop policy if exists attachments_all on public.card_attachments;

create policy companies_select on public.companies
  for select using (
    public.user_is_super_admin()
    or id = public.current_company_id()
  );

create policy companies_update on public.companies
  for update using (
    public.user_is_super_admin()
    or id = public.current_company_id()
  )
  with check (
    public.user_is_super_admin()
    or id = public.current_company_id()
  );

create policy profiles_select on public.profiles
  for select using (
    public.user_is_super_admin()
    or company_id = public.current_company_id()
  );

create policy profiles_update on public.profiles
  for update using (
    public.user_is_super_admin()
    or (
      company_id = public.current_company_id()
      and (id = auth.uid() or public.is_company_admin())
    )
  )
  with check (
    public.user_is_super_admin()
    or (
      company_id = public.current_company_id()
      and (id = auth.uid() or public.is_company_admin())
    )
  );

create policy profiles_delete_admin on public.profiles
  for delete using (
    (
      public.user_is_super_admin()
      and id <> auth.uid()
    )
    or (
      public.is_company_admin()
      and company_id = public.current_company_id()
      and id <> auth.uid()
    )
  );

create policy sections_all on public.sections
  for all using (
    public.user_is_super_admin()
    or company_id = public.current_company_id()
  )
  with check (
    public.user_is_super_admin()
    or company_id = public.current_company_id()
  );

create policy cards_all on public.archive_cards
  for all using (
    public.user_is_super_admin()
    or company_id = public.current_company_id()
  )
  with check (
    public.user_is_super_admin()
    or company_id = public.current_company_id()
  );

create policy attachments_all on public.card_attachments
  for all using (
    exists (
      select 1 from public.archive_cards c
      where c.id = card_attachments.card_id
        and (
          public.user_is_super_admin()
          or c.company_id = public.current_company_id()
        )
    )
  )
  with check (
    exists (
      select 1 from public.archive_cards c
      where c.id = card_attachments.card_id
        and (
          public.user_is_super_admin()
          or c.company_id = public.current_company_id()
        )
    )
  );

-- تعيين مستخدم كسوبر أدمن (بعد التحقق من البريد في profiles):
-- update public.profiles set is_super_admin = true where email = 'your-email@example.com';
