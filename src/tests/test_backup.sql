-- Backup / restore and report datasets (migration 15), as the browser roles.
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
-- what the browser does before restoring: give every row a new id (references follow)
create function t.remap(b jsonb) returns jsonb language plpgsql as $$
declare txt text := b::text; old text;
begin
  for old in select distinct v from (select b->'org'->>'id' v union all select r->>'id' from jsonb_each(b->'tables') e(k, rows), jsonb_array_elements(rows) r) s where v ~ '^[0-9a-f-]{36}$' loop
    txt := replace(txt, old, gen_random_uuid()::text);
  end loop;
  return txt::jsonb;
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
insert into cost_centers (org_id, code, name, project_type) values (:'org', 'P-001', 'كرفان', 'customer');
insert into feasibility_studies (org_id, name) values (:'org', 'دراسة');
insert into saved_reports (org_id, name, definition) values (:'org', 'مبيعات حسب العميل', '{"ds":"sales_lines","group":["party"]}') returning id as rep \gset
select t.ok('owner saves a custom report; created_by forced', (select created_by from saved_reports where id = :'rep') = '00000000-0000-0000-0000-0000000000aa');
select save_role(:'org', null, 'مشرف', '{"manufacturing":["view","create"]}') as r1 \gset
select invite_member(:'org', 'sup@example.com', :'r1');
reset role; insert into auth.users values ('00000000-0000-0000-0000-0000000000c1','sup@example.com'); set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1"}', false); select accept_invitations();
select t.fails('member without the backup permission cannot export', format('select export_org(%L)', :'org'), 'not allowed');
select t.ok('member without sales permission sees no sales lines', jsonb_array_length(report_dataset(:'org', 'sales_lines', current_date - 30, current_date)) = 0);
select t.fails('member without reports permission cannot save reports', format($q$insert into saved_reports (org_id, name, definition) values (%L, 'x', '{}')$q$, :'org'), 'row-level|policy');
select t.fails('member cannot restore over the company', format($q$select import_org('{"format":"craftland-backup","version":1,"org":{"id":"%s"},"tables":{}}', 'replace', %L)$q$, gen_random_uuid(), :'org'), 'not allowed');

-- ---------- export ----------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa"}', false);
insert into t.kv values ('b', export_org(:'org'));
select t.ok('backup has format, company and every table', (select v->>'format' from t.kv where k = 'b') = 'craftland-backup' and (select v->'org'->>'name_ar' from t.kv where k = 'b') = 'كرافت لاند'
  and (select count(*) from jsonb_object_keys((select v->'tables' from t.kv where k = 'b'))) >= 40);
select t.ok('backup holds the rows', (select jsonb_array_length(v->'tables'->'journal_lines') from t.kv where k = 'b') = (select count(*) from journal_lines where org_id = :'org')
  and (select jsonb_array_length(v->'tables'->'payment_allocations') from t.kv where k = 'b') = 1 and (select jsonb_array_length(v->'tables'->'accounts') from t.kv where k = 'b') = (select count(*) from accounts where org_id = :'org'));
select t.ok('backup leaves out members, invitations and portal links', not ((select v->'tables' from t.kv where k = 'b') ?| array['members','invitations','portal_links']));
select t.ok('each export is logged', (select count(*) from backup_log where org_id = :'org' and source = 'app') = 1);
select export_org(:'org', 'script') is not null as x \gset
select t.ok('script exports logged as script', (select count(*) from backup_log where org_id = :'org' and source = 'script') = 1);
select t.fails('unknown source rejected', format($q$select export_org(%L, 'restore')$q$, :'org'), 'not allowed');

-- ---------- restore as a new company ----------
insert into t.kv values ('nb', t.remap((select v from t.kv where k = 'b')));
select import_org((select v from t.kv where k = 'nb'), 'new') as org2 \gset
select t.ok('restored company has the same data', (select count(*) from journal_lines where org_id = :'org2') = (select count(*) from journal_lines where org_id = :'org')
  and (select count(*) from document_lines l join documents d on d.id = l.document_id where d.org_id = :'org2') = (select count(*) from document_lines where org_id = :'org')
  and (select count(*) from payment_allocations a join payments p on p.id = a.payment_id where p.org_id = :'org2') = 1
  and (select count(*) from saved_reports where org_id = :'org2') = 1 and (select count(*) from feasibility_studies where org_id = :'org2') = 1);
select t.ok('restored numbers and balances match', (select number from documents where org_id = :'org2' and kind = 'tax_invoice') = (select number from documents where id = :'inv')
  and (select sum(debit) from journal_lines where org_id = :'org2') = (select sum(debit) from journal_lines where org_id = :'org')
  and (select last_value from counters where org_id = :'org2' and series = 'tax_invoice') is not distinct from (select last_value from counters where org_id = :'org' and series = 'tax_invoice'));
select t.ok('restorer is the owner of the new company; nobody else', (select array_agg(user_id::text) from members where org_id = :'org2') = array['00000000-0000-0000-0000-0000000000aa']);
select t.ok('original company untouched', (select name_ar from orgs where id = :'org') = 'كرافت لاند' and (select count(*) from members where org_id = :'org') = 2);
select t.ok('restore logged on the new company', (select count(*) from backup_log where org_id = :'org2' and source = 'restore') = 1);
select t.fails('same file twice → ids taken', format('select import_org(%L, %L)', (select v from t.kv where k = 'nb'), 'new'), 'BACKUP_IDS_TAKEN');
select t.fails('not a backup file', $q$select import_org('{"format":"x"}', 'new')$q$, 'BACKUP_INVALID');
-- tampering: rows of another company, or references into another company, are refused and nothing is written
select t.fails('a row of another company is refused', format('select import_org(%L, %L)',
  jsonb_set(t.remap((select v from t.kv where k = 'b')), '{tables,parties,0,org_id}', to_jsonb(:'org'::text)), 'new'), 'another company');
select t.fails('a reference to another company''s item is refused', format('select import_org(%L, %L)',
  (select jsonb_set(x, '{tables,document_lines,0,item_id}', to_jsonb(:'prod'::text)) from t.remap((select v from t.kv where k = 'b')) x), 'new'), 'broken reference');
select t.fails('lines attached to another company''s document are refused', format('select import_org(%L, %L)',
  (select jsonb_set(x, '{tables,payment_allocations,0,payment_id}', to_jsonb(:'pv'::text)) from t.remap((select v from t.kv where k = 'b')) x), 'new'), 'without their document');
select t.ok('refused restores left nothing behind', (select count(*) from orgs) = 2);

-- ---------- restore in place of the current company ----------
select import_org(t.remap((select v from t.kv where k = 'b')), 'replace', :'org') as org3 \gset
select t.ok('team moved to the restored company with the same role', (select r.name from members m join roles r on r.id = m.role_id where m.org_id = :'org3' and m.user_id = '00000000-0000-0000-0000-0000000000c1') = 'مشرف');
select t.ok('old company kept as an archive for the owner only', (select name_ar from orgs where id = :'org') like 'كرافت لاند — أرشيف %' and (select count(*) from members where org_id = :'org') = 1
  and (select count(*) from journal_lines where org_id = :'org') > 0);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1"}', false);
select t.ok('member now sees the restored company only', (select count(*) from orgs where id = :'org') = 0 and (select count(*) from orgs where id = :'org3') = 1);

-- ---------- report datasets ----------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa"}', false);
select t.ok('sales lines: net, cost and profit', (select (x->>'net')::bigint = 300000 and (x->>'cost')::bigint = 120000 and (x->>'profit')::bigint = 180000 and x->>'party' = 'عميل'
  from jsonb_array_elements(report_dataset(:'org3', 'sales_lines', current_date - 30, current_date)) x limit 1));
select t.ok('every dataset runs', (select bool_and(jsonb_typeof(report_dataset(:'org3', d, current_date - 365, current_date)) = 'array')
  from unnest(array['sales_lines','sales_docs','purchase_lines','expenses','journal','stock_moves','items','parties','projects','timesheets','payslips','tasks']) d));
select t.ok('items dataset: stock on hand and value', (select (x->>'on_hand')::numeric = 7 and (x->>'stock_value')::bigint = 280000 from jsonb_array_elements(report_dataset(:'org3', 'items', current_date - 30, current_date)) x where x->>'item' = 'منتج'));
select t.ok('parties dataset: receivable', (select (x->>'receivable')::bigint from jsonb_array_elements(report_dataset(:'org3', 'parties', current_date - 30, current_date)) x where x->>'party' = 'عميل') = 345000);
select t.fails('unknown dataset', format($q$select report_dataset(%L, 'secrets', current_date, current_date)$q$, :'org3'), 'not allowed');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000bb"}', false);
select t.fails('other company cannot read our datasets', format($q$select report_dataset(%L, 'journal', current_date - 30, current_date)$q$, :'org3'), 'not allowed');
select t.fails('other company cannot export us', format('select export_org(%L)', :'org3'), 'not allowed');
select t.fails('the raw row copier is not callable', $q$select restore_rows('orgs', '[]')$q$, 'permission denied');
reset role; set role anon;
select t.fails('anon cannot export', format('select export_org(%L)', :'org3'), 'permission denied');
reset role;
select (case when ok then 'PASS ' else 'FAIL ' end) || name || case when not ok then '  [' || info || ']' else '' end as result from t.results order by n;
select count(*) filter (where ok) || ' / ' || count(*) || ' passed (backup & reports)' as summary from t.results;
