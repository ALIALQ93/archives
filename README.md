# نظام الأرشيف الإلكتروني

تطبيق ويب عربي (RTL) لإدارة أرشيف مؤسسة واحدة مع Supabase.

## الاستضافة على GitHub Pages

الموقع يُنشر تلقائياً عند الدفع إلى فرع `main` عبر [GitHub Actions](.github/workflows/pages.yml).

1. في المستودع: **Settings → Pages → Build and deployment** اختر **GitHub Actions**.
2. بعد نجاح أول workflow، الرابط المتوقع:  
   **https://alialq93.github.io/archives/**
3. في لوحة Supabase → **Authentication → URL Configuration**:
   - **Site URL:** `https://alialq93.github.io/archives/`
   - **Redirect URLs:** نفس الرابط (وأضف `http://localhost:3000` للتطوير المحلي)
4. مفاتيح Supabase على الاستضافة: وسوم `meta` في `index.html` (لا يُرفع `config.js` — مُستثنى في `.gitignore`).

## التشغيل المحلي

```bash
npm run serve
```

ثم افتح: http://localhost:3000

## إعداد Supabase

1. أنشئ مشروعاً على [Supabase](https://supabase.com).
2. من **SQL Editor** شغّل ملفات الهجرة بالترتيب:
   - `supabase/migrations/20260510120000_init_archive_schema.sql`
   - `supabase/migrations/20260515100000_super_admin_multicompany.sql` (إن وُجدت سابقاً)
   - `supabase/migrations/20260516120000_super_admin_role_column_sync.sql` (إن وُجدت)
   - **`supabase/migrations/20260517120000_single_organization.sql`** ← مطلوب (مؤسسة واحدة)
   - **`supabase/migrations/20260517130000_fix_user_invite_metadata.sql`** ← مطلوب (إنشاء المستخدمين)
   - **`supabase/migrations/20260517150000_get_my_profile_rpc.sql`** ← يُنصح به إذا تعذّرت قراءة `profiles` بعد الدخول
3. انسخ `config.example.js` إلى `config.js` واملأ `url` و `anonKey` من لوحة المشروع → Settings → API.
4. (اختياري) عطّل التسجيل العام من Authentication → Providers إذا أردت أن يضيف المدير المستخدمين فقط.

## المستخدمون والأدوار

| الدور | الصلاحيات |
|-------|-----------|
| **admin** | إدارة المستخدمين، الإعدادات، كل عمليات الأرشيف |
| **user** | إضافة وتعديل الأقسام والبطاقات |
| **viewer** | عرض فقط |

- **أول تسجيل** في النظام يصبح تلقائياً **مديراً**.
- بعد ذلك يضيف المدير المستخدمين من تبويب «المستخدمون».

## لا يمكن الدخول رغم أنني مدير

غالباً **معرف الصف في `profiles` لا يطابق** معرف الحساب في **Authentication → Users**  
(`profiles.id` يجب أن يكون مساوياً لـ `auth.users.id` حرفياً).

1. جرّب تسجيل الدخول وافتح **F12 → Console** وانسخ السطر الذي يبدأ بـ `[login] معرف حساب المصادقة`.
2. في Supabase → **SQL Editor** شغّل `supabase/sql/diagnose_login.sql` (بعد تغيير البريد) وتأكد أن `auth_id` = `profile_id`.
3. إن اختلفا، عدّل البريد في `supabase/sql/repair_login_profile.sql` ثم نفّذه.
4. نفّذ أيضاً **`supabase/migrations/20260517150000_get_my_profile_rpc.sql`** ثم حدّث الصفحة (البرنامج يستخدمها تلقائياً إن فشل الاستعلام المباشر).

إن ظهر خطأ **permission denied** على `profiles`، نفس الملف يمنح `SELECT` لـ `authenticated`.

## الجداول الرئيسية

- `app_settings` — إعدادات المؤسسة (صف واحد)
- `profiles` — المستخدمون والأدوار
- `sections` — أقسام الأرشيف
- `archive_cards` — بطاقات الأرشيف
- `card_attachments` — مرفقات الملفات (bytea)
