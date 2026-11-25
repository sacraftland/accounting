-- Permissions (migration 05) + operations (migration 06), as the browser roles.
\set ON_ERROR_STOP on
create schema t;
create table t.results (n serial, name text, ok boolean, info text);
grant usage on schema t to anon, authenticated; grant all on t.results to anon, authenticated; grant usage on sequence t.results_n_seq to anon, authenticated;
create function t.ok(name text, cond boolean, info text default '') returns void language sql as $$ insert into t.results (name, ok, info) values (name, coalesce(cond,false), info) $$;
create function t.fails(name text, q text, pattern text) returns void language plpgsql as $$
begin
  begin execute q; insert into t.results (name, ok, info) values (name, false, 'no error');
  exception when others then insert into t.results (name, ok, info) values (name, sqlerrm ~* pattern, sqlerrm); end;
end $$;
create function t.bal(o uuid, k text) returns bigint language sql as $$
  select coalesce(sum(l.debit - l.credit),0)::bigint from journal_lines l join journal_entries e on e.id = l.entry_id and e.status = 'posted'
  join accounts a on a.id = l.account_id where l.org_id = o and a.system_key = k $$;
create function t.onhand(i uuid, w uuid default null) returns numeric language sql as $$
  select coalesce(sum(qty),0) from stock_moves where item_id = i and (w is null or warehouse_id = w) $$;
grant execute on all functions in schema t to anon, authenticated;

insert into platform_admins values ('owner@example.com'), ('other@example.com');
insert into auth.users values ('00000000-0000-0000-0000-0000000000aa','owner@example.com'), ('00000000-0000-0000-0000-0000000000bb','other@example.com');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa"}', false);
select create_org('كرافت لاند', '300000000000003') as org \gset
select t.ok('default roles seeded', (select count(*) from roles where org_id = :'org') = 7);
select t.ok('owner: full permissions', (my_permissions(:'org') ->> '_owner')::boolean and my_permissions(:'org') -> 'manufacturing' ? 'post');

-- ================= roles =================
select save_role(:'org', null, 'مراجع مشتريات', '{"purchases":["view"],"expenses":["view","create","junk"],"nonsense":["post"]}') as r_custom \gset
select t.ok('custom role saved, junk stripped', (select permissions from roles where id = :'r_custom') = '{"expenses":["create","view"],"purchases":["view"]}'::jsonb);
select save_role(:'org', null, 'مسؤول موارد', '{"users":["view","create"],"hr":["view","create"]}') as r_hradmin \gset
select t.fails('system role cannot be deleted', format('select delete_role(%L)', (select id from roles where org_id = :'org' and name = 'مدير عام')), 'SYSTEM_ROLE');
select id as w1 from warehouses where org_id = :'org' limit 1 \gset
select branch_id as br from warehouses where id = :'w1' \gset
insert into warehouses (org_id, branch_id, name) values (:'org', :'br', 'مستودع الورشة') returning id as w2 \gset
select t.ok('second warehouse created', (select count(*) from warehouses where org_id = :'org') = 2);

-- staff: worker, read-only accountant, custom, hr-admin
select invite_member(:'org', 'worker@example.com', (select id from roles where org_id = :'org' and name = 'عامل ورشة'));
select invite_member(:'org', 'reader@example.com', (select id from roles where org_id = :'org' and name = 'محاسب — قراءة فقط'));
select invite_member(:'org', 'custom@example.com', :'r_custom');
select invite_member(:'org', 'hr@example.com', :'r_hradmin');
reset role;
insert into auth.users values ('00000000-0000-0000-0000-0000000000c1','worker@example.com'), ('00000000-0000-0000-0000-0000000000c2','reader@example.com'),
  ('00000000-0000-0000-0000-0000000000c3','custom@example.com'), ('00000000-0000-0000-0000-0000000000c4','hr@example.com');
set role authenticated;
do $$ declare u text; begin foreach u in array array['c1','c2','c3','c4'] loop
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000' || u || '"}', false); perform accept_invitations(); end loop; end $$;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa"}', false);
select t.fails('role in use cannot be deleted', format('select delete_role(%L)', :'r_custom'), 'ROLE_IN_USE');

-- ================= master data (owner) =================
insert into parties (org_id, kind, name, vat_number) values (:'org', 'supplier', 'مصنع الحديد', '322222222222223') returning id as sup \gset
insert into parties (org_id, kind, name, vat_number, city, street, building_no, postal_code) values (:'org', 'customer', 'شركة الرحلات', '311111111111113', 'الرياض', 'الملك فهد', '1234', '12345') returning id as cust \gset
insert into items (org_id, kind, name_ar, sku) values (:'org', 'raw_material', 'حديد مربع', 'RM-1') returning id as steel \gset
insert into items (org_id, kind, name_ar, sku) values (:'org', 'raw_material', 'لوح ساندويتش', 'RM-2') returning id as panel \gset
insert into items (org_id, kind, name_ar, sku, sale_price) values (:'org', 'product', 'كرفان 6 متر', 'CR-6', 20000000) returning id as caravan \gset
insert into items (org_id, kind, name_ar, sku, sale_price) values (:'org', 'product', 'درج مطبخ خارجي', 'KD-1', 120000) returning id as drawer \gset
insert into items (org_id, kind, name_ar, track_stock) values (:'org', 'service', 'نقل', false) returning id as transport \gset

-- ================= purchases =================
insert into documents (org_id, branch_id, warehouse_id, kind, party_id, issue_date) values (:'org', :'br', :'w1', 'purchase_bill', :'sup', '2026-11-01') returning id as bill \gset
insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate) values
  (:'bill', :'org', 1, :'steel', 'حديد', 10, 10000, 'S', 15), (:'bill', :'org', 2, :'panel', 'ألواح', 5, 20000, 'S', 15);
insert into landed_costs (org_id, bill_id, description, amount) values (:'org', :'bill', 'شحن', 15000);
select post_purchase_bill(:'bill');
select t.ok('bill: numbered PUR-00001, total 2,300.00', (select number = 'PUR-00001' and total = 230000 from documents where id = :'bill'));
select t.ok('bill: landed cost in average cost (107.50 / 215.00)', (select avg_cost from items where id = :'steel') = 10750 and (select avg_cost from items where id = :'panel') = 21500);
select t.ok('bill: raw materials account 2,150.00, AP -2,300.00', t.bal(:'org','raw_materials') = 215000 and t.bal(:'org','ap') = -230000);
select t.ok('bill: stock in warehouse 1', t.onhand(:'steel', :'w1') = 10);

insert into documents (org_id, branch_id, warehouse_id, kind, party_id) values (:'org', :'br', :'w1', 'purchase_bill', :'sup') returning id as bill2 \gset
insert into document_lines (document_id, org_id, line_no, item_id, account_id, description, qty, unit_price, tax_category, vat_rate) values
  (:'bill2', :'org', 1, :'transport', (select id from accounts where org_id = :'org' and code = '5205'), 'نقل مواد', 1, 50000, 'S', 15);
select post_purchase_bill(:'bill2');
select t.ok('service bill line goes to the chosen expense account', (select sum(debit) from journal_lines l join accounts a on a.id = l.account_id where a.code = '5205' and l.org_id = :'org') = 50000);

insert into payments (org_id, kind, party_id, amount, method, cash_account_id) values (:'org', 'payment', :'sup', 100000, 'bank_transfer', (select id from accounts where org_id = :'org' and system_key = 'bank')) returning id as pv \gset
insert into payment_allocations values (:'pv', :'bill', 100000);
select post_payment(:'pv');
select t.ok('payment voucher PV-00001, bill partial', (select number from payments where id = :'pv') = 'PV-00001' and (select payment_status from documents where id = :'bill') = 'partial');

select convert_document(:'bill', 'purchase_return') as ret \gset
delete from document_lines where document_id = :'ret';
insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate) values (:'ret', :'org', 1, :'steel', 'مرتجع حديد', 2, 10000, 'S', 15);
select post_purchase_return(:'ret');
select t.ok('purchase return PRE-00001 total 230.00', (select number = 'PRE-00001' and total = 23000 from documents where id = :'ret'));
select t.ok('return: steel 8 left, average re-computed', t.onhand(:'steel') = 8 and (select avg_cost from items where id = :'steel') = 10937.5);
select t.ok('return reduces what we owe on the bill', (select amount_paid from documents where id = :'bill') = 123000);
select convert_document(:'bill', 'purchase_return') as ret2 \gset
select t.fails('return larger than the bill rejected', format('select post_purchase_return(%L)', :'ret2'), 'RETURN_TOO_BIG');
delete from documents where id = :'ret2';

-- ================= orders & quotes =================
insert into documents (org_id, branch_id, warehouse_id, kind, party_id) values (:'org', :'br', :'w1', 'purchase_order', :'sup') returning id as po \gset
insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate) values (:'po', :'org', 1, :'steel', 'حديد', 20, 9500, 'S', 15);
select issue_document(:'po') as po_no \gset
select t.ok('purchase order issued PO-00001, no journal', :'po_no' = 'PO-00001' and not exists (select 1 from journal_entries where source_id = :'po'));
select convert_document(:'po', 'purchase_bill') as bill3 \gset
select t.ok('PO converted to a draft bill with its lines', (select status = 'draft' and related_document_id = :'po' from documents where id = :'bill3') and (select count(*) from document_lines where document_id = :'bill3') = 1);
insert into documents (org_id, branch_id, warehouse_id, kind, party_id) values (:'org', :'br', :'w1', 'quote', :'cust') returning id as quo \gset
insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate) values (:'quo', :'org', 1, :'caravan', 'كرفان 6 متر حسب الطلب', 1, 20000000, 'S', 15);
select issue_document(:'quo') as quo_no \gset
select t.ok('quote issued QUO-00001', :'quo_no' = 'QUO-00001');

-- ================= manufacturing =================
insert into boms (org_id, item_id, output_qty) values (:'org', :'caravan', 1) returning id as bom \gset
insert into bom_lines (bom_id, org_id, line_no, item_id, qty, waste_pct) values (:'bom', :'org', 1, :'steel', 4, 5), (:'bom', :'org', 2, :'panel', 2, 0);
select t.fails('product cannot be its own component', format($q$insert into bom_lines (bom_id, org_id, item_id, qty) values (%L, %L, %L, 1)$q$, :'bom', :'org', :'caravan'), 'BOM_SELF');

-- the workshop worker drafts the order for the customer's quote
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1"}', false);
select t.ok('worker: sees no sales or purchase documents', (select count(*) from documents) = 0);
select t.ok('worker: sees the bill of materials', (select count(*) from bom_lines) = 2);
select t.fails('worker cannot link an order to a quote they cannot see', format($q$insert into mfg_orders (org_id, item_id, warehouse_id, qty, related_document_id) values (%L,%L,%L,1,%L)$q$, :'org', :'caravan', :'w1', :'quo'), 'document not found');
insert into mfg_orders (org_id, item_id, warehouse_id, qty, party_id, order_date, total_cost, number) values (:'org', :'caravan', :'w1', 1, :'cust', '2026-11-10', 1, 'HACK') returning id as mo \gset
insert into mfg_order_lines (order_id, org_id, line_no, item_id, planned_qty, actual_qty, waste_qty) values
  (:'mo', :'org', 1, :'steel', 4.2, 4, 1), (:'mo', :'org', 2, :'panel', 2, 2, 0);
insert into mfg_order_costs (order_id, org_id, description, amount, account_id) values (:'mo', :'org', 'أجور الورشة', 30000, (select id from accounts where org_id = :'org' and system_key = 'salaries_payable'));
select t.ok('worker: forged cost/number on draft ignored', (select total_cost = 0 and number is null from mfg_orders where id = :'mo'));
select t.fails('worker cannot approve the order', format('select post_mfg_order(%L)', :'mo'), 'not allowed');
select t.fails('worker cannot create roles', $q$select save_role((select org_id from members where user_id = auth.uid()), null, 'x', '{}')$q$, 'not allowed');
update mfg_orders set submitted_at = now() where id = :'mo';
select t.ok('worker sends it for approval', (select submitted_at is not null from mfg_orders where id = :'mo'));

-- the owner links it to the quote and approves
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa"}', false);
update mfg_orders set related_document_id = :'quo' where id = :'mo';
select post_mfg_order(:'mo');
select t.ok('MO-00001 posted: material 867.50, waste 109.38, labour 300.00, total 1,276.88',
  (select number = 'MO-00001' and material_cost = 86750 and waste_cost = 10938 and extra_cost = 30000 and total_cost = 127688 from mfg_orders where id = :'mo'), (select row_to_json(m)::text from mfg_orders m where id = :'mo'));
select t.ok('mfg: caravan in stock at its cost; steel 3, panels 3 left', t.onhand(:'caravan') = 1 and (select avg_cost from items where id = :'caravan') = 127688 and t.onhand(:'steel') = 3 and t.onhand(:'panel') = 3);
select t.fails('posted order cannot be edited', format('update mfg_orders set notes = %L where id = %L', 'x', :'mo'), 'cannot be edited');

-- sell it from the quote, then the customer returns it
select convert_document(:'quo', 'tax_invoice') as inv \gset
select post_sales_invoice(:'inv');
select t.ok('invoice from quote: COGS = manufacturing cost', t.bal(:'org','cogs') = 127688 and t.onhand(:'caravan') = 0);
select convert_document(:'inv', 'credit_note') as cn \gset
select post_credit_note(:'cn');
select t.ok('credit note CN-00001 reverses sale, caravan back at cost', (select number from documents where id = :'cn') = 'CN-00001' and t.onhand(:'caravan') = 1 and t.bal(:'org','cogs') = 0);
select t.ok('credit note settles the invoice', (select payment_status from documents where id = :'inv') = 'paid' and t.bal(:'org','ar') = 0);

-- ================= expenses =================
insert into expenses (org_id, account_id, paid_from_account_id, amount, vat_amount, description, number) values
  (:'org', (select id from accounts where org_id = :'org' and code = '5203'), (select id from accounts where org_id = :'org' and system_key = 'cash'), 500000, 75000, 'إيجار الورشة', 'HACK') returning id as ex \gset
select post_expense(:'ex');
select t.ok('expense EXP-00001: rent 5,000 + VAT 750 from cash', (select number from expenses where id = :'ex') = 'EXP-00001' and t.bal(:'org','cash') = -575000);
insert into expenses (org_id, account_id, paid_from_account_id, amount) values
  (:'org', (select id from accounts where org_id = :'org' and system_key = 'sales'), (select id from accounts where org_id = :'org' and system_key = 'cash'), 100) returning id as ex2 \gset
select t.fails('expense to a revenue account rejected', format('select post_expense(%L)', :'ex2'), 'EXPENSE_ACCOUNT');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c3"}', false);
select t.ok('custom role: can see expenses', (select count(*) from expenses) = 2);
insert into expenses (org_id, account_id, paid_from_account_id, amount, description) values
  (:'org', (select id from accounts where org_id = :'org' and code = '5204'), (select id from accounts where org_id = :'org' and system_key = 'cash'), 20000, 'كهرباء') returning id as ex3 \gset
select t.fails('custom role: drafts but cannot post', format('select post_expense(%L)', :'ex3'), 'not allowed');
select t.ok('custom role: sees purchase bills (view)', (select count(*) from documents where kind = 'purchase_bill') >= 2);
select t.fails('custom role: cannot create purchase bills', format($q$insert into documents (org_id, branch_id, kind, party_id) values (%L,%L,'purchase_bill',%L)$q$, :'org', :'br', :'sup'), 'row-level security');
select t.ok('custom role: no access to sales', (select count(*) from documents where kind in ('tax_invoice','quote')) = 0);

-- read-only accountant
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c2"}', false);
select t.ok('read-only: sees everything', (select count(*) from documents) >= 6 and (select count(*) from mfg_orders) = 1 and (select count(*) from journal_lines) > 0);
select t.fails('read-only: cannot write', format($q$insert into parties (org_id, kind, name) values (%L,'customer','x')$q$, :'org'), 'row-level security');

-- hr-admin cannot escalate
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c4"}', false);
select t.fails('hr admin cannot create a role with accounting', format($q$select save_role(%L, null, 'x', '{"accounting":["post"]}')$q$, :'org'), 'PERM_ESCALATION');
select t.fails('hr admin cannot hand out the general-manager role', format($q$select invite_member(%L, 'boss@example.com', (select id from roles where org_id = %L and name = 'مدير عام'))$q$, :'org', :'org'), 'PERM_ESCALATION');
select t.ok('hr admin can create a narrower role', save_role(:'org', null, 'موظف موارد', '{"hr":["view"]}') is not null);
select t.fails('hr admin cannot change own role', format($q$select set_member_role(%L, '00000000-0000-0000-0000-0000000000c4', (select id from roles where org_id = %L and name = 'موظف موارد'))$q$, :'org', :'org'), 'SELF_ROLE');
select t.fails('hr admin cannot remove the read-only accountant (more permissions)', format($q$select remove_member(%L, '00000000-0000-0000-0000-0000000000c2')$q$, :'org'), 'PERM_ESCALATION');

-- ================= journal entries =================
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa"}', false);
select post_manual_entry(:'org', '2026-11-01', 'رأس المال', jsonb_build_array(
  jsonb_build_object('account_id', (select id from accounts where org_id = :'org' and system_key = 'bank'), 'debit', 10000000),
  jsonb_build_object('account_id', (select id from accounts where org_id = :'org' and system_key = 'capital'), 'credit', 10000000))) as je \gset
select t.ok('manual entry posted', t.bal(:'org','capital') = -10000000);
select t.fails('unbalanced manual entry rejected', format($q$select post_manual_entry(%L, current_date, 'x', jsonb_build_array(
  jsonb_build_object('account_id', (select id from accounts where org_id = %L and system_key = 'bank'), 'debit', 100),
  jsonb_build_object('account_id', (select id from accounts where org_id = %L and system_key = 'capital'), 'credit', 90)))$q$, :'org', :'org', :'org'), 'ENTRY_UNBALANCED');
select reverse_entry(:'je');
select t.ok('manual entry reversed', t.bal(:'org','capital') = 0);
select t.fails('cannot reverse twice', format('select reverse_entry(%L)', :'je'), 'already reversed');
select t.fails('document entries are not reversed by hand', format('select reverse_entry(%L)', (select id from journal_entries where source_id = :'inv')), 'REVERSE_MANUAL_ONLY');

-- ================= warehouses & stock documents =================
insert into stock_docs (org_id, kind, from_warehouse_id, to_warehouse_id) values (:'org', 'transfer', :'w1', :'w2') returning id as trf \gset
insert into stock_doc_lines (stock_doc_id, item_id, qty) values (:'trf', :'steel', 2);
select post_stock_doc(:'trf');
select t.ok('transfer TRF-00001: steel 1 + 2, average unchanged', t.onhand(:'steel', :'w1') = 1 and t.onhand(:'steel', :'w2') = 2 and (select avg_cost from items where id = :'steel') = 10937.5);
select t.ok('stock_by_warehouse view', (select qty from stock_by_warehouse where item_id = :'steel' and warehouse_id = :'w2') = 2);
insert into stock_docs (org_id, kind, from_warehouse_id) values (:'org', 'count', :'w2') returning id as cnt \gset
insert into stock_doc_lines (stock_doc_id, item_id, qty, system_qty) values (:'cnt', :'steel', 1, 999);
select post_stock_doc(:'cnt');
select t.ok('count CNT-00001: 1 missing → variance 109.38', t.onhand(:'steel', :'w2') = 1 and t.bal(:'org','stock_variance') = 10938 and (select system_qty from stock_doc_lines where stock_doc_id = :'cnt') = 2);
insert into stock_docs (org_id, kind, to_warehouse_id) values (:'org', 'opening', :'w2') returning id as opn \gset
insert into stock_doc_lines (stock_doc_id, item_id, qty, unit_cost) values (:'opn', :'drawer', 10, 50000);
select post_stock_doc(:'opn');
select t.ok('opening stock: 10 drawers @ 500 into the workshop', t.onhand(:'drawer', :'w2') = 10 and t.bal(:'org','opening_balance') = -500000);
insert into stock_docs (org_id, kind, from_warehouse_id) values (:'org', 'waste', :'w2') returning id as wst \gset
insert into stock_doc_lines (stock_doc_id, item_id, qty) values (:'wst', :'drawer', 1);
select post_stock_doc(:'wst');
select t.ok('waste: 1 drawer written off', t.onhand(:'drawer') = 9 and t.bal(:'org','waste') = 50000);
select t.fails('client cannot insert a posted stock document', format($q$insert into stock_docs (org_id, kind, from_warehouse_id, status) values (%L,'waste',%L,'posted')$q$, :'org', :'w1'), 'posting function');

update orgs set allow_negative_stock = false where id = :'org';
insert into documents (org_id, branch_id, warehouse_id, kind, party_id) values (:'org', :'br', :'w1', 'tax_invoice', :'cust') returning id as inv2 \gset
insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate) values (:'inv2', :'org', 1, :'drawer', 'درج', 3, 120000, 'S', 15);
select t.fails('negative stock blocked when the setting is off (drawers are in the other warehouse)', format('select post_sales_invoice(%L)', :'inv2'), 'NOT_ENOUGH_STOCK');

select t.ok('books balance after everything', (select sum(debit) = sum(credit) from trial_balance where org_id = :'org'));
select t.ok('every posted entry balances', not exists (select 1 from journal_lines l join journal_entries e on e.id = l.entry_id where e.org_id = :'org' group by e.id having sum(debit) <> sum(credit)));

-- ================= another company =================
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000bb"}', false);
select create_org('شركة أخرى') as org_b \gset
select t.ok('stranger: 0 of our boms / orders / stock docs / expenses / roles',
  (select count(*) from boms) + (select count(*) from mfg_orders) + (select count(*) from stock_docs) + (select count(*) from expenses) = 0
  and (select count(*) from roles where org_id = :'org') = 0);
select t.fails('stranger cannot post our order', format('select post_stock_doc(%L)', :'cnt'), 'not allowed');
select t.fails('stranger cannot use our role', format($q$select invite_member(%L, 'x@example.com', %L)$q$, :'org_b', :'r_custom'), 'role not found');
reset role;

select (case when ok then 'PASS ' else 'FAIL ' end) || name || case when not ok then '  [' || info || ']' else '' end as result from t.results order by n;
select count(*) filter (where ok) || ' / ' || count(*) || ' passed (operations)' as summary from t.results;
