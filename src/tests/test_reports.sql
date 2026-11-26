-- Reports + payroll (migration 07), as the browser roles.
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
grant execute on all functions in schema t to anon, authenticated;

insert into platform_admins values ('owner@example.com');
insert into auth.users values ('00000000-0000-0000-0000-0000000000aa','owner@example.com');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa"}', false);
select create_org('كرافت لاند', '300000000000003') as org \gset
select t.ok('new company has the end-of-service expense account', exists (select 1 from accounts where org_id = :'org' and system_key = 'eosb_expense'));
select id as w1, branch_id as br from warehouses where org_id = :'org' limit 1 \gset
insert into parties (org_id, kind, name, vat_number, city, street, building_no, postal_code) values (:'org', 'customer', 'عميل', '311111111111113', 'الرياض', 'ش', '1', '12345') returning id as cust \gset
insert into parties (org_id, kind, name, vat_number) values (:'org', 'supplier', 'مورد', '322222222222223') returning id as sup \gset
insert into items (org_id, kind, name_ar, sale_price) values (:'org', 'product', 'منتج', 100000) returning id as prod \gset
insert into items (org_id, kind, name_ar, track_stock) values (:'org', 'service', 'تصدير', false) returning id as svc \gset

-- purchase 10 @ 400 → stock
insert into documents (org_id, branch_id, warehouse_id, kind, party_id, issue_date) values (:'org', :'br', :'w1', 'purchase_bill', :'sup', '2026-11-03') returning id as bill \gset
insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate) values (:'bill', :'org', 1, :'prod', 'x', 10, 40000, 'S', 15);
select post_purchase_bill(:'bill');
-- sell 3 @ 1000 standard + a zero-rated export service 500
insert into documents (org_id, branch_id, warehouse_id, kind, party_id, issue_date) values (:'org', :'br', :'w1', 'tax_invoice', :'cust', '2026-11-10') returning id as inv \gset
insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate) values
  (:'inv', :'org', 1, :'prod', 'x', 3, 100000, 'S', 15), (:'inv', :'org', 2, :'svc', 'تصدير', 1, 50000, 'Z', 0);
select post_sales_invoice(:'inv');
-- return 1
select convert_document(:'inv', 'credit_note') as cn \gset
delete from document_lines where document_id = :'cn' and line_no = 2;
update document_lines set qty = 1 where document_id = :'cn';
select post_credit_note(:'cn');
-- expense 200 + VAT 30 from cash
insert into expenses (org_id, expense_date, account_id, description, amount, vat_amount, paid_from_account_id)
values (:'org', '2026-11-12', (select id from accounts where org_id = :'org' and code = '5204'), 'كهرباء', 20000, 3000, (select id from accounts where org_id = :'org' and system_key = 'cash')) returning id as ex \gset
select post_expense(:'ex');

-- ================= VAT return =================
select vat_return(:'org', '2026-11-01', '2026-11-30') as v \gset
select t.ok('VAT: standard sales 3,000 / VAT 450', (:'v'::jsonb #>> '{sales_standard,net}')::bigint = 300000 and (:'v'::jsonb #>> '{sales_standard,vat}')::bigint = 45000, :'v');
select t.ok('VAT: credit-note adjustment 1,000 / 150', (:'v'::jsonb #>> '{sales_standard,adj_net}')::bigint = 100000 and (:'v'::jsonb #>> '{sales_standard,adj_vat}')::bigint = 15000);
select t.ok('VAT: zero-rated sales 500', (:'v'::jsonb #>> '{sales_zero,net}')::bigint = 50000);
select t.ok('VAT: purchases 4,000 + expense 200 / VAT 630', (:'v'::jsonb #>> '{purchases_standard,net}')::bigint = 420000 and (:'v'::jsonb #>> '{purchases_standard,vat}')::bigint = 63000);
select t.ok('VAT return net due = output − input matches the ledger',
  (:'v'::jsonb #>> '{sales_standard,vat}')::bigint - (:'v'::jsonb #>> '{sales_standard,adj_vat}')::bigint
  - (:'v'::jsonb #>> '{purchases_standard,vat}')::bigint + (:'v'::jsonb #>> '{purchases_standard,adj_vat}')::bigint
  = -(t.bal(:'org','vat_out') + t.bal(:'org','vat_in')));
select t.ok('VAT: outside the period → zero', (vat_return(:'org', '2026-10-01', '2026-10-31') #>> '{sales_standard,net}')::bigint = 0);

-- ================= balances / income statement =================
select t.ok('account_balances: revenue in period = 3,000 + 500 − 1,000',
  (select -sum(closing - opening) from account_balances(:'org', '2026-11-01', '2026-11-30') where type = 'revenue') = 250000);
select t.ok('account_balances: balance sheet balances (assets = liabilities + equity + profit)',
  (select sum(closing) from account_balances(:'org', '2026-11-01', '2026-11-30')) = 0);
select t.ok('account_balances: opening before the period is zero', (select sum(abs(opening)) from account_balances(:'org', '2026-11-01', '2026-11-30')) = 0);
select t.ok('account_balances: December opening = November closing',
  (select sum(abs(opening)) from account_balances(:'org', '2026-12-01', '2026-12-31')) = (select sum(abs(closing)) from account_balances(:'org', '2026-11-01', '2026-11-30')));
select t.ok('monthly summary has 6 months', (select count(*) from monthly_summary(:'org', 6)) = 6);
select t.ok('monthly summary: this month revenue 2,500, COGS 800, expenses 200',
  (select revenue = 250000 and cogs = 80000 and expenses = 20000 from monthly_summary(:'org', 1)), (select row(m.*)::text from monthly_summary(:'org', 1) m));

-- ================= payroll =================
insert into employees (org_id, full_name, is_saudi, hire_date, basic_salary, housing_allowance, transport_allowance, other_allowances)
values (:'org', 'محمد', true, '2019-01-01', 800000, 200000, 50000, '{"food": 30000}') returning id as e1 \gset
insert into employees (org_id, full_name, is_saudi, hire_date, basic_salary, housing_allowance, transport_allowance)
values (:'org', 'راجيش', false, '2025-06-01', 300000, 75000, 25000) returning id as e2 \gset
insert into employees (org_id, full_name, is_saudi, hire_date, basic_salary, status) values (:'org', 'سابق', false, '2020-01-01', 100000, 'terminated');
insert into employees (org_id, full_name, is_saudi, hire_date, basic_salary) values (:'org', 'جديد', false, '2026-12-15', 100000);
select t.fails('negative salary rejected', format($q$insert into employees (org_id, full_name, is_saudi, hire_date, basic_salary) values (%L, 'x', true, current_date, -1)$q$, :'org'), 'EMP_SALARY');

select prepare_payroll(:'org', '2026-11-15') as run \gset
select t.ok('payroll: only active employees hired by the month', (select count(*) from payslips where run_id = :'run') = 2);
select t.ok('Saudi: gross = 8,000+2,000+500+300', (select gross from payslips where employee_id = :'e1') = 1080000);
select t.ok('Saudi GOSI: employee 9.75% / employer 11.75% of 10,000',
  (select gosi_employee = 97500 and gosi_employer = 117500 from payslips where employee_id = :'e1'));
select t.ok('non-Saudi GOSI: employer 2% hazards only', (select gosi_employee = 0 and gosi_employer = 7500 from payslips where employee_id = :'e2'));
select t.ok('end of service: > 5 years = a full month / 12; < 5 years = half',
  (select eosb from payslips where employee_id = :'e1') = round(1050000 / 12.0) and (select eosb from payslips where employee_id = :'e2') = round(400000 / 12.0 * 0.5));
select id as ps2 from payslips where employee_id = :'e2' \gset
select update_payslip(:'ps2', 50000, 20000, 'إضافي − سلفة');
select t.ok('payslip additions & deductions change the net', (select net from payslips where id = :'ps2') = 400000 + 50000 - 20000);
select t.fails('deductions bigger than salary rejected', format('select update_payslip(%L, 0, 99999999, null)', :'ps2'), 'PAYSLIP_NEGATIVE');
select prepare_payroll(:'org', '2026-11-01');
select t.ok('preparing again keeps manual additions', (select additions from payslips where id = :'ps2') = 50000);
select t.fails('client cannot write runs directly', format($q$update payroll_runs set status = 'posted' where id = %L$q$, :'run'), 'permission denied');
select t.fails('client cannot write payslips directly', format($q$update payslips set net = 1 where id = %L$q$, :'ps2'), 'permission denied');

-- hr clerk: create but not post
select save_role(:'org', null, 'موظف موارد', '{"hr":["view","create"]}') as r_hr \gset
select invite_member(:'org', 'hr@example.com', :'r_hr');
select invite_member(:'org', 'sales@example.com', (select id from roles where org_id = :'org' and name = 'مندوب مبيعات'));
reset role; insert into auth.users values ('00000000-0000-0000-0000-0000000000c1','hr@example.com'), ('00000000-0000-0000-0000-0000000000c2','sales@example.com'); set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c2"}', false); select accept_invitations();
select t.ok('sales rep sees no employees or payroll', (select count(*) from employees) + (select count(*) from payroll_runs) + (select count(*) from payslips) = 0);
select t.ok('sales rep: balances show nothing (no journal access)', (select coalesce(sum(abs(closing)),0) from account_balances(:'org', '2026-11-01', '2026-11-30')) = 0);
select t.fails('sales rep cannot read the VAT return', format($q$select vat_return(%L, '2026-11-01', '2026-11-30')$q$, :'org'), 'not allowed');
select t.fails('sales rep cannot prepare payroll', format($q$select prepare_payroll(%L, '2026-12-01')$q$, :'org'), 'not allowed');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1"}', false); select accept_invitations();
select t.ok('hr clerk sees the payroll', (select count(*) from payslips where run_id = :'run') = 2);
select set_payroll_options(:'run', true, true);
select t.ok('hr clerk submitted for approval', (select submitted_at is not null from payroll_runs where id = :'run'));
select t.fails('hr clerk cannot post payroll', format('select post_payroll(%L)', :'run'), 'not allowed');

-- owner posts & pays
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa"}', false);
select post_payroll(:'run');
select t.ok('payroll posted PAY-00001', (select number = 'PAY-00001' and status = 'posted' from payroll_runs where id = :'run'));
select t.ok('salaries payable = total net', -t.bal(:'org','salaries_payable') = (select sum(net) from payslips where run_id = :'run'));
select t.ok('GOSI payable = employee + employer', -t.bal(:'org','gosi_payable') = 97500 + 117500 + 7500);
select t.ok('EOSB provision accrued', -t.bal(:'org','eosb_provision') = (select sum(eosb) from payslips where run_id = :'run'));
select t.fails('posted payroll cannot be edited', format('select update_payslip(%L, 0, 0, null)', :'ps2'), 'PAYROLL_POSTED');
select t.fails('cannot pay from a non-cash account', format('select pay_payroll(%L, %L)', :'run', (select id from accounts where org_id = :'org' and system_key = 'sales')), 'PAID_FROM');
select pay_payroll(:'run', (select id from accounts where org_id = :'org' and system_key = 'bank'), '2026-12-01');
select t.ok('salaries paid: payable cleared, run paid', t.bal(:'org','salaries_payable') = 0 and (select status from payroll_runs where id = :'run') = 'paid');
select t.fails('cannot pay twice', format('select pay_payroll(%L, %L)', :'run', (select id from accounts where org_id = :'org' and system_key = 'bank')), 'PAYROLL_NOT_POSTED');
select t.fails('cannot re-prepare a posted month', format($q$select prepare_payroll(%L, '2026-11-01')$q$, :'org'), 'PAYROLL_POSTED');
select t.ok('books balance', (select sum(debit) = sum(credit) from journal_lines where org_id = :'org'));
select t.ok('every entry balances', not exists (select 1 from journal_lines where org_id = :'org' group by entry_id having sum(debit) <> sum(credit)));
reset role;

select (case when ok then 'PASS ' else 'FAIL ' end) || name || case when not ok then '  [' || info || ']' else '' end as result from t.results order by n;
select count(*) filter (where ok) || ' / ' || count(*) || ' passed (reports & payroll)' as summary from t.results;
