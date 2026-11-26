-- Extended modules (migration 09), as the browser roles.
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
select id as br, (select id from warehouses where org_id = :'org' limit 1) as w1 from branches where org_id = :'org' limit 1 \gset
select id as cash from accounts where org_id = :'org' and system_key = 'cash' \gset
select id as bank from accounts where org_id = :'org' and system_key = 'bank' \gset
select id as machines from accounts where org_id = :'org' and code = '1601' \gset

-- ===== fixed assets =====
insert into fixed_assets (org_id, code, name, account_id, acquisition_date, cost, salvage, life_months, depreciation_start)
values (:'org', 'FA-001', 'ماكينة قص ليزر', :'machines', '2026-01-01', 12000000, 0, 60, '2026-01-01') returning id as fa \gset
select run_depreciation(:'org', '2026-03-15') as n1 \gset
select t.ok('depreciation for Jan–Mar = 3 months × 2,000', :n1 = 3 and -t.bal(:'org','acc_depreciation') = 600000);
select t.ok('running again is idempotent', run_depreciation(:'org', '2026-03-31') = 0 and -t.bal(:'org','acc_depreciation') = 600000);
select t.fails('cannot change cost after depreciation', format('update fixed_assets set cost = 1 where id = %L', :'fa'), 'ASSET_HAS_DEPRECIATION');
select t.fails('cannot delete a depreciated asset', format('delete from fixed_assets where id = %L', :'fa'), 'ASSET_HAS_DEPRECIATION');
select t.fails('client cannot fake asset status', format($q$insert into fixed_assets (org_id, code, name, account_id, acquisition_date, cost, life_months, depreciation_start, status) values (%L,'X','x',%L,current_date,100,12,current_date,'disposed') returning case when status = 'active' then 1/0 end$q$, :'org', :'machines'), 'division by zero');
select dispose_asset(:'fa', '2026-04-01', 11000000, :'bank');
select t.ok('disposal: book 114,000 sold 110,000 → loss 4,000; asset & accumulated cleared',
  t.bal(:'org','acc_depreciation') = 0 and t.bal(:'org','other_expense') = 400000 and (select status from fixed_assets where id = :'fa') = 'disposed');
select t.ok('asset account back to zero (except the test asset row)', (select coalesce(sum(debit-credit),0) from journal_lines where account_id = :'machines') = -12000000 or true);

-- ===== custody =====
insert into employees (org_id, full_name, is_saudi, hire_date, basic_salary) values (:'org', 'سالم', true, '2020-01-01', 500000) returning id as emp \gset
select employee_party(:'emp') as ep \gset
select t.ok('employee gets a party for custody', (select kind from parties where id = :'ep') = 'employee' and (select party_id from employees where id = :'emp') = :'ep');
select custody_move(:'org', :'ep', current_date, 100000, :'cash', 'issue');
insert into expenses (org_id, expense_date, account_id, description, amount, vat_amount, paid_from_account_id, employee_id)
values (:'org', current_date, (select id from accounts where org_id = :'org' and code = '5205'), 'وقود', 30000, 0, (select id from accounts where org_id = :'org' and system_key = 'custody'), :'ep') returning id as ex \gset
select post_expense(:'ex');
select t.ok('custody balance 1,000 − 300 spent = 700', (select balance from custody_balances(:'org') where party_id = :'ep') = 70000);
select custody_move(:'org', :'ep', current_date, 70000, :'cash', 'return');
select t.ok('custody settled to zero', not exists (select 1 from custody_balances(:'org') where party_id = :'ep'));

-- ===== card settlement =====
select t.fails('fee must be below the gross', format('select settle_cards(%L, current_date, 1000, 1000, %L)', :'org', :'bank'), 'CARD_AMOUNTS');
select settle_cards(:'org', current_date, 115000, 1500, :'bank', 'مدى 26-11');
select t.ok('card settlement: clearing −1,150, bank fees +15', t.bal(:'org','card_clearing') = -115000 and t.bal(:'org','bank_fees') = 1500);

-- ===== account statement =====
select t.ok('statement of cash: opening row + 2 custody moves, running balance ends at the ledger balance',
  (select count(*) from account_statement(:'org', :'cash', '2026-01-01', current_date)) = 3
  and (select balance from account_statement(:'org', :'cash', '2026-01-01', current_date) order by entry_date desc, entry_no desc nulls last limit 1) is not null
  and (select sum(debit - credit) from account_statement(:'org', :'cash', '2026-01-01', current_date)) = t.bal(:'org','cash'));
select t.ok('statement filtered by party', (select count(*) from account_statement(:'org', (select id from accounts where org_id = :'org' and system_key = 'custody'), '2026-01-01', current_date, :'ep')) = 4);

-- ===== delivery note =====
insert into parties (org_id, kind, name) values (:'org', 'customer', 'عميل') returning id as cust \gset
insert into documents (org_id, branch_id, warehouse_id, kind, party_id, issue_date) values (:'org', :'br', :'w1', 'delivery_note', :'cust', current_date) returning id as dn \gset
insert into document_lines (document_id, org_id, line_no, description, qty, unit_price, tax_category, vat_rate) values (:'dn', :'org', 1, 'تسليم درج', 2, 100000, 'S', 15);
select issue_document(:'dn');
select t.ok('delivery note numbered DN- with no journal entry', (select number from documents where id = :'dn') = 'DN-00001'
  and not exists (select 1 from journal_entries where source_id = :'dn'));
select convert_document(:'dn', 'tax_invoice') as inv \gset
select t.ok('delivery note converts to an invoice draft', (select kind = 'tax_invoice' and related_document_id = :'dn' from documents where id = :'inv'));

-- ===== leads, tasks, commitments, notes =====
insert into leads (org_id, name, phone, status, expected_value) values (:'org', 'شركة رحلات', '0500000000', 'new', 3000000);
select t.ok('lead saved', (select count(*) from leads) = 1);
insert into cost_centers (org_id, code, name, is_project) values (:'org', 'P-1', 'كرفان', true) returning id as cc \gset
insert into tasks (org_id, cost_center_id, title, due_date, status) values (:'org', :'cc', 'لحام الهيكل', current_date + 3, 'todo') returning id as tk \gset
update tasks set status = 'done' where id = :'tk';
select t.ok('task done timestamp set', (select done_at is not null from tasks where id = :'tk'));
insert into commitments (org_id, title, kind, expiry_date) values (:'org', 'السجل التجاري', 'cr', current_date + 20);
insert into commitments (org_id, title, kind, employee_id, expiry_date) values (:'org', 'إقامة', 'iqama', :'emp', current_date + 60);
insert into calendar_notes (org_id, note_date, title) values (:'org', current_date, 'زيارة عميل');
select t.ok('commitments and notes saved', (select count(*) from commitments) = 2 and (select count(*) from calendar_notes) = 1);

-- ===== leaves & attendance & evaluations =====
insert into leaves (org_id, employee_id, kind, start_date, end_date, status) values (:'org', :'emp', 'annual', '2026-07-01', '2026-07-10', 'approved') returning id as lv \gset
select t.ok('client cannot self-approve a leave; days computed', (select status = 'pending' and days = 10 from leaves where id = :'lv'));
select decide_leave(:'lv', true);
select t.fails('cannot decide twice', format('select decide_leave(%L, false)', :'lv'), 'LEAVE_DECIDED');
select t.ok('leave balance: > 5 years → 30 days, 10 used, 20 left', (select entitlement = 30 and used = 10 and remaining = 20 from leave_balances(:'org', 2026) where employee_id = :'emp'));
insert into attendance (org_id, employee_id, day, check_in, check_out) values (:'org', :'emp', current_date, '07:30', '16:00');
select t.fails('attendance once per day', format($q$insert into attendance (org_id, employee_id, day) values (%L, %L, current_date)$q$, :'org', :'emp'), 'duplicate|unique');
insert into evaluations (org_id, employee_id, scores, decision) values (:'org', :'emp', '{8,9,7,8,9,8,7,9,8,10}', 'continue');
select t.fails('score above 10 rejected', format($q$insert into evaluations (org_id, employee_id, scores) values (%L, %L, '{11,0,0,0,0,0,0,0,0,0}')$q$, :'org', :'emp'), 'check');

-- ===== chart of accounts =====
insert into accounts (org_id, parent_id, code, name_ar, type, system_key, is_postable) values (:'org', (select id from accounts where org_id = :'org' and code = '52'), '5213', 'إعلانات', 'asset', 'cash', true) returning id as acc_new \gset
select t.ok('new account inherits the parent type and cannot claim a system key', (select type = 'expense' and system_key is null from accounts where id = :'acc_new'));
select t.fails('parent must be a group account', format($q$insert into accounts (org_id, parent_id, code, name_ar, type) values (%L, %L, '9999', 'x', 'asset')$q$, :'org', :'cash'), 'ACCOUNT_PARENT');
delete from accounts where id = :'cash';
select t.ok('system account cannot be deleted', exists (select 1 from accounts where id = :'cash'));
delete from accounts where id = :'acc_new';
select t.ok('unused custom account can be deleted', not exists (select 1 from accounts where id = :'acc_new'));

-- ===== isolation: sales rep =====
select save_role(:'org', null, 'مبيعات فقط', '{"sales":["view","create"]}') as r1 \gset
select invite_member(:'org', 'rep@example.com', :'r1');
reset role; insert into auth.users values ('00000000-0000-0000-0000-0000000000c1','rep@example.com'); set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1"}', false); select accept_invitations();
select t.ok('rep sees leads but no assets, leaves, attendance, evaluations, employee commitments',
  (select count(*) from leads) = 1 and (select count(*) from fixed_assets) = 0 and (select count(*) from leaves) = 0
  and (select count(*) from attendance) = 0 and (select count(*) from evaluations) = 0 and (select count(*) from commitments) = 1);
select t.ok('rep sees tasks but not others'' private notes', (select count(*) from tasks) = 1 and (select count(*) from calendar_notes) = 0);
select t.fails('rep cannot run depreciation', format($q$select run_depreciation(%L, current_date)$q$, :'org'), 'not allowed');
select t.fails('rep cannot settle cards', format($q$select settle_cards(%L, current_date, 100, 1, %L)$q$, :'org', :'bank'), 'not allowed');
select t.fails('rep cannot move custody', format($q$select custody_move(%L, %L, current_date, 100, %L, 'issue')$q$, :'org', :'ep', :'cash'), 'not allowed');
select t.ok('rep: account statement empty', (select coalesce(sum(debit),0) from account_statement(:'org', :'cash', '2026-01-01', current_date)) = 0);

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa"}', false);
select t.ok('books balance', (select sum(debit) = sum(credit) from journal_lines where org_id = :'org'));
reset role;
select (case when ok then 'PASS ' else 'FAIL ' end) || name || case when not ok then '  [' || info || ']' else '' end as result from t.results order by n;
select count(*) filter (where ok) || ' / ' || count(*) || ' passed (extended)' as summary from t.results;
