\set ON_ERROR_STOP on
-- Supabase stand-ins
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true),'')::uuid $$;
\i schema.sql

select set_config('test.uid','00000000-0000-0000-0000-0000000000aa', false);
insert into orgs (id, name_ar, vat_number) values ('10000000-0000-0000-0000-000000000001','كرافت لاند','300000000000003');
insert into members values ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000aa','owner');
insert into branches (id, org_id, name) values ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','Main');
insert into warehouses (id, org_id, branch_id, name) values ('30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','WH');
insert into accounts (org_id, code, name_ar, type, system_key)
select '10000000-0000-0000-0000-000000000001', c, n, t, k from (values
 ('1101','الصندوق','asset','cash'),('1201','العملاء','asset','ar'),('1301','المخزون','asset','inventory'),
 ('1401','ضريبة المدخلات','asset','vat_in'),('2101','الموردون','liability','ap'),('2201','ضريبة المخرجات','liability','vat_out'),
 ('2301','تكاليف شحن مستحقة','liability','landed_cost_clearing'),('4101','المبيعات','revenue','sales'),('5101','تكلفة المبيعات','expense','cogs')) v(c,n,t,k);
insert into parties (id, org_id, kind, name, vat_number) values
 ('40000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','customer','عميل','311111111111113'),
 ('40000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','supplier','مورد','322222222222223');
insert into items (id, org_id, kind, name_ar, sale_price) values ('50000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','product','كرفان',5000000);

-- buy 2 @ 20,000 SAR + 1,000 SAR shipping (landed)
insert into documents (id, org_id, branch_id, warehouse_id, kind, party_id) values
 ('60000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','purchase_bill','40000000-0000-0000-0000-000000000002');
insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate)
values ('60000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',1,'50000000-0000-0000-0000-000000000001','كرفان',2,2000000,'S',15);
insert into landed_costs (org_id, bill_id, description, amount) values ('10000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001','شحن',100000);
select post_purchase_bill('60000000-0000-0000-0000-000000000001');
select 'avg_cost after purchase (expect 2050000)' as t, avg_cost from items;

-- sell 1 @ 50,000 SAR
insert into documents (id, org_id, branch_id, warehouse_id, kind, party_id) values
 ('60000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','tax_invoice','40000000-0000-0000-0000-000000000001');
insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate)
values ('60000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001',1,'50000000-0000-0000-0000-000000000001','كرفان',1,5000000,'S',15);
select post_sales_invoice('60000000-0000-0000-0000-000000000002');
select 'invoice' as t, number, subtotal, vat_total, total, zatca_status from documents where kind='tax_invoice';

-- partial receipt 30,000
insert into payments (id, org_id, kind, party_id, amount, method, cash_account_id)
select '70000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','receipt','40000000-0000-0000-0000-000000000001',3000000,'cash', acct('10000000-0000-0000-0000-000000000001','cash');
insert into payment_allocations values ('70000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000002',3000000);
select post_payment('70000000-0000-0000-0000-000000000001');
select 'payment status (expect partial)' as t, payment_status, amount_paid from documents where kind='tax_invoice';

select code, name_ar, debit, credit, balance from trial_balance order by code;
select 'TB balanced' as t, sum(debit)=sum(credit) as ok from trial_balance;
select 'stock left (expect 1)' as t, qty from stock_balances;
select * from ar_aging;

-- guards must fail
\set ON_ERROR_STOP off
update documents set total = 1 where kind='tax_invoice';
delete from journal_lines where org_id is not null;
begin;
insert into journal_entries (id, org_id, number, entry_date, source_type, status) values ('80000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',999,current_date,'manual','posted');
insert into journal_lines (entry_id, org_id, account_id, debit) select '80000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001', acct('10000000-0000-0000-0000-000000000001','cash'), 100;
commit;
select post_sales_invoice('60000000-0000-0000-0000-000000000002');
\set ON_ERROR_STOP on
select reverse_entry((select id from journal_entries where source_type='payment'));
select 'TB after reversal still balanced' as t, sum(debit)=sum(credit) as ok from trial_balance;

-- RLS: other user sees nothing
do $$ begin if not exists (select 1 from pg_roles where rolname='tester') then create role tester; end if; end $$; grant usage on schema public, auth to tester; grant select on all tables in schema public to tester;
set role tester; select set_config('test.uid','00000000-0000-0000-0000-0000000000bb', false);
select 'stranger sees docs (expect 0)' as t, count(*) from documents;
reset role;

-- sign-up creates a complete company
select set_config('test.uid','00000000-0000-0000-0000-0000000000cc', false);
select create_org('كرافت لاند','300000000000003','1010000000','الرياض') as new_org \gset
select 'accounts seeded (expect 58)' as t, count(*) from accounts where org_id = :'new_org';
select 'parents linked (expect 0 orphans)' as t, count(*) from accounts where org_id = :'new_org' and parent_id is null and length(code) > 1;
select 'system keys present' as t, acct(:'new_org','ar') is not null and acct(:'new_org','vat_out') is not null and acct(:'new_org','cogs') is not null as ok;
select 'owner member' as t, role from members where org_id = :'new_org';
\set ON_ERROR_STOP off
select create_org('x', '123');   -- bad VAT number must fail
\set ON_ERROR_STOP on
