-- Projects (migration 11): types, materials issue/return, tasks with workers, timesheets & labor, copy/templates.
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
select id as w1 from warehouses where org_id = :'org' limit 1 \gset
select t.ok('materials account created (5104, cost of sales group)', (select code from accounts where org_id = :'org' and system_key = 'project_materials') = '5104');
insert into parties (org_id, kind, name, vat_number) values (:'org', 'customer', 'مؤسسة البر', '311111111111113') returning id as cust \gset
insert into items (org_id, kind, name_ar, sku) values (:'org', 'raw_material', 'حديد مربع', 'ST') returning id as steel \gset
insert into items (org_id, kind, name_ar, sku) values (:'org', 'raw_material', 'لوح ساندوتش', 'SP') returning id as panel \gset
insert into stock_docs (org_id, kind, to_warehouse_id) values (:'org', 'opening', :'w1') returning id as op \gset
insert into stock_doc_lines (stock_doc_id, line_no, item_id, qty, unit_cost) values (:'op', 1, :'steel', 100, 4000), (:'op', 2, :'panel', 50, 15000);
select post_stock_doc(:'op');
insert into employees (org_id, full_name, is_saudi, hire_date, basic_salary, housing_allowance, transport_allowance) values (:'org', 'محمد اللحام', false, '2024-01-01', 360000, 0, 0) returning id as e1 \gset
insert into employees (org_id, full_name, is_saudi, hire_date, basic_salary, hourly_rate) values (:'org', 'سالم الدهان', false, '2024-01-01', 300000, 2500) returning id as e2 \gset

-- ===== project with type & customer =====
insert into cost_centers (org_id, code, name, project_type, party_id, contract_value, start_date, due_date) values (:'org', 'P-001', 'كرفان 8 متر', 'customer', :'cust', 6000000, '2026-11-01', '2026-11-30') returning id as p1 \gset
select t.ok('customer project flagged as project', (select is_project from cost_centers where id = :'p1'));
insert into cost_centers (org_id, code, name, project_type) values (:'org', 'CC-WS', 'الورشة', 'internal') returning id as ws \gset
select t.ok('internal type is a cost center, not a project', not (select is_project from cost_centers where id = :'ws'));
select t.fails('due date before start rejected', format($q$update cost_centers set due_date = '2026-10-01' where id = %L$q$, :'p1'), 'cost_centers_dates');
insert into project_materials (org_id, cost_center_id, item_id, planned_qty) values (:'org', :'p1', :'steel', 30), (:'org', :'p1', :'panel', 10);
select t.ok('planned materials saved', (select count(*) from project_materials where cost_center_id = :'p1') = 2);

-- ===== issue materials, return surplus =====
insert into stock_docs (org_id, kind, from_warehouse_id, cost_center_id) values (:'org', 'issue', :'w1', :'p1') returning id as iss \gset
insert into stock_doc_lines (stock_doc_id, line_no, item_id, qty) values (:'iss', 1, :'steel', 32), (:'iss', 2, :'panel', 10);
select post_stock_doc(:'iss');
select t.ok('issue: stock out (steel 68 left)', (select sum(qty) from stock_moves where item_id = :'steel') = 68);
select t.ok('issue: project charged 32×40 + 10×150 = 2,780', (select cogs from project_pl(:'org', '2026-01-01', '2026-12-31') where cost_center_id = :'p1') = 278000);
select t.ok('issue numbered ISS-', (select number from stock_docs where id = :'iss') = 'ISS-00001');
insert into stock_docs (org_id, kind, to_warehouse_id, cost_center_id) values (:'org', 'issue_return', :'w1', :'p1') returning id as rtn \gset
insert into stock_doc_lines (stock_doc_id, line_no, item_id, qty) values (:'rtn', 1, :'steel', 2);
select post_stock_doc(:'rtn');
select t.ok('return: project cost 2,700, stock back to 70', (select cogs from project_pl(:'org', '2026-01-01', '2026-12-31') where cost_center_id = :'p1') = 270000
  and (select sum(qty) from stock_moves where item_id = :'steel') = 70);
insert into stock_docs (org_id, kind, to_warehouse_id, cost_center_id) values (:'org', 'issue_return', :'w1', :'p1') returning id as rtn2 \gset
insert into stock_doc_lines (stock_doc_id, line_no, item_id, qty) values (:'rtn2', 1, :'steel', 31);
select t.fails('cannot return more than issued', format('select post_stock_doc(%L)', :'rtn2'), 'RETURN_MORE_THAN_ISSUED');
insert into stock_docs (org_id, kind, from_warehouse_id) values (:'org', 'issue', :'w1') returning id as iss2 \gset
insert into stock_doc_lines (stock_doc_id, line_no, item_id, qty) values (:'iss2', 1, :'steel', 1);
select t.fails('issue needs a project', format('select post_stock_doc(%L)', :'iss2'), 'ISSUE_PROJECT');

-- ===== tasks with workers =====
insert into tasks (org_id, cost_center_id, title, phase, est_hours, employee_ids, start_date, due_date, sort)
values (:'org', :'p1', 'لحام الهيكل', 'الهيكل', 40, array[:'e1']::uuid[], '2026-11-02', '2026-11-08', 1) returning id as t1 \gset
insert into tasks (org_id, cost_center_id, title, phase, est_hours, employee_ids, start_date, due_date, sort)
values (:'org', :'p1', 'الدهان', 'التشطيب', 16, array[:'e2', :'e1']::uuid[], '2026-11-10', '2026-11-12', 2) returning id as t2 \gset
select t.ok('task with two workers', (select array_length(employee_ids, 1) from tasks where id = :'t2') = 2);
select t.fails('task due before start rejected', format($q$update tasks set due_date = '2026-11-01' where id = %L$q$, :'t1'), 'TASK_DATES');

-- ===== timesheets =====
insert into timesheets (org_id, cost_center_id, task_id, employee_id, work_date, hours) values (:'org', :'p1', :'t1', :'e1', '2026-11-03', 8) returning id as ts1 \gset
select t.ok('auto hourly rate from salary: 3,600 ÷ 240 = 15.00/h → 8h = 120', (select rate || ':' || amount from timesheets where id = :'ts1') = '1500:12000');
insert into timesheets (org_id, cost_center_id, task_id, employee_id, work_date, hours) values (:'org', :'p1', :'t2', :'e2', '2026-11-10', 6);
select t.ok('employee manual rate 25.00/h → 6h = 150', (select amount from timesheets where employee_id = :'e2') = 15000);
insert into timesheets (org_id, cost_center_id, employee_id, work_date, hours, rate, rate_manual) values (:'org', :'p1', :'e1', '2026-11-04', 2, 3000, true);
select t.ok('per-entry manual rate (overtime 30.00/h × 2 = 60)', (select amount from timesheets where hours = 2) = 6000);
insert into timesheets (org_id, cost_center_id, employee_id, work_date, hours, amount, status) values (:'org', :'p1', :'e1', '2026-11-05', 1, 999999, 'posted') returning id as ts4 \gset
select t.ok('client cannot fake amount or status', (select amount || ':' || status from timesheets where id = :'ts4') = '1500:draft');
select t.fails('task must belong to the project', format($q$insert into timesheets (org_id, cost_center_id, task_id, employee_id, hours) values (%L, %L, %L, %L, 1)$q$, :'org', :'ws', :'t1', :'e1'), 'not allowed');
select post_labor(:'p1', '2026-11-30') as posted \gset
select t.ok('post labor: 4 entries, project expenses 120+150+60+15 = 345', :posted = 4 and (select expenses from project_pl(:'org', '2026-01-01', '2026-12-31') where cost_center_id = :'p1') = 34500);
select t.ok('company salaries net unchanged by labor allocation', t.bal(:'org', 'salaries') = 0);
update timesheets set hours = 9 where id = :'ts1';
select t.ok('posted hours cannot be edited', (select hours from timesheets where id = :'ts1') = 8);
delete from timesheets where id = :'ts1';
select t.ok('posted hours cannot be deleted (RLS)', (select count(*) from timesheets where id = :'ts1') = 1);
select t.ok('posting again does nothing', post_labor(:'p1', '2026-11-30') = 0);

-- ===== copy & templates =====
select copy_project(:'p1', 'TPL-8M', 'قالب: كرفان 8 متر', null, null, true) as tpl \gset
select t.ok('template keeps materials & tasks, no customer, no dates', (select is_template and party_id is null and start_date is null from cost_centers where id = :'tpl')
  and (select count(*) from project_materials where cost_center_id = :'tpl') = 2 and (select count(*) from tasks where cost_center_id = :'tpl' and start_date is null) = 2);
select copy_project(:'p1', 'P-002', 'كرفان 8 متر — العميل الثاني', :'cust', '2026-12-01') as p2 \gset
select t.ok('copy shifts dates by a month and resets tasks', (select due_date from cost_centers where id = :'p2') = '2026-12-30'
  and (select string_agg(start_date::text || '/' || status, ',' order by sort) from tasks where cost_center_id = :'p2') = '2026-12-02/todo,2026-12-10/todo');
select t.ok('copy keeps workers on tasks', (select array_length(employee_ids,1) from tasks where cost_center_id = :'p2' and title = 'الدهان') = 2);
select t.ok('copy has no costs, hours or issues', (select count(*) from timesheets where cost_center_id = :'p2') = 0 and (select count(*) from stock_docs where cost_center_id = :'p2') = 0);
select t.fails('duplicate code rejected', format($q$select copy_project(%L, 'P-001', 'x', null, null)$q$, :'p1'), 'PROJECT_CODE');

-- ===== other company =====
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000bb"}', false);
select create_org('شركة أخرى', null) as org2 \gset
select t.fails('other company cannot copy our project', format($q$select copy_project(%L, 'X', 'x', null, null)$q$, :'p1'), 'not allowed');
select t.fails('other company cannot post our labor', format($q$select post_labor(%L, current_date)$q$, :'p1'), 'not allowed');
select t.ok('other company sees no timesheets or planned materials', (select count(*) from timesheets) = 0 and (select count(*) from project_materials) = 0);
select t.fails('other company cannot log hours on our project', format($q$insert into timesheets (org_id, cost_center_id, employee_id, hours) values (%L, %L, %L, 1)$q$, :'org', :'p1', :'e1'), 'row-level security|not allowed');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa"}', false);
select t.ok('books balance', (select sum(debit) = sum(credit) from journal_lines where org_id = :'org'));
reset role;
select (case when ok then 'PASS ' else 'FAIL ' end) || name || case when not ok then '  [' || info || ']' else '' end as result from t.results order by n;
select count(*) filter (where ok) || ' / ' || count(*) || ' passed (projects)' as summary from t.results;
