-- VAT rounding per rate (migration 18), as the browser roles.
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
insert into items (org_id, kind, name_ar, sale_price) values (:'org', 'service', 'خدمة', 3) returning id as svc \gset
-- three lines of 0.03 SAR: each line VAT rounds to 0.00, the invoice VAT is 15% of 0.09 = 0.0135 -> 0.01
insert into documents (org_id, branch_id, warehouse_id, kind, party_id, issue_date) values (:'org', :'br', :'w1', 'tax_invoice', :'cust', current_date) returning id as inv \gset
insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate) values
  (:'inv', :'org', 1, :'svc', 'a', 1, 3, 'S', 15), (:'inv', :'org', 2, :'svc', 'b', 1, 3, 'S', 15), (:'inv', :'org', 3, :'svc', 'c', 1, 3, 'S', 15);
select post_sales_invoice(:'inv');
select t.ok('lines keep their own rounded VAT', (select sum(line_vat) from document_lines where document_id = :'inv') = 0);
select t.ok('invoice VAT rounded once per rate', (select vat_total from documents where id = :'inv') = 1 and (select total from documents where id = :'inv') = 10);
select t.ok('journal balances with the rounded VAT', (select sum(debit) = sum(credit) and sum(credit) filter (where a.code like '22%' or a.name_ar like '%ضريب%') >= 1
  from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id where e.org_id = :'org' and e.source_id = :'inv'));
-- mixed rates: 15% and 0% grouped separately
insert into documents (org_id, branch_id, warehouse_id, kind, party_id, issue_date) values (:'org', :'br', :'w1', 'tax_invoice', :'cust', current_date) returning id as inv2 \gset
insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate) values
  (:'inv2', :'org', 1, :'svc', 'a', 1, 33333, 'S', 15), (:'inv2', :'org', 2, :'svc', 'b', 1, 33333, 'S', 15), (:'inv2', :'org', 3, :'svc', 'z', 1, 1000, 'Z', 0);
select post_sales_invoice(:'inv2');
select t.ok('mixed rates: 15% part rounded on 666.66, zero-rated adds nothing', (select vat_total from documents where id = :'inv2') = 10000);
select t.fails('compute_lines is not callable from the browser', format('select compute_lines(%L)', :'inv2'), 'permission denied');
reset role;
select (case when ok then 'PASS ' else 'FAIL ' end) || name || case when not ok then '  [' || info || ']' else '' end as result from t.results order by n;
select count(*) filter (where ok) || ' / ' || count(*) || ' passed (vat rounding)' as summary from t.results;
