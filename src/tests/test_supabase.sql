-- Tests the database exactly as the browser will use it on Supabase:
-- role "authenticated", user id from the JWT, the same inserts/RPC calls
-- the app's SupabaseAPI makes. Run: bash tests/run_supabase_tests.sh
\set ON_ERROR_STOP on
\pset footer off
create schema t;
create table t.results (n serial, name text, ok boolean, info text);
grant usage on schema t to anon, authenticated; grant all on t.results to anon, authenticated; grant usage on sequence t.results_n_seq to anon, authenticated;
create function t.ok(name text, cond boolean, info text default '') returns void language sql as $$ insert into t.results (name, ok, info) values (name, coalesce(cond,false), info) $$;
create function t.fails(name text, q text, pattern text) returns void language plpgsql as $$
begin
  begin execute q; insert into t.results (name, ok, info) values (name, false, 'no error');
  exception when others then insert into t.results (name, ok, info) values (name, sqlerrm ~* pattern, sqlerrm); end;
end $$;
grant execute on all functions in schema t to anon, authenticated;
insert into auth.users values ('00000000-0000-0000-0000-0000000000aa','ali@example.com'),('00000000-0000-0000-0000-0000000000bb','other@example.com');

-- ================= user A (Craft Land owner) =================
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa","role":"authenticated"}', false);

select create_org('كرافت لاند', '300000000000003', '1010000000', 'الرياض', 'طريق الخرج', '1234', '12345', 'السلي', 'manufacturing') as org \gset
select t.ok('create_org: owner membership', (select role from members where org_id = :'org') = 'owner');
select t.ok('create_org: chart of accounts seeded', (select count(*) from accounts where org_id = :'org') >= 50, (select count(*)::text from accounts where org_id = :'org'));
select id as wh, branch_id as br from warehouses where org_id = :'org' limit 1 \gset

insert into parties (org_id, kind, name, vat_number) values (:'org', 'customer', 'شركة الرحلات', '311111111111113') returning id as cust \gset
insert into items (org_id, kind, name_ar, sku, sale_price, avg_cost) values (:'org', 'product', 'كرفان 6 متر', 'CR-6', 5000000, 2050000) returning id as item \gset
select t.fails('duplicate SKU rejected', format($q$insert into items (org_id, kind, name_ar, sku) values (%L,'product','x','CR-6')$q$, :'org'), 'duplicate key');

-- draft with forged server fields → they are reset
insert into documents (org_id, branch_id, warehouse_id, kind, party_id, issue_date, total, number, amount_paid)
values (:'org', :'br', :'wh', 'tax_invoice', :'cust', '2026-11-25', 1, 'HACK', 0) returning id as inv \gset
select t.ok('draft: forged total/number ignored', (select total = 0 and number is null from documents where id = :'inv'));
insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, discount, tax_category, vat_rate, line_net, line_vat)
values (:'inv', :'org', 1, :'item', 'كرفان 6 متر', 1, 5000000, 0, 'S', 15, 999, 999);
select t.ok('draft line: forged line_net ignored', (select line_net = 0 from document_lines where document_id = :'inv'));
-- the app re-saves a draft as delete + insert lines
delete from document_lines where document_id = :'inv';
insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, discount, tax_category, vat_rate)
values (:'inv', :'org', 1, :'item', 'كرفان 6 متر', 1, 5000000, 0, 'S', 15);
select t.fails('cannot insert a posted invoice directly', format($q$insert into documents (org_id, branch_id, kind, party_id, status) values (%L,%L,'tax_invoice',%L,'posted')$q$, :'org', :'br', :'cust'), 'posting function');

select post_sales_invoice(:'inv');
select t.ok('post: totals computed on server (57,500.00)', (select subtotal = 5000000 and vat_total = 750000 and total = 5750000 from documents where id = :'inv'));
select t.ok('post: number assigned INV-00001', (select number from documents where id = :'inv') = 'INV-00001');
select t.ok('post: stock went out', (select qty from stock_balances where item_id = :'item') = -1);
select t.fails('cannot edit a posted invoice', format('update documents set note = %L where id = %L', 'x', :'inv'), 'cannot be edited');
select t.fails('cannot delete posted invoice lines', format('delete from document_lines where document_id = %L', :'inv'), 'cannot be changed');
select t.fails('cannot add lines to a posted invoice', format($q$insert into document_lines (document_id, org_id, line_no, description, qty, unit_price, tax_category, vat_rate) values (%L,%L,2,'x',1,1,'S',15)$q$, :'inv', :'org'), 'cannot be changed');
select t.fails('cannot post twice', format('select post_sales_invoice(%L)', :'inv'), 'already posted');

-- receipt 30,000 against the invoice (same calls as the app)
insert into payments (org_id, kind, party_id, pay_date, amount, method, cash_account_id, reference)
values (:'org', 'receipt', :'cust', '2026-11-25', 3000000, 'bank_transfer', (select id from accounts where org_id = :'org' and system_key = 'bank'), 'TRX-1') returning id as pay \gset
insert into payment_allocations (payment_id, document_id, amount) values (:'pay', :'inv', 3000000);
select post_payment(:'pay');
select t.ok('receipt: invoice now partial', (select payment_status = 'partial' and amount_paid = 3000000 from documents where id = :'inv'));
select t.ok('receipt: numbered RV-00001', (select number from payments where id = :'pay') = 'RV-00001');
select t.fails('cannot edit a posted receipt', format('update payments set amount = 1 where id = %L', :'pay'), 'cannot be edited');

insert into payments (org_id, kind, party_id, pay_date, amount, method, cash_account_id)
values (:'org', 'receipt', :'cust', '2026-11-25', 9000000, 'cash', (select id from accounts where org_id = :'org' and system_key = 'cash')) returning id as pay2 \gset
insert into payment_allocations (payment_id, document_id, amount) values (:'pay2', :'inv', 9000000);
select t.fails('over-allocation rejected on post', format('select post_payment(%L)', :'pay2'), 'still open');
delete from payment_allocations where payment_id = :'pay2';
delete from payments where id = :'pay2';
select t.ok('draft receipt can be deleted', not exists (select 1 from payments where id = :'pay2'));

select t.ok('trial balance balances', (select sum(debit) = sum(credit) from trial_balance where org_id = :'org'));
select t.ok('trial balance: receivable 27,500.00', (select balance from trial_balance where org_id = :'org' and code = (select code from accounts where org_id = :'org' and system_key = 'ar')) = 2750000);

update orgs set name_ar = 'كرافت لاند للصناعة', invoice_footer = 'شكراً لكم', logo_path = 'data:image/png;base64,AAAA' where id = :'org';
select t.ok('org profile editable', (select name_ar from orgs where id = :'org') = 'كرافت لاند للصناعة');
select t.fails('cannot change own plan', format($q$update orgs set plan = 'pro' where id = %L$q$, :'org'), 'permission denied');
select t.fails('cannot extend own trial', format($q$update orgs set trial_ends_at = now() + interval '9 years' where id = %L$q$, :'org'), 'permission denied');
select t.fails('cannot write journal directly', format($q$insert into journal_entries (org_id, number, entry_date, source_type) values (%L, 999, current_date, 'manual')$q$, :'org'), 'permission denied');
select t.fails('cannot add self as member elsewhere', format($q$insert into members values (%L, '00000000-0000-0000-0000-0000000000bb', 'owner')$q$, :'org'), 'permission denied');
select t.fails('internal seed_chart not callable', format('select seed_chart(%L)', :'org'), 'permission denied');
select t.fails('internal next_number not callable', format($q$select next_number(%L, 'inv')$q$, :'org'), 'permission denied');

-- the app's "delete draft" (lines go with it)
insert into documents (org_id, branch_id, warehouse_id, kind, party_id) values (:'org', :'br', :'wh', 'tax_invoice', :'cust') returning id as d3 \gset
insert into document_lines (document_id, org_id, line_no, description, qty, unit_price, tax_category, vat_rate) values (:'d3', :'org', 1, 'x', 1, 100, 'S', 15);
delete from documents where id = :'d3' and status = 'draft';
select t.ok('draft invoice with lines can be deleted', not exists (select 1 from documents where id = :'d3') and not exists (select 1 from document_lines where document_id = :'d3'));
delete from documents where id = :'inv';
select t.ok('posted invoice cannot be deleted', exists (select 1 from documents where id = :'inv'));

-- a second draft that user B will try to touch
insert into documents (org_id, branch_id, warehouse_id, kind, party_id) values (:'org', :'br', :'wh', 'tax_invoice', :'cust') returning id as draft_a \gset

-- ================= user B (another company) =================
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000bb","role":"authenticated"}', false);
select t.ok('stranger: sees 0 orgs', (select count(*) from orgs) = 0);
select t.ok('stranger: sees 0 documents', (select count(*) from documents) = 0);
select t.ok('stranger: sees 0 customers', (select count(*) from parties) = 0);
select t.ok('stranger: sees 0 stock balances', (select count(*) from stock_balances) = 0);
select t.ok('stranger: sees 0 trial balance rows', (select count(*) from trial_balance) = 0);
select t.ok('stranger: sees 0 journal lines', (select count(*) from journal_lines) = 0);
select create_org('شركة أخرى') as org_b \gset
select id as wh_b, branch_id as br_b from warehouses where org_id = :'org_b' limit 1 \gset
select t.ok('stranger: still sees only own org', (select count(*) from orgs) = 1);
select t.fails('stranger: cannot post A''s draft', format('select post_sales_invoice(%L)', :'draft_a'), 'not allowed');
select t.fails('stranger: cannot use A''s customer', format($q$insert into documents (org_id, branch_id, kind, party_id) values (%L,%L,'tax_invoice',%L)$q$, :'org_b', :'br_b', :'cust'), 'customer not found');
insert into documents (org_id, branch_id, kind) values (:'org_b', :'br_b', 'simplified_invoice') returning id as doc_b \gset
select t.fails('stranger: cannot use A''s item on a line', format($q$insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate) values (%L,%L,1,%L,'x',1,1,'S',15)$q$, :'doc_b', :'org_b', :'item'), 'item not found');
insert into payments (org_id, kind, amount, method, cash_account_id) values (:'org_b', 'receipt', 100, 'cash', (select id from accounts where org_id = :'org_b' and system_key = 'cash')) returning id as pay_b \gset
select t.fails('stranger: cannot allocate to A''s invoice', format('insert into payment_allocations values (%L, %L, 100)', :'pay_b', :'inv'), 'document not found|violates');
select t.fails('stranger: cannot pay into A''s bank account', format($q$insert into payments (org_id, kind, amount, method, cash_account_id) values (%L,'receipt',100,'cash',(select id from accounts where org_id = %L limit 1))$q$, :'org_b', :'org'), 'account not found|violates');
select t.fails('stranger: cannot update A''s org', format($q$update orgs set name_ar = 'x' where id = %L returning id$q$, :'org'), 'xx_no_rows_expected');

-- ================= not signed in =================
reset role; set role anon;
select set_config('request.jwt.claims', '', false);
select t.fails('anon: cannot read customers', 'select * from parties', 'permission denied');
select t.fails('anon: cannot create a company', $q$select create_org('x')$q$, 'permission denied');
reset role;

-- orgs update by stranger above should silently match 0 rows; recheck
select t.ok('A''s org name unchanged by stranger', (select name_ar from orgs where id = :'org') = 'كرافت لاند للصناعة');
delete from t.results where name = 'stranger: cannot update A''s org';

select (case when ok then 'PASS ' else 'FAIL ' end) || name || case when not ok then '  [' || info || ']' else '' end as result from t.results order by n;
select count(*) filter (where ok) || ' / ' || count(*) || ' passed' as summary from t.results;
