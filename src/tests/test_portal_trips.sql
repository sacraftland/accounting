-- Customer portal & van trips (migration 10), as the browser roles.
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
grant execute on all functions in schema t to anon, authenticated;

insert into platform_admins values ('owner@example.com'), ('other@example.com');
insert into auth.users values ('00000000-0000-0000-0000-0000000000aa','owner@example.com'), ('00000000-0000-0000-0000-0000000000bb','other@example.com');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa"}', false);
select create_org('كرافت لاند', '300000000000003') as org \gset
select id as br, (select id from warehouses where org_id = :'org' limit 1) as w1 from branches where org_id = :'org' limit 1 \gset
insert into parties (org_id, kind, name, vat_number) values (:'org', 'customer', 'مؤسسة الرحلات', '311111111111113') returning id as cust \gset
insert into parties (org_id, kind, name) values (:'org', 'supplier', 'مورد') returning id as sup \gset
insert into items (org_id, kind, name_ar, sku, sale_price) values (:'org', 'product', 'كرسي تخييم', 'CH', 10000) returning id as it \gset

-- stock into main warehouse
insert into stock_docs (org_id, kind, to_warehouse_id) values (:'org', 'opening', :'w1') returning id as op \gset
insert into stock_doc_lines (stock_doc_id, line_no, item_id, qty, unit_cost) values (:'op', 1, :'it', 50, 4000);
select post_stock_doc(:'op');

-- an invoice for the customer
insert into documents (org_id, branch_id, warehouse_id, kind, party_id) values (:'org', :'br', :'w1', 'tax_invoice', :'cust') returning id as inv \gset
insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate) values (:'inv', :'org', 1, :'it', 'كرسي', 3, 10000, 'S', 15);
select post_sales_invoice(:'inv');

-- ===== portal =====
select create_portal_link(:'cust') as tok \gset
select t.ok('portal token is 64 hex chars', :'tok' ~ '^[0-9a-f]{64}$');
select t.ok('same link returned while active', create_portal_link(:'cust') = :'tok');
select t.fails('no portal link for a supplier', format('select create_portal_link(%L)', :'sup'), 'not allowed');
select t.ok('client cannot insert links directly', not has_table_privilege('authenticated', 'portal_links', 'insert'));

reset role; set role anon; select set_config('request.jwt.claims', '{}', false);
select portal_view(:'tok') as pv \gset
select t.ok('anon portal: shows customer, invoice and balance 345.00',
  (:'pv'::jsonb->'party'->>'name') = 'مؤسسة الرحلات' and jsonb_array_length(:'pv'::jsonb->'documents') = 1 and (:'pv'::jsonb->>'balance')::bigint = 34500, :'pv');
select t.ok('anon portal: invoice detail with lines', jsonb_array_length(portal_document(:'tok', :'inv')->'lines') = 1);
select t.fails('anon cannot guess a token', $q$select portal_view(repeat('a', 64))$q$, 'PORTAL_INVALID');
select t.fails('anon cannot read tables', 'select count(*) from documents', 'permission denied');
select t.fails('anon cannot create links', format('select create_portal_link(%L)', :'cust'), 'permission denied');
reset role; set role authenticated;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000bb"}', false);
select create_org('شركة أخرى', null) as org2 \gset
select t.fails('other company cannot make a link for our customer', format('select create_portal_link(%L)', :'cust'), 'not allowed');
select t.fails('other company cannot revoke our link', format('select revoke_portal_link(%L)', :'cust'), 'not allowed');
select t.ok('other company sees no links', (select count(*) from portal_links) = 0);

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa"}', false);
select revoke_portal_link(:'cust');
reset role; set role anon;
select t.fails('revoked link stops working', format('select portal_view(%L)', :'tok'), 'PORTAL_INVALID');
reset role; set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa"}', false);
select t.ok('a new link is different', create_portal_link(:'cust') <> :'tok');

-- ===== van trips =====
insert into warehouses (org_id, branch_id, name, kind) values (:'org', :'br', 'سيارة 1', 'van') returning id as van \gset
select t.fails('trip needs a van warehouse', format($q$select open_trip(%L, %L, %L, null, 'سالم', current_date)$q$, :'org', :'w1', :'van'), 'TRIP_VAN');
select open_trip(:'org', :'van', :'w1', null, 'سالم', current_date, 'الدمام – الخبر') as trip \gset
select t.ok('trip opened with number', (select number from van_trips where id = :'trip') = 'TRP-00001' and (select driver_name from van_trips where id = :'trip') = 'سالم');
select t.fails('one open trip per van', format($q$select open_trip(%L, %L, %L, null, 'x', current_date)$q$, :'org', :'van', :'w1'), 'TRIP_OPEN');
select t.ok('client cannot write trips directly', not has_table_privilege('authenticated', 'van_trips', 'insert') and not has_table_privilege('authenticated', 'van_trips', 'update'));
-- load 20, sell 12 from the van, return 8
insert into stock_docs (org_id, kind, from_warehouse_id, to_warehouse_id) values (:'org', 'transfer', :'w1', :'van') returning id as ld \gset
insert into stock_doc_lines (stock_doc_id, line_no, item_id, qty) values (:'ld', 1, :'it', 20); select post_stock_doc(:'ld');
insert into documents (org_id, branch_id, warehouse_id, kind) values (:'org', :'br', :'van', 'simplified_invoice') returning id as vs \gset
insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate) values (:'vs', :'org', 1, :'it', 'كرسي', 12, 10000, 'S', 15);
select post_sales_invoice(:'vs');
select t.ok('van stock after sale = 8', (select qty from stock_by_warehouse where warehouse_id = :'van' and item_id = :'it') = 8);
insert into stock_docs (org_id, kind, from_warehouse_id, to_warehouse_id) values (:'org', 'transfer', :'van', :'w1') returning id as rt \gset
insert into stock_doc_lines (stock_doc_id, line_no, item_id, qty) values (:'rt', 1, :'it', 8); select post_stock_doc(:'rt');
select close_trip(:'trip', 138000, 'سلّم النقد كاملاً');
select t.ok('trip closed with cash handed', (select status || ':' || cash_handed from van_trips where id = :'trip') = 'closed:138000');
select t.fails('cannot close twice', format('select close_trip(%L, 0)', :'trip'), 'TRIP_CLOSED');
select t.ok('van can open a new trip after closing', open_trip(:'org', :'van', :'w1', null, 'سالم', current_date) is not null);

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000bb"}', false);
select t.ok('other company sees no trips', (select count(*) from van_trips) = 0);
select t.fails('other company cannot open a trip on our van', format($q$select open_trip(%L, %L, %L, null, 'x', current_date)$q$, :'org', :'van', :'w1'), 'not allowed');
select t.fails('other company cannot close our trip', format('select close_trip(%L, 0)', :'trip'), 'not allowed');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa"}', false);
select t.ok('books balance', (select sum(debit) = sum(credit) from journal_lines where org_id = :'org'));
reset role;
select (case when ok then 'PASS ' else 'FAIL ' end) || name || case when not ok then '  [' || info || ']' else '' end as result from t.results order by n;
select count(*) filter (where ok) || ' / ' || count(*) || ' passed (portal & trips)' as summary from t.results;
