-- ZATCA devices and keys (migration 19).
\set ON_ERROR_STOP on
create schema t;
create table t.results (n serial, name text, ok boolean, info text);
grant usage on schema t to anon, authenticated, service_role; grant all on t.results to anon, authenticated, service_role; grant usage on sequence t.results_n_seq to anon, authenticated, service_role;
create function t.ok(name text, cond boolean, info text default '') returns void language sql as $$ insert into t.results (name, ok, info) values (name, coalesce(cond,false), info) $$;
create function t.fails(name text, q text, pattern text) returns void language plpgsql as $$
begin
  begin execute q; insert into t.results (name, ok, info) values (name, false, 'no error');
  exception when others then insert into t.results (name, ok, info) values (name, sqlerrm ~* pattern, sqlerrm); end;
end $$;
create table t.kv (k text primary key, v jsonb);
grant all on t.kv to anon, authenticated, service_role;
grant execute on all functions in schema t to anon, authenticated, service_role;
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
select id as inv from documents where org_id = :'org' and kind = 'tax_invoice' limit 1 \gset
select t.fails('browser cannot read device keys', 'select * from zatca_secrets', 'permission denied');
select t.fails('browser cannot reserve a counter', format('select zatca_reserve(%L)', gen_random_uuid()), 'permission denied');
select t.fails('browser cannot record a signed invoice', format($q$select zatca_commit(%L,%L,1,'x','y','reported',null,null,'{}')$q$, gen_random_uuid(), :'inv'), 'permission denied');
reset role; set role service_role;
insert into zatca_devices (org_id, branch_id, egs_serial) values (:'org', :'br', '1-CraftLand|2-Accounting|3-x') returning id as dev \gset
insert into zatca_secrets (device_id, private_key_pem) values (:'dev', 'KEY');
select zatca_reserve(:'dev') as r1 \gset
select t.ok('first counter is 1 with the initial PIH', (:'r1'::jsonb ->> 'icv') = '1' and (:'r1'::jsonb ->> 'pih') = 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==');
select t.fails('a second invoice waits while the device is busy', format('select zatca_reserve(%L)', :'dev'), 'ZATCA_DEVICE_BUSY');
select zatca_commit(:'dev', :'inv', 1, :'r1'::jsonb ->> 'pih', 'HASH1', 'cleared', '<x/>', 'QR', '{"ok":true}');
select t.ok('commit moves the chain and frees the device', (select last_icv = 1 and last_hash = 'HASH1' and busy_until is null from zatca_devices where id = :'dev'));
select t.ok('commit stores the result on the invoice', (select zatca_status = 'cleared' and zatca_icv = 1 and zatca_hash = 'HASH1' and zatca_device_id = :'dev' from documents where id = :'inv'));
select zatca_reserve(:'dev') as r2 \gset
select t.ok('next counter is 2 and points at the last hash', (:'r2'::jsonb ->> 'icv') = '2' and (:'r2'::jsonb ->> 'pih') = 'HASH1');
select t.fails('a stale commit cannot fork the chain', format($q$select zatca_commit(%L,%L,1,'NWZl','H','reported',null,null,'{}')$q$, :'dev', :'inv'), 'ZATCA_CHAIN_MOVED');
select zatca_release(:'dev');
reset role; set role authenticated;
select t.ok('backups never contain device keys', not (select export_org(:'org') -> 'tables' ? 'zatca_secrets'));
select t.ok('the browser sees the device but not its key', (select count(*) from zatca_devices where id = :'dev') = 1);
select reset_org(:'org', 'all', 'كرافت لاند');
reset role;
select t.ok('company reset (all) removes the device and its key', not exists (select 1 from zatca_devices where id = :'dev') and not exists (select 1 from zatca_secrets where device_id = :'dev'));
select (case when ok then 'PASS ' else 'FAIL ' end) || name || case when not ok then '  [' || info || ']' else '' end as result from t.results order by n;
select count(*) filter (where ok) || ' / ' || count(*) || ' passed (zatca devices)' as summary from t.results;
