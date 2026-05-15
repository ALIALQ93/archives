# نظام الأرشيف الإلكتروني

تطبيق ويب عربي (RTL) لإدارة أرشيف مؤسسة واحدة مع Supabase.

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
   - **`supabase/migrations/20260517120000_single_organization.sql`** ← مطلوب للنموذج الجديد
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

## الجداول الرئيسية

- `app_settings` — إعدادات المؤسسة (صف واحد)
- `profiles` — المستخدمون والأدوار
- `sections` — أقسام الأرشيف
- `archive_cards` — بطاقات الأرشيف
- `card_attachments` — مرفقات الملفات (bytea)
