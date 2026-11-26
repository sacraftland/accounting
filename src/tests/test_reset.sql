-- Company reset (migration 17), as the browser roles.
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
create table t.kv (k text primary key, v jsonb);
grant all on t.kv to anon, authenticated;
grant execute on all functions in schema t to anon, authenticated;
insert into platform_admins values ('owner@example.com'), ('other@example.com');
insert into auth.users values ('00000000-0000-0000-0000-0000000000aa','owner@example.com'), ('00000000-0000-0000-0000-0000000000bb','other@example.com');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa"}', false);
select create_org('كرافت لاند', '300000000000003') as org \gset
select id as w1, branch_id as br from warehouses where org_id = :'org' limit 1 \gset
insert into parties (org_id, kind, name, vat_number, city, street, building_no, postal_code) values (:'org', 'customer', 'عميل', '311111111111113', 'الرياض', 'ش', '1', '12345') returning id as cust \gset
insert into parties (org_id, kind, name, vat_number) values (:'org', 'supplier', 'مورد', '322222222222223') returning id as sup \gset
insert into items (org_id, kind, name_ar, sale_price) values (:'org', 'product', 'منتج', 100000) returning id as prod \gset
insert into documents (org_id, branch_id, warehouse_id, kind, party_id, issue_date) values (:'org', :'br', :'w1', 'purchase_bill', :'sup', current_date - 5) returning id as bill \gset
insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate) values (:'bill', :'org', 1, :'prod', 'x', 10, 40000, 'S', 15);
select post_purchase_bill(:'bill');
insert into documents (org_id, branch_id, warehouse_id, kind, party_id, issue_date) values (:'org', :'br', :'w1', 'tax_invoice', :'cust', current_date - 2) returning id as inv \gset
insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate) values (:'inv', :'org', 1, :'prod', 'x', 3, 100000, 'S', 15);
select post_sales_invoice(:'inv');
insert into payments (org_id, kind, party_id, amount, method, cash_account_id) values (:'org', 'payment', :'sup', 100000, 'bank_transfer', (select id from accounts where org_id = :'org' and system_key = 'bank')) returning id as pv \gset
insert into payment_allocations values (:'pv', :'bill', 100000);
select post_payment(:'pv');
insert into cost_centers (org_id, code, name, project_type, is_project) values (:'org', 'P-001', 'كرفان', 'customer', true) returning id as proj \gset
insert into cost_centers (org_id, code, name, project_type, is_project, is_template, source_project_id) values (:'org', 'T-001', 'قالب', 'customer', true, true, :'proj') returning id as tpl \gset
insert into employees (org_id, full_name, is_saudi, hire_date, basic_salary, cost_center_id) values (:'org', 'موظف', true, current_date - 100, 500000, :'proj') returning id as emp \gset
insert into feasibility_studies (org_id, name) values (:'org', 'دراسة');
insert into tasks (org_id, title) values (:'org', 'مهمة');
select save_role(:'org', null, 'مشرف', '{"sales":["view","create"]}') as r1 \gset
select invite_member(:'org', 'sup@example.com', :'r1');
reset role; insert into auth.users values ('00000000-0000-0000-0000-0000000000c1','sup@example.com'); set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1"}', false); select accept_invitations();
select t.fails('a member who is not the owner cannot reset', format($q$select reset_org(%L, 'ops', 'كرافت لاند')$q$, :'org'), 'not allowed');

-- a second company that must stay untouched
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000bb"}', false);
select create_org('شركة أخرى') as org2 \gset
insert into parties (org_id, kind, name, vat_number, city, street, building_no, postal_code) values (:'org2', 'customer', 'عميل آخر', '311111111111113', 'الرياض', 'ش', '1', '12345') returning id as c2 \gset
insert into items (org_id, kind, name_ar, sale_price) values (:'org2', 'service', 'خدمة', 50000) returning id as s2 \gset
select id as br2, (select id from warehouses where org_id = :'org2' limit 1) as w2 from branches where org_id = :'org2' limit 1 \gset
insert into documents (org_id, branch_id, warehouse_id, kind, party_id, issue_date) values (:'org2', :'br2', :'w2', 'tax_invoice', :'c2', current_date) returning id as inv2 \gset
insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate) values (:'inv2', :'org2', 1, :'s2', 'x', 1, 50000, 'S', 15);
select post_sales_invoice(:'inv2');
select count(*) as je2 from journal_lines where org_id = :'org2' \gset
select t.fails('another company owner cannot reset us', format($q$select reset_org(%L, 'ops', 'كرافت لاند')$q$, :'org'), 'not allowed');

-- ---------- ops reset ----------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa"}', false);
select t.fails('wrong confirmation name is refused', format($q$select reset_org(%L, 'ops', 'كرافت')$q$, :'org'), 'RESET_CONFIRM');
select t.fails('unknown mode is refused', format($q$select reset_org(%L, 'x', 'كرافت لاند')$q$, :'org'), 'not allowed');
select t.ok('before: there are invoices and entries', (select count(*) from documents where org_id = :'org') = 2 and (select count(*) from journal_lines where org_id = :'org') > 0);
select reset_org(:'org', 'ops', '  كرافت لاند ') as r \gset
select t.ok('ops: documents, entries, payments and stock are gone', (select count(*) from documents where org_id = :'org') = 0 and (select count(*) from journal_entries where org_id = :'org') = 0
  and (select count(*) from payments where org_id = :'org') = 0 and (select count(*) from stock_moves where org_id = :'org') = 0 and (select count(*) from tasks where org_id = :'org') = 0);
select t.ok('ops: numbering restarts', (select count(*) from counters where org_id = :'org') = 0);
select t.ok('ops: project gone, template kept and unlinked', not exists (select 1 from cost_centers where id = :'proj') and (select source_project_id from cost_centers where id = :'tpl') is null);
select t.ok('ops: employee kept, project link cleared', (select cost_center_id from employees where id = :'emp') is null);
select t.ok('ops: customers, items, accounts, study and roles kept', exists (select 1 from parties where id = :'cust') and exists (select 1 from items where id = :'prod')
  and (select count(*) from accounts where org_id = :'org') > 20 and exists (select 1 from feasibility_studies where org_id = :'org') and exists (select 1 from roles where org_id = :'org' and name = 'مشرف'));
select t.ok('ops: item cost reset', (select avg_cost from items where id = :'prod') = 0);
select t.ok('ops: logged in the audit log', exists (select 1 from audit_log where org_id = :'org' and action = 'reset_ops'));
reset role;
select t.ok('ops: other company untouched', (select count(*) from journal_lines where org_id = :'org2') = :je2 and (select count(*) from documents where org_id = :'org2') = 1);
set role authenticated;
select t.ok('ops: member still has access', exists (select 1 from members where org_id = :'org' and user_id = '00000000-0000-0000-0000-0000000000c1'));
-- the system works normally afterwards: a new invoice gets number 1
insert into documents (org_id, branch_id, warehouse_id, kind, party_id, issue_date) values (:'org', :'br', :'w1', 'tax_invoice', :'cust', current_date) returning id as inv3 \gset
insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate) values (:'inv3', :'org', 1, :'prod', 'x', 1, 100000, 'S', 15);
select post_sales_invoice(:'inv3');
select t.ok('after ops: first new invoice is numbered 00001', (select number from documents where id = :'inv3') like '%00001');

-- ---------- all reset ----------
select reset_org(:'org', 'all', 'كرافت لاند') as r2 \gset
select t.ok('all: customers, items, employees, studies gone', (select count(*) from parties where org_id = :'org') = 0 and (select count(*) from items where org_id = :'org') = 0
  and (select count(*) from employees where org_id = :'org') = 0 and (select count(*) from feasibility_studies where org_id = :'org') = 0 and (select count(*) from documents where org_id = :'org') = 0);
select t.ok('all: fresh chart, one branch, one warehouse', (select count(*) from accounts where org_id = :'org') > 20 and (select count(*) from branches where org_id = :'org') = 1 and (select count(*) from warehouses where org_id = :'org') = 1);
select t.ok('all: company profile, roles and members kept', (select vat_number from orgs where id = :'org') = '300000000000003' and exists (select 1 from roles where org_id = :'org' and name = 'مشرف')
  and (select count(*) from members where org_id = :'org') = 2);
select t.ok('all: logged', exists (select 1 from audit_log where org_id = :'org' and action = 'reset_all'));
reset role;
select t.ok('all: other company untouched', (select count(*) from journal_lines where org_id = :'org2') = :je2);
set role authenticated;
reset role; set role anon;
select t.fails('anon cannot reset', format($q$select reset_org(%L, 'ops', 'x')$q$, :'org'), 'permission denied');
reset role;
select (case when ok then 'PASS ' else 'FAIL ' end) || name || case when not ok then '  [' || info || ']' else '' end as result from t.results order by n;
select count(*) filter (where ok) || ' / ' || count(*) || ' passed (company reset)' as summary from t.results;
