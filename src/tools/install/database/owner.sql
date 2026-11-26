-- كرافت لاند — تحديد مالك النظام
-- غيّر البريد التالي إلى بريدك (اللي بتسجّل فيه أول مرة)، ثم شغّل الملف في Supabase ← SQL Editor.
-- المالك فقط يقدر ينشئ حساباً بدون دعوة وينشئ الشركات. لإضافة مالك ثاني كرّر سطر values ببريد آخر.

insert into platform_admins (email) values (lower('owner@example.com'))
on conflict do nothing;

-- للتأكد:
select email as "ملاك النظام" from platform_admins;
