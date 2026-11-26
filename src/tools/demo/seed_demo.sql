-- Realistic demo data for screenshots (invented names and figures). Run as postgres with
--   psql -v org=<uuid> -v uid=<owner uuid> -f seed_demo.sql
select set_config('request.jwt.claims', json_build_object('sub', :'uid')::text, false);
select set_config('demo.org', :'org', false);
do $$
declare
  o uuid := current_setting('demo.org')::uuid; w uuid; br uuid; wraw uuid; wshow uuid;
  c1 uuid; c2 uuid; c3 uuid; c4 uuid; c5 uuid; c6 uuid; s1 uuid; s2 uuid; s3 uuid; s4 uuid;
  steel uuid; sheet uuid; panel uuid; wire uuid; tyre uuid; axle uuid; door uuid; ac uuid; paint uuid;
  cv6 uuid; cv8 uuid; room uuid; cab uuid; inst uuid; trans uuid;
  d uuid; p uuid; sd uuid; mo uuid; cc1 uuid; cc2 uuid; cc3 uuid; run uuid; e1 uuid; e2 uuid; e3 uuid; e4 uuid; e5 uuid; e6 uuid; e7 uuid;
  bank uuid; cash uuid; i int; dt date; cust uuid[]; inv uuid[] := '{}';
begin
  select id, branch_id into w, br from warehouses where org_id = o order by created_at limit 1;
  update warehouses set name = 'مستودع الورشة الرئيسي' where id = w;
  insert into warehouses (org_id, branch_id, name, kind) values (o, br, 'مستودع المواد الخام', 'raw') returning id into wraw;
  insert into warehouses (org_id, branch_id, name, kind) values (o, br, 'المعرض — طريق الخرج', 'finished') returning id into wshow;
  select id into bank from accounts where org_id = o and system_key = 'bank';
  select id into cash from accounts where org_id = o and system_key = 'cash';
  update orgs set brand_color = '#4f6b3a', invoice_footer = 'شكراً لتعاملكم مع كرافت لاند — ضمان سنتين على الهيكل',
    invoice_settings = '{"template":"modern","color":"brand","bank_name":"مصرف الراجحي","iban":"SA0380000000608010167519","account_name":"مؤسسة كرافت لاند","terms":"الدفعة الأولى 50٪ عند التوقيع، والباقي عند الاستلام.\nالضمان سنتان على الهيكل وسنة على الكهرباء.","show_stamp":false,"show_signature":false}'
    where id = o;

  perform post_manual_entry(o, '2026-08-01', 'إيداع رأس المال', jsonb_build_array(
    jsonb_build_object('account_id', bank, 'debit', 60000000), jsonb_build_object('account_id', (select id from accounts where org_id = o and system_key = 'capital'), 'credit', 60000000)));
  -- parties
  insert into parties (org_id, kind, name, vat_number, city, street, building_no, postal_code, phone) values
    (o, 'customer', 'مؤسسة رحلات البر', '310245678900003', 'الرياض', 'طريق الملك فهد', '7421', '12345', '0551234567') returning id into c1;
  insert into parties (org_id, kind, name, vat_number, city, street, building_no, postal_code, phone) values
    (o, 'customer', 'شركة الواحة للتأجير', '311987654300003', 'جدة', 'شارع التحلية', '2210', '23435', '0569876543') returning id into c2;
  insert into parties (org_id, kind, name, vat_number, city, street, building_no, postal_code, phone) values
    (o, 'customer', 'منتجع الخيمة الذهبية', '312456789100003', 'العلا', 'طريق المطار', '1180', '43544', '0504567890') returning id into c3;
  insert into parties (org_id, kind, name, vat_number, city, street, building_no, postal_code, phone) values
    (o, 'customer', 'شركة الأفق للمقاولات', '313654987200003', 'الدمام', 'طريق الملك سعود', '3390', '32241', '0532223344') returning id into c4;
  insert into parties (org_id, kind, name, city, phone) values (o, 'customer', 'فهد العتيبي', 'الرياض', '0545556677') returning id into c5;
  insert into parties (org_id, kind, name, vat_number, city, street, building_no, postal_code, phone) values
    (o, 'customer', 'مخيمات نجد السياحية', '314789123400003', 'القصيم', 'طريق الملك عبدالعزيز', '5512', '52366', '0518889900') returning id into c6;
  insert into parties (org_id, kind, name, vat_number, city, phone) values (o, 'supplier', 'مصنع الخليج للحديد', '300112233400003', 'الرياض', '0112345678') returning id into s1;
  insert into parties (org_id, kind, name, vat_number, city, phone) values (o, 'supplier', 'شركة الألواح المعزولة', '300223344500003', 'الدمام', '0138765432') returning id into s2;
  insert into parties (org_id, kind, name, vat_number, city, phone) values (o, 'supplier', 'مؤسسة النور للأدوات الكهربائية', '300334455600003', 'الرياض', '0114567890') returning id into s3;
  insert into parties (org_id, kind, name, vat_number, city, phone) values (o, 'supplier', 'إطارات الصحراء', '300445566700003', 'الرياض', '0119998877') returning id into s4;
  cust := array[c1, c2, c3, c4, c5, c6];

  -- items
  insert into items (org_id, kind, sku, name_ar, unit, sale_price, track_stock) values (o, 'raw_material', 'RM-ST40', 'حديد زاوية 40×40', 'متر', 6200, true) returning id into steel;
  insert into items (org_id, kind, sku, name_ar, unit, sale_price, track_stock) values (o, 'raw_material', 'RM-GS12', 'صاج مجلفن 1.2 مم', 'لوح', 36000, true) returning id into sheet;
  insert into items (org_id, kind, sku, name_ar, unit, sale_price, track_stock) values (o, 'raw_material', 'RM-SP50', 'ألواح ساندوتش 50 مم', 'م²', 19500, true) returning id into panel;
  insert into items (org_id, kind, sku, name_ar, unit, sale_price, track_stock) values (o, 'raw_material', 'RM-WR6', 'أسلاك كهرباء 6 مم', 'متر', 650, true) returning id into wire;
  insert into items (org_id, kind, sku, name_ar, unit, sale_price, track_stock) values (o, 'raw_material', 'RM-TY15', 'إطار 15 بوصة', 'حبة', 42000, true) returning id into tyre;
  insert into items (org_id, kind, sku, name_ar, unit, sale_price, track_stock) values (o, 'raw_material', 'RM-AX2', 'محور مقطورة 2 طن', 'حبة', 165000, true) returning id into axle;
  insert into items (org_id, kind, sku, name_ar, unit, sale_price, track_stock) values (o, 'raw_material', 'RM-DR', 'باب ألمنيوم معزول', 'حبة', 98000, true) returning id into door;
  insert into items (org_id, kind, sku, name_ar, unit, sale_price, track_stock) values (o, 'raw_material', 'RM-AC18', 'مكيف سبليت 18 ألف', 'حبة', 185000, true) returning id into ac;
  insert into items (org_id, kind, sku, name_ar, unit, sale_price, track_stock) values (o, 'raw_material', 'RM-PT', 'دهان إيبوكسي', 'جالون', 21000, true) returning id into paint;
  insert into items (org_id, kind, sku, name_ar, unit, sale_price, track_stock) values (o, 'product', 'CV-6', 'كرفان سحب 6 متر كامل التجهيز', 'حبة', 4850000, true) returning id into cv6;
  insert into items (org_id, kind, sku, name_ar, unit, sale_price, track_stock) values (o, 'product', 'CV-8', 'كرفان سحب 8 متر — فندقي', 'حبة', 6900000, true) returning id into cv8;
  insert into items (org_id, kind, sku, name_ar, unit, sale_price, track_stock) values (o, 'product', 'RM-36', 'غرفة متنقلة 3×6 متر', 'حبة', 2450000, true) returning id into room;
  insert into items (org_id, kind, sku, name_ar, unit, sale_price, track_stock) values (o, 'product', 'CB-1', 'كابينة حراسة', 'حبة', 950000, true) returning id into cab;
  insert into items (org_id, kind, sku, name_ar, unit, sale_price, track_stock) values (o, 'service', 'SV-IN', 'تركيب وتشغيل في الموقع', 'خدمة', 150000, false) returning id into inst;
  insert into items (org_id, kind, sku, name_ar, unit, sale_price, track_stock) values (o, 'service', 'SV-TR', 'نقل بسطحة', 'رحلة', 120000, false) returning id into trans;

  -- purchases of raw materials (Aug–Nov)
  for i in 0..5 loop
    dt := date '2026-08-03' + i * 19;
    insert into documents (org_id, branch_id, warehouse_id, kind, party_id, issue_date) values (o, br, w, 'purchase_bill', case i % 3 when 0 then s1 when 1 then s2 else s3 end, dt) returning id into d;
    insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate) values
      (d, o, 1, steel, 'حديد زاوية', 600, 4200, 'S', 15), (d, o, 2, sheet, 'صاج مجلفن', 40, 29000, 'S', 15), (d, o, 3, panel, 'ألواح ساندوتش', 180, 14500, 'S', 15),
      (d, o, 4, wire, 'أسلاك', 400, 480, 'S', 15), (d, o, 5, tyre, 'إطارات', 8, 31000, 'S', 15), (d, o, 6, axle, 'محاور', 4, 128000, 'S', 15),
      (d, o, 7, door, 'أبواب', 4, 76000, 'S', 15), (d, o, 8, ac, 'مكيفات', 4, 152000, 'S', 15), (d, o, 9, paint, 'دهان', 12, 16000, 'S', 15);
    perform post_purchase_bill(d);
    if i < 4 then
      insert into payments (org_id, kind, party_id, amount, method, cash_account_id, pay_date) values (o, 'payment', case i % 3 when 0 then s1 when 1 then s2 else s3 end, (select total from documents where id = d), 'bank_transfer', bank, dt + 10) returning id into p;
      insert into payment_allocations values (p, d, (select total from documents where id = d)); perform post_payment(p);
    end if;
  end loop;

  -- BOM + production orders
  insert into boms (org_id, item_id, notes) values (o, cv6, 'كرفان 6 متر — المواصفة القياسية') returning id into d;
  insert into bom_lines (bom_id, org_id, line_no, item_id, qty, waste_pct) values (d, o, 1, steel, 120, 5), (d, o, 2, sheet, 6, 3), (d, o, 3, panel, 38, 4), (d, o, 4, wire, 80, 2),
    (d, o, 5, tyre, 2, 0), (d, o, 6, axle, 1, 0), (d, o, 7, door, 1, 0), (d, o, 8, ac, 1, 0), (d, o, 9, paint, 3, 0);
  for i in 0..13 loop
    dt := date '2026-08-08' + i * 7;
    insert into mfg_orders (org_id, item_id, warehouse_id, qty, order_date, notes) values (o, case when i % 4 = 3 then room else cv6 end, w, 1, dt, 'دفعة إنتاج') returning id into mo;
    insert into mfg_order_lines (order_id, org_id, line_no, item_id, planned_qty, actual_qty, waste_qty) values
      (mo, o, 1, steel, 120, 118, 6), (mo, o, 2, sheet, 6, 6, 0), (mo, o, 3, panel, 38, 37, 1), (mo, o, 4, wire, 80, 80, 2),
      (mo, o, 5, tyre, 2, 2, 0), (mo, o, 6, axle, 1, 1, 0), (mo, o, 7, door, 1, 1, 0), (mo, o, 8, ac, 1, 1, 0), (mo, o, 9, paint, 3, 3, 0);
    if i < 13 then perform post_mfg_order(mo); end if;
  end loop;

  -- sales invoices (Aug–Nov)
  for i in 0..13 loop
    dt := date '2026-08-20' + i * 7;
    insert into documents (org_id, branch_id, warehouse_id, kind, party_id, issue_date, due_date) values (o, br, w, case when cust[1 + i % 6] = c5 then 'simplified_invoice' else 'tax_invoice' end, cust[1 + i % 6], dt, dt + 30) returning id into d;
    if i % 4 = 3 then
      insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate) values
        (d, o, 1, room, 'غرفة متنقلة 3×6 متر', 1, 2450000, 'S', 15), (d, o, 2, trans, 'نقل بسطحة', 1, 120000, 'S', 15);
    elsif i % 5 = 0 then
      insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate) values
        (d, o, 1, steel, 'حديد زاوية (بيع مواد)', 150, 6200, 'S', 15), (d, o, 2, panel, 'ألواح ساندوتش', 40, 19500, 'S', 15);
    else
      insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate) values
        (d, o, 1, cv6, 'كرفان سحب 6 متر كامل التجهيز', 1, 4850000 - (i % 3) * 50000, 'S', 15), (d, o, 2, inst, 'تركيب وتشغيل في الموقع', 1, 150000, 'S', 15);
    end if;
    perform post_sales_invoice(d); inv := inv || d;
    if i < 10 then
      insert into payments (org_id, kind, party_id, amount, method, cash_account_id, pay_date) values (o, 'receipt', cust[1 + i % 6], (select total from documents where id = d) * case when i % 3 = 2 then 50 else 100 end / 100, case when i % 2 = 0 then 'bank_transfer' else 'cash' end, case when i % 2 = 0 then bank else cash end, dt + 5) returning id into p;
      insert into payment_allocations values (p, d, (select amount from payments where id = p)); perform post_payment(p);
    end if;
  end loop;

  -- quotes and a sales order
  insert into documents (org_id, branch_id, warehouse_id, kind, party_id, issue_date) values (o, br, w, 'quote', c3, current_date - 2) returning id into d;
  insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate) values (d, o, 1, cv8, 'كرفان سحب 8 متر — فندقي', 3, 6900000, 'S', 15), (d, o, 2, inst, 'تركيب وتشغيل', 3, 150000, 'S', 15);
  perform issue_document(d);
  insert into documents (org_id, branch_id, warehouse_id, kind, party_id, issue_date) values (o, br, w, 'quote', c4, current_date - 1) returning id into d;
  insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate) values (d, o, 1, cab, 'كابينة حراسة', 4, 950000, 'S', 15);

  insert into documents (org_id, branch_id, warehouse_id, kind, party_id, issue_date) values (o, br, w, 'purchase_order', s3, current_date - 3) returning id into d;
  insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate) values (d, o, 1, ac, 'مكيف سبليت 18 ألف', 6, 152000, 'S', 15), (d, o, 2, wire, 'أسلاك كهرباء', 500, 480, 'S', 15);
  perform issue_document(d);
  insert into documents (org_id, branch_id, warehouse_id, kind, party_id, issue_date, related_document_id) values (o, br, w, 'credit_note', (select party_id from documents where id = inv[2]), current_date - 4, inv[2]) returning id into d;
  insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate) values (d, o, 1, inst, 'خصم على التركيب — تأخير التسليم', 1, 50000, 'S', 15);
  perform post_credit_note(d);
  -- expenses (Aug–Nov)
  for i in 0..3 loop
    dt := date '2026-08-01' + (i || ' month')::interval;
    insert into expenses (org_id, expense_date, account_id, description, amount, vat_amount, paid_from_account_id) values (o, dt, (select id from accounts where org_id = o and code = '5203'), 'إيجار الورشة — ' || to_char(dt, 'YYYY-MM'), 1500000, 0, bank) returning id into p; perform post_expense(p);
    insert into expenses (org_id, expense_date, account_id, description, amount, vat_amount, paid_from_account_id) values (o, dt + 9, (select id from accounts where org_id = o and code = '5204'), 'فاتورة الكهرباء', 285000 + i * 12000, 42750 + i * 1800, bank) returning id into p; perform post_expense(p);
    insert into expenses (org_id, expense_date, account_id, description, amount, vat_amount, paid_from_account_id) values (o, dt + 14, (select id from accounts where org_id = o and code = '5205'), 'وقود سيارات التوصيل', 96000 + i * 5000, 14400 + i * 750, cash) returning id into p; perform post_expense(p);
  end loop;

  -- employees, payroll
  insert into employees (org_id, full_name, is_saudi, hire_date, basic_salary, housing_allowance, transport_allowance, job_title, phone, iban, hourly_rate) values
    (o, 'سعد القحطاني', true, '2021-03-01', 900000, 225000, 60000, 'مدير الورشة', '0551112233', 'SA4420000001234567891234', null) returning id into e1;
  insert into employees (org_id, full_name, is_saudi, hire_date, basic_salary, housing_allowance, transport_allowance, job_title) values (o, 'نورة الدوسري', true, '2023-06-15', 650000, 162500, 40000, 'محاسبة') returning id into e2;
  insert into employees (org_id, full_name, is_saudi, hire_date, basic_salary, housing_allowance, transport_allowance, job_title) values (o, 'محمد رفيق', false, '2022-01-10', 320000, 80000, 30000, 'لحّام') returning id into e3;
  insert into employees (org_id, full_name, is_saudi, hire_date, basic_salary, housing_allowance, transport_allowance, job_title) values (o, 'أحمد سليم', false, '2022-09-01', 300000, 75000, 30000, 'كهربائي') returning id into e4;
  insert into employees (org_id, full_name, is_saudi, hire_date, basic_salary, housing_allowance, transport_allowance, job_title) values (o, 'جمال حسن', false, '2024-02-01', 280000, 70000, 30000, 'نجار ومركّب') returning id into e5;
  insert into employees (org_id, full_name, is_saudi, hire_date, basic_salary, employment_type, daily_rate, job_title) values (o, 'رامي — باليومية', false, '2026-10-01', 0, 'daily', 22000, 'عامل مساعد') returning id into e6;
  insert into employees (org_id, full_name, is_saudi, hire_date, basic_salary, employment_type, hourly_rate, job_title) values (o, 'كريم — بالساعة', false, '2026-10-15', 0, 'hourly', 3500, 'دهّان') returning id into e7;
  run := prepare_payroll(o, '2026-10-01'); perform post_payroll(run); perform pay_payroll(run, bank, '2026-10-28');
  run := prepare_payroll(o, '2026-11-01');

  -- fixed assets
  insert into fixed_assets (org_id, code, name, account_id, acquisition_date, cost, salvage, life_months, depreciation_start) values
    (o, 'FA-001', 'مكينة قص بلازما CNC', (select id from accounts where org_id = o and code = '1601'), '2026-01-15', 18500000, 1500000, 84, '2026-02-01'),
    (o, 'FA-002', 'سطحة نقل إيسوزو', (select id from accounts where org_id = o and code = '1602'), '2025-06-01', 21000000, 4000000, 60, '2025-06-01'),
    (o, 'FA-003', 'ماكينات لحام وأدوات', (select id from accounts where org_id = o and code = '1601'), '2025-11-01', 3800000, 0, 36, '2025-11-01');
  perform run_depreciation(o, m::date) from generate_series(date '2026-08-31', date '2026-10-31', interval '1 month') m;

  -- projects
  insert into cost_centers (org_id, code, name, is_project, project_type, party_id, product_item_id, production_qty, contract_value, start_date, due_date, status, description)
    values (o, 'P-101', 'كرفانات فندقية — منتجع الخيمة الذهبية', true, 'customer', c3, cv8, 3, 22950000, current_date - 18, current_date + 24, 'active', '3 كرفانات 8 متر بتشطيب فندقي وتركيب في العلا') returning id into cc1;
  insert into cost_centers (org_id, code, name, is_project, project_type, product_item_id, production_qty, start_date, due_date, status, description)
    values (o, 'P-102', 'دفعة إنتاج — كرفان 6 متر (ديسمبر)', true, 'production', cv6, 4, current_date - 6, current_date + 30, 'active', 'دفعة للمعرض قبل موسم الشتاء') returning id into cc2;
  insert into cost_centers (org_id, code, name, is_project, project_type, party_id, contract_value, start_date, due_date, status)
    values (o, 'P-100', 'غرف متنقلة — شركة الأفق للمقاولات', true, 'customer', c4, 9800000, date '2026-09-01', date '2026-10-20', 'closed') returning id into cc3;
  insert into project_materials (org_id, cost_center_id, item_id, planned_qty) values (o, cc1, steel, 380), (o, cc1, panel, 120), (o, cc1, ac, 3), (o, cc1, door, 3), (o, cc1, axle, 3), (o, cc1, tyre, 6),
    (o, cc2, steel, 480), (o, cc2, panel, 152), (o, cc2, ac, 4);
  insert into stock_docs (org_id, kind, doc_date, from_warehouse_id, cost_center_id, note) values (o, 'issue', current_date - 12, w, cc1, 'صرف هيكل الدفعة الأولى') returning id into sd;
  insert into stock_doc_lines (stock_doc_id, item_id, qty, line_no) values (sd, steel, 240, 1), (sd, panel, 60, 2), (sd, axle, 2, 3), (sd, tyre, 4, 4);
  perform post_stock_doc(sd);
  insert into tasks (org_id, cost_center_id, title, status, priority, phase, start_date, due_date, est_hours, employee_ids, sort) values
    (o, cc1, 'تصميم المخطط واعتماده من العميل', 'done', 'high', 'التصميم', current_date - 18, current_date - 14, 12, array[e1], 1),
    (o, cc1, 'قص ولحام الهياكل الثلاثة', 'done', 'high', 'الهيكل', current_date - 13, current_date - 5, 96, array[e3, e6], 2),
    (o, cc1, 'العزل وتركيب الألواح', 'doing', 'normal', 'العزل', current_date - 4, current_date + 3, 60, array[e5, e6], 3),
    (o, cc1, 'التمديدات الكهربائية والتكييف', 'todo', 'normal', 'الكهرباء', current_date + 2, current_date + 9, 48, array[e4], 4),
    (o, cc1, 'الدهان والتشطيب الفندقي', 'todo', 'normal', 'التشطيب', current_date + 8, current_date + 18, 70, array[e7, e5], 5),
    (o, cc1, 'النقل والتركيب في العلا', 'todo', 'high', 'التسليم', current_date + 19, current_date + 24, 24, array[e1, e4], 6),
    (o, cc2, 'قص الهياكل — الدفعة', 'doing', 'normal', 'الهيكل', current_date - 6, current_date + 6, 120, array[e3], 1),
    (o, cc2, 'طلب المكيفات من المورد', 'todo', 'high', 'المشتريات', current_date, current_date - 1, 2, array[e1], 2),
    (o, null, 'تجديد رخصة الدفاع المدني', 'todo', 'high', null, null, current_date + 5, null, array[e2], 1),
    (o, null, 'جرد المستودع الشهري', 'todo', 'normal', null, null, current_date + 4, 6, array[e2], 2);
  insert into timesheets (org_id, cost_center_id, employee_id, work_date, hours, note) select o, cc1, e, current_date - k, h, 'لحام الهياكل'
    from (values (e3, 8), (e6, 9), (e5, 7)) v(e, h), generate_series(5, 12) k;
  insert into timesheets (org_id, cost_center_id, employee_id, work_date, hours, note) select o, cc1, e7, current_date - k, 6, 'تحضير الدهان' from generate_series(1, 3) k;
  perform post_labor(cc1, current_date - 5);

  -- feasibility, reports, follow-up
  insert into feasibility_studies (org_id, name, kind, status, inputs, ai_notes) values (o, 'كرفان سحب 7 متر — فئة اقتصادية', 'product', 'approved',
    '{"desc":"كرفان سحب 7×2.4 متر، عزل ساندوتش 50 مم، غرفة وحمام ومطبخ صغير","market":"هواة الرحلات والمخيمات في المنطقة الوسطى","price_mode":"mine",
      "my_price":{"v":3950000,"src":"manual"},"market_price":{"v":4300000,"src":"ai","ref":"النطاق المقترح 38,000 إلى 47,000 ريال"},"volume":{"v":1.5,"src":"manual"},"growth":{"v":1.5,"src":"manual"},
      "materials":{"v":1820000,"src":"history","ref":"غرف متنقلة — شركة الأفق للمقاولات"},"labor":{"v":540000,"src":"history","ref":"غرف متنقلة — شركة الأفق للمقاولات"},"other_var":{"v":160000,"src":"manual"},
      "fixed":[{"name":"حصة إيجار الورشة","v":450000,"src":"history","ref":"متوسط آخر 12 شهر × 30٪"},{"name":"تسويق وإعلانات","v":300000,"src":"manual"}],
      "capex":[{"name":"قوالب وتجهيزات خط الإنتاج","v":15000000,"src":"manual"},{"name":"رأس مال عامل","v":10000000,"src":"manual"}],
      "salvage":{"v":3000000,"src":"manual"},"months":36,"discount":10,"zakat":2.5,
      "scen":{"real":{"price":0,"volume":0,"cost":0},"opt":{"price":5,"volume":25,"cost":-5},"pess":{"price":-10,"volume":-35,"cost":15}}}',
    'الطلب على الكرفانات الاقتصادية يرتفع من أكتوبر إلى مارس مع موسم البر.' || chr(10) || 'السعر المقترح أقل من متوسط السوق بنحو 8٪، وهي ميزة تنافسية واضحة.' || chr(10) || chr(10) || 'المخاطر:' || chr(10) || '- ارتفاع أسعار الحديد' || chr(10) || '- موسمية الطلب' || chr(10) || chr(10) || 'التوصيات:' || chr(10) || '- البدء بدفعة صغيرة قبل الموسم');
  insert into feasibility_studies (org_id, name, kind, status, inputs) values (o, 'شراء مكينة ثني CNC', 'investment', 'draft',
    '{"desc":"مكينة ثني صاج CNC لتقليل وقت التشكيل والهدر","income":{"v":1350000,"src":"manual"},"opex":{"v":180000,"src":"manual"},"fixed":[{"name":"صيانة وتأمين","v":60000,"src":"manual"}],
      "capex":[{"name":"سعر المكينة","v":26000000,"src":"manual"},{"name":"نقل وتركيب وتدريب","v":1800000,"src":"manual"}],"salvage":{"v":5000000,"src":"manual"},"months":60,"discount":10,"zakat":2.5}');
  insert into saved_reports (org_id, name, definition, pinned) values
    (o, 'مبيعات العملاء هذه السنة', '{"ds":"sales_lines","period":"this-y","group":["party"],"measures":[{"f":"net","agg":"sum"},{"f":"profit","agg":"sum"},{"f":"*","agg":"count"}],"sort":{"f":"net","dir":"desc"},"columns":["date"],"filters":[],"pivot":"","limit":0}', true),
    (o, 'المصروفات شهرياً', '{"ds":"journal","period":"this-y","group":["account"],"pivot":"month","measures":[{"f":"net","agg":"sum"}],"filters":[{"f":"account_type","op":"eq","v":"مصروفات"}],"columns":["date"],"limit":0}', true);
  insert into commitments (org_id, title, kind, ref_number, expiry_date, remind_days, amount) values
    (o, 'السجل التجاري', 'cr', '1010654321', current_date + 21, 30, 120000), (o, 'رخصة الدفاع المدني', 'license', 'DF-88231', current_date + 6, 30, 50000),
    (o, 'تأمين سطحة النقل', 'insurance', 'POL-552190', current_date + 74, 30, 640000), (o, 'عقد إيجار الورشة', 'rent', 'EJ-2026-114', current_date + 160, 60, 18000000);
  insert into commitments (org_id, title, kind, employee_id, ref_number, expiry_date, remind_days) values (o, 'إقامة محمد رفيق', 'iqama', e3, '2387654321', current_date + 12, 30);
  insert into leads (org_id, name, company, phone, source, status, expected_value, next_followup) values
    (o, 'خالد المطيري', 'مخيمات الربيع', '0551239876', 'انستقرام', 'proposal', 9700000, current_date + 2),
    (o, 'سارة الحربي', 'فعاليات الشتاء', '0567773322', 'معرض', 'qualified', 14500000, current_date + 5),
    (o, 'عمر الزهراني', null, '0533214455', 'توصية عميل', 'new', 4850000, current_date + 1),
    (o, 'شركة البناء الحديث', 'البناء الحديث', '0112223344', 'موقع إلكتروني', 'contacted', 7350000, current_date + 7),
    (o, 'منيرة السبيعي', null, '0549990011', 'واتساب', 'won', 2450000, null);
  insert into leaves (org_id, employee_id, kind, start_date, end_date, status, days, note) values
    (o, e4, 'annual', current_date + 10, current_date + 20, 'pending', 11, 'إجازة سنوية'), (o, e3, 'sick', current_date - 9, current_date - 8, 'approved', 2, 'تقرير طبي');
  insert into attendance (org_id, employee_id, day, check_in, check_out, status) select o, e, current_date - k, '07:00', '16:00', case when e = e5 and k = 2 then 'late' else 'present' end
    from unnest(array[e1, e2, e3, e4, e5]) e, generate_series(0, 4) k;
  insert into evaluations (org_id, employee_id, eval_date, kind, scores, strengths, improvements, decision) values
    (o, e3, current_date - 20, 'annual', array[9,10,8,9,8,9,10,9,8,9], 'جودة لحام ممتازة والتزام بالمواعيد', 'تدريب المساعدين الجدد', 'raise');
  insert into calendar_notes (org_id, user_id, note_date, title, shared) values (o, (current_setting('request.jwt.claims')::json->>'sub')::uuid, current_date + 3, 'زيارة منتجع الخيمة لاعتماد التشطيب', true),
    (o, (current_setting('request.jwt.claims')::json->>'sub')::uuid, current_date + 9, 'استلام شحنة المكيفات', true);
end $$;
