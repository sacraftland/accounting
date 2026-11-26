-- Casual labor (migration 12): daily / hourly workers, payroll exclusion, wages owed & paid.
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
insert into platform_admins values ('owner@example.com'), ('other@example.com');
insert into auth.users values ('00000000-0000-0000-0000-0000000000aa','owner@example.com'), ('00000000-0000-0000-0000-0000000000bb','other@example.com');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa"}', false);
select create_org('كرافت لاند', '300000000000003') as org \gset
select id as cash from accounts where org_id = :'org' and system_key = 'cash' \gset
insert into employees (org_id, full_name, is_saudi, hire_date, basic_salary) values (:'org', 'محمد الشهري', false, '2024-01-01', 360000) returning id as m1 \gset
insert into employees (org_id, full_name, is_saudi, hire_date, basic_salary, employment_type, daily_rate) values (:'org', 'رامي باليومية', false, '2026-11-01', 0, 'daily', 20000) returning id as d1 \gset
insert into employees (org_id, full_name, is_saudi, hire_date, basic_salary, employment_type, hourly_rate) values (:'org', 'سمير بالساعة', false, '2026-11-01', 0, 'hourly', 3000) returning id as h1 \gset
select t.fails('daily worker needs a daily rate', format($q$insert into employees (org_id, full_name, is_saudi, hire_date, basic_salary, employment_type) values (%L, 'x', false, current_date, 0, 'daily')$q$, :'org'), 'employees_casual_rate');
insert into cost_centers (org_id, code, name, project_type) values (:'org', 'P-1', 'كرفان', 'customer') returning id as p1 \gset
insert into timesheets (org_id, cost_center_id, employee_id, work_date, hours) values (:'org', :'p1', :'d1', '2026-11-10', 16), (:'org', :'p1', :'h1', '2026-11-10', 10), (:'org', :'p1', :'m1', '2026-11-10', 8);
select t.ok('daily rate 200/day → 25/h × 16 = 400; hourly 30 × 10 = 300; monthly 15 × 8 = 120',
  (select string_agg(amount::text, ',' order by amount desc) from timesheets) = '40000,30000,12000');
select post_labor(:'p1', '2026-11-30');
select t.ok('project labor 820', (select expenses from project_pl(:'org', '2026-01-01', '2026-12-31') where cost_center_id = :'p1') = 82000);
select t.ok('casual wages owed 700 (payable), monthly moved within salaries', t.bal(:'org', 'salaries_payable') = -70000 and t.bal(:'org', 'salaries') = 70000);
select t.ok('balances per worker', (select string_agg(full_name || ':' || owed, ',' order by owed desc) from casual_balances(:'org')) = 'رامي باليومية:40000,سمير بالساعة:30000');
select pay_casual(:'org', :'d1', 25000, :'cash', '2026-11-30');
select t.ok('partial payment: owed 150', (select owed from casual_balances(:'org') where employee_id = :'d1') = 15000 and t.bal(:'org', 'cash') = -25000);
select t.fails('cannot pay more than owed', format($q$select pay_casual(%L, %L, 99999, %L, current_date)$q$, :'org', :'h1', :'cash'), 'WAGES_MORE_THAN_OWED');
select t.fails('monthly staff are paid through payroll', format($q$select pay_casual(%L, %L, 100, %L, current_date)$q$, :'org', :'m1', :'cash'), 'not allowed');
select prepare_payroll(:'org', '2026-11-01') as run \gset
select t.ok('payroll includes only monthly staff', (select count(*) from payslips where run_id = :'run') = 1 and (select employee_id from payslips where run_id = :'run') = :'m1');
select t.ok('workers list carries type', (select string_agg(employment_type, ',' order by full_name) from list_workers(:'org')) is not null and (select count(*) from list_workers(:'org')) = 3);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000bb"}', false);
select create_org('شركة أخرى', null) as org2 \gset
select t.fails('other company cannot see our balances', format('select * from casual_balances(%L)', :'org'), 'not allowed');
select t.fails('other company cannot pay our workers', format($q$select pay_casual(%L, %L, 100, %L, current_date)$q$, :'org', :'h1', :'cash'), 'not allowed');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa"}', false);
select t.ok('books balance', (select sum(debit) = sum(credit) from journal_lines where org_id = :'org'));
reset role;
select (case when ok then 'PASS ' else 'FAIL ' end) || name || case when not ok then '  [' || info || ']' else '' end as result from t.results order by n;
select count(*) filter (where ok) || ' / ' || count(*) || ' passed (casual labor)' as summary from t.results;
