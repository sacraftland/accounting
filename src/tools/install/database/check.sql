-- كرافت لاند — فحص التثبيت ومستوى قاعدة البيانات
-- شغّله في Supabase ← SQL Editor بعد setup.sql و owner.sql، أو قبل/بعد أي تحديث.
-- لا يغيّر أي شيء — قراءة فقط.

with lv(n, name, ok) as (values
  (1,  'الأساس: الحسابات والقيود والفواتير والمخزون', to_regclass('public.journal_entries') is not null and to_regclass('public.documents') is not null),
  (2,  'ربط Supabase وعزل الشركات', exists (select 1 from pg_constraint where conname like '%members%user_id%' or (conrelid = to_regclass('public.members') and contype = 'f' and confrelid = 'auth.users'::regclass))),
  (3,  'تحصين الدوال', not exists (select 1 from pg_proc p where pronamespace = 'public'::regnamespace and not prosecdef and prokind = 'f' and proconfig is null and prolang <> (select oid from pg_language where lanname = 'internal') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e'))),
  (4,  'الدخول بالدعوة فقط', to_regclass('public.invitations') is not null and to_regclass('public.platform_admins') is not null),
  (5,  'الأدوار والصلاحيات', to_regclass('public.roles') is not null),
  (6,  'المشتريات والمصروفات والمستودعات والتصنيع', to_regclass('public.stock_docs') is not null and to_regclass('public.mfg_orders') is not null),
  (7,  'التقارير المالية والرواتب', to_regclass('public.payroll_runs') is not null),
  (8,  'ربحية المشاريع', to_regprocedure('public.project_pl(uuid,date,date)') is not null),
  (9,  'الأصول والعهد والموازنة والمهام والموارد البشرية', to_regclass('public.leads') is not null and to_regclass('public.fixed_assets') is not null),
  (10, 'بوابة العميل ورحلات المندوبين', to_regclass('public.van_trips') is not null and to_regclass('public.portal_links') is not null),
  (11, 'المشاريع المتقدمة وساعات العمل', to_regclass('public.timesheets') is not null and to_regclass('public.project_materials') is not null),
  (12, 'العمال باليومية والساعة', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employees' and column_name = 'employment_type')),
  (13, 'تصميم الفاتورة ولوحات الأدوار', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orgs' and column_name = 'invoice_settings')),
  (14, 'دراسات الجدوى', to_regclass('public.feasibility_studies') is not null),
  (15, 'النسخ الاحتياطي ومنشئ التقارير', to_regclass('public.saved_reports') is not null and to_regclass('public.backup_log') is not null),
  (16, 'تشديد صلاحيات الجداول', not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and (grantee = 'anon' or (grantee = 'authenticated' and privilege_type = 'TRUNCATE')))),
  (17, 'تصفير الشركة', to_regprocedure('public.reset_org(uuid,text,text)') is not null),
  (18, 'ضريبة الفاتورة حسب النسبة (متطلب الهيئة)', position('group by vat_rate' in pg_get_functiondef('public.compute_lines(uuid,numeric)'::regprocedure)) > 0),
  (19, 'الربط مع هيئة الزكاة (مفاتيح الأجهزة وتسلسل الفواتير)', to_regclass('public.zatca_secrets') is not null and to_regprocedure('public.zatca_commit(uuid,uuid,bigint,text,text,text,text,text,jsonb)') is not null)
),
lvl as (select coalesce((select min(n) - 1 from lv where not ok), 19) l),
extra(n, ok, name) as (values
  (20, (select count(*) from platform_admins) > 0, 'مالك النظام محدد (owner.sql)'),
  (21, not exists (select 1 from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity), 'حماية الصفوف (RLS) مفعّلة على كل الجداول'),
  (22, not exists (select 1 from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public' and privilege_type in ('SELECT','INSERT','UPDATE','DELETE')), 'الزائر بدون حساب لا يصل لأي جدول')
)
select "#", "الحالة", "الفحص" from (
  select n as "#", case when ok then '✓' else '✗' end as "الحالة", name as "الفحص" from lv
  union all select n, case when ok then '✓' else '✗' end, name from extra
  union all select 99, '', case when (select bool_and(ok) from lv) and (select bool_and(ok) from extra)
      then 'التثبيت سليم — مستوى قاعدة البيانات ' || (select l from lvl)
      else 'مستوى قاعدة البيانات ' || (select l from lvl) || ' — راجع الأسطر التي فيها ✗' end
) x order by 1;
