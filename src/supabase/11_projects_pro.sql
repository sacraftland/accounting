-- =====================================================================
-- Migration 11 — projects, properly:
--  • project types (customer contract / production run / internal), customer,
--    product & quantity, dates, manager, budget, templates & copying
--  • planned materials per project; issuing stock to a project and returning
--    the surplus (stock docs of kind 'issue' / 'issue_return')
--  • tasks assigned to employees (workers need no login), phases, estimates
--  • timesheets: hours per employee / task at an hourly cost (automatic from
--    salary, or set per employee, or per entry) and posting labor to the project
-- =====================================================================

-- ---------- project fields ----------
alter table cost_centers
  add column project_type text not null default 'customer' check (project_type in ('customer','production','internal')),
  add column party_id uuid references parties(id) on delete set null,
  add column product_item_id uuid references items(id) on delete set null,
  add column production_qty numeric(18,4) check (production_qty is null or production_qty > 0),
  add column start_date date, add column due_date date,
  add column description text,
  add column is_template boolean not null default false,
  add column source_project_id uuid references cost_centers(id) on delete set null,
  add column manager_employee_id uuid references employees(id) on delete set null,
  add column budget_other bigint check (budget_other is null or budget_other >= 0),
  add constraint cost_centers_dates check (due_date is null or start_date is null or due_date >= start_date);
update cost_centers set project_type = case when is_project then 'customer' else 'internal' end;

create or replace function guard_client_cost_center() returns trigger language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  if tg_op = 'UPDATE' and new.org_id <> old.org_id then raise exception 'not allowed'; end if;
  if new.contract_value is not null and new.contract_value < 0 then raise exception 'not allowed'; end if;
  if new.party_id is not null and not exists (select 1 from parties where id = new.party_id and org_id = new.org_id) then raise exception 'customer not found'; end if;
  if new.product_item_id is not null and not exists (select 1 from items where id = new.product_item_id and org_id = new.org_id) then raise exception 'item not found'; end if;
  if new.manager_employee_id is not null and not exists (select 1 from employees where id = new.manager_employee_id and org_id = new.org_id) then raise exception 'not allowed'; end if;
  if new.source_project_id is not null and not exists (select 1 from cost_centers where id = new.source_project_id and org_id = new.org_id) then raise exception 'not allowed'; end if;
  new.is_project := new.project_type <> 'internal';
  return new;
end $$;

-- ---------- planned materials ----------
create table project_materials (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  cost_center_id uuid not null references cost_centers(id) on delete cascade,
  item_id uuid not null references items(id) on delete cascade,
  planned_qty numeric(18,4) not null check (planned_qty > 0),
  note text,
  unique (cost_center_id, item_id)
);
alter table project_materials enable row level security;
create policy project_materials_read on project_materials for select using (is_member(org_id));
create policy project_materials_write on project_materials for all
  using (has_perm(org_id, 'accounting', 'create') or has_perm(org_id, 'manufacturing', 'create'))
  with check ((has_perm(org_id, 'accounting', 'create') or has_perm(org_id, 'manufacturing', 'create'))
    and exists (select 1 from cost_centers c where c.id = cost_center_id and c.org_id = project_materials.org_id)
    and exists (select 1 from items i where i.id = item_id and i.org_id = project_materials.org_id));
grant select, insert, update, delete on project_materials to authenticated;

-- ---------- the materials account (cost of sales group) ----------
create or replace function ensure_extra_accounts(o uuid) returns void
language sql security definer set search_path = public as $$
  insert into accounts (org_id, parent_id, code, name_ar, type, system_key)
  select o, (select id from accounts where org_id = o and code = '52'), '5212', 'مكافأة نهاية الخدمة', 'expense', 'eosb_expense'
  where not exists (select 1 from accounts where org_id = o and (system_key = 'eosb_expense' or code = '5212'));
  insert into accounts (org_id, parent_id, code, name_ar, type, system_key)
  select o, g.id, (select coalesce(max(code::int) + 1, 5104)::text from accounts where org_id = o and code ~ '^51[0-9]{2}$'), 'مواد مصروفة للمشاريع', 'expense', 'project_materials'
  from accounts g where g.org_id = o and g.code = '51'
    and not exists (select 1 from accounts where org_id = o and system_key = 'project_materials');
$$;
select ensure_extra_accounts(id) from orgs;

create or replace function project_pl(p_org uuid, p_from date, p_to date)
returns table (cost_center_id uuid, revenue bigint, cogs bigint, expenses bigint)
language sql stable security invoker set search_path = public as $$
  select l.cost_center_id,
    coalesce(sum(l.credit - l.debit) filter (where a.type = 'revenue'), 0)::bigint,
    coalesce(sum(l.debit - l.credit) filter (where a.system_key in ('cogs','waste','stock_variance','project_materials')), 0)::bigint,
    coalesce(sum(l.debit - l.credit) filter (where a.type = 'expense' and coalesce(a.system_key,'') not in ('cogs','waste','stock_variance','project_materials')), 0)::bigint
  from journal_lines l join journal_entries e on e.id = l.entry_id and e.status = 'posted'
  join accounts a on a.id = l.account_id
  where l.org_id = p_org and l.cost_center_id is not null and e.entry_date between p_from and p_to
  group by l.cost_center_id
$$;

-- ---------- issue stock to a project / return the surplus ----------
alter table stock_docs add column cost_center_id uuid references cost_centers(id) on delete restrict;
alter table stock_docs drop constraint if exists stock_docs_kind_check;
alter table stock_docs add constraint stock_docs_kind_check check (kind in ('transfer','count','waste','opening','issue','issue_return'));
alter table stock_moves drop constraint if exists stock_moves_source_type_check;
alter table stock_moves add constraint stock_moves_source_type_check check (source_type in ('sale','purchase','return','transfer','count','waste','opening','production','issue','issue_return'));

create or replace function guard_client_stock_doc() returns trigger language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  if tg_op = 'UPDATE' and (old.status <> 'draft' or new.org_id <> old.org_id) then raise exception 'posted documents cannot be edited — issue a credit or debit note'; end if;
  if new.status <> 'draft' then raise exception 'use the posting function to post'; end if;
  new.number := null; new.posted_at := null;
  if tg_op = 'INSERT' then new.created_by := auth.uid(); else new.created_by := old.created_by; end if;
  if new.from_warehouse_id is not null and not exists (select 1 from warehouses where id = new.from_warehouse_id and org_id = new.org_id) then raise exception 'warehouse not found'; end if;
  if new.to_warehouse_id is not null and not exists (select 1 from warehouses where id = new.to_warehouse_id and org_id = new.org_id) then raise exception 'warehouse not found'; end if;
  if new.cost_center_id is not null and not exists (select 1 from cost_centers where id = new.cost_center_id and org_id = new.org_id) then raise exception 'cost center not found'; end if;
  return new;
end $$;

create or replace function post_stock_doc(sd uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare s stock_docs; je uuid; ln record; wh uuid; sysq numeric; diff numeric; c numeric; n text;
begin
  select * into s from stock_docs where id = sd for update;
  if s.id is null then raise exception 'not allowed'; end if;
  perform require_perm(s.org_id, 'inventory', 'post');
  if s.status <> 'draft' then raise exception 'already posted'; end if;
  if not exists (select 1 from stock_doc_lines where stock_doc_id = sd) then raise exception 'NO_LINES: add at least one line'; end if;
  if s.kind = 'transfer' then
    if s.from_warehouse_id is null or s.to_warehouse_id is null or s.from_warehouse_id = s.to_warehouse_id then raise exception 'TRANSFER_WAREHOUSES: choose two different warehouses'; end if;
    for ln in select l.*, i.track_stock from stock_doc_lines l join items i on i.id = l.item_id where l.stock_doc_id = sd loop
      if ln.qty <= 0 then raise exception 'qty must be > 0'; end if;
      c := issue_stock(s.org_id, ln.item_id, s.from_warehouse_id, s.doc_date, ln.qty, 'transfer', sd);
      insert into stock_moves (org_id, item_id, warehouse_id, move_date, qty, unit_cost, source_type, source_id)
      values (s.org_id, ln.item_id, s.to_warehouse_id, s.doc_date, ln.qty, c, 'transfer', sd);
      update stock_doc_lines set unit_cost = c where id = ln.id;
    end loop;
    n := fmt_no('TRF-', next_number(s.org_id, 'trf'));
  elsif s.kind in ('issue', 'issue_return') then
    if s.cost_center_id is null then raise exception 'ISSUE_PROJECT: choose the project'; end if;
    wh := case when s.kind = 'issue' then s.from_warehouse_id else s.to_warehouse_id end;
    if wh is null then raise exception 'warehouse not found'; end if;
    je := new_entry(s.org_id, s.doc_date, case s.kind when 'issue' then 'صرف مواد لمشروع: ' else 'إرجاع مواد من مشروع: ' end || (select name from cost_centers where id = s.cost_center_id), 'stock', sd);
    for ln in select l.*, i.kind ik, i.avg_cost, i.track_stock from stock_doc_lines l join items i on i.id = l.item_id where l.stock_doc_id = sd loop
      if ln.qty <= 0 then raise exception 'qty must be > 0'; end if;
      if not ln.track_stock then raise exception 'ISSUE_SERVICE: services are not issued from stock'; end if;
      if s.kind = 'issue' then
        c := issue_stock(s.org_id, ln.item_id, wh, s.doc_date, ln.qty, 'issue', sd);
        perform jl(je, s.org_id, acct(s.org_id, 'project_materials'), ln.qty * c, 0, null, s.cost_center_id);
        perform jl(je, s.org_id, inv_acct(s.org_id, ln.ik), 0, ln.qty * c);
      else
        if ln.qty > (select coalesce(sum(l2.qty), 0) from stock_doc_lines l2 join stock_docs d2 on d2.id = l2.stock_doc_id
                     where d2.cost_center_id = s.cost_center_id and d2.status = 'posted' and d2.kind = 'issue' and l2.item_id = ln.item_id)
                  - (select coalesce(sum(l2.qty), 0) from stock_doc_lines l2 join stock_docs d2 on d2.id = l2.stock_doc_id
                     where d2.cost_center_id = s.cost_center_id and d2.status = 'posted' and d2.kind = 'issue_return' and l2.item_id = ln.item_id) then
          raise exception 'RETURN_MORE_THAN_ISSUED: you cannot return more than was issued to the project'; end if;
        c := ln.avg_cost;
        perform receive_stock(s.org_id, ln.item_id, wh, s.doc_date, ln.qty, c, 'issue_return', sd);
        perform jl(je, s.org_id, inv_acct(s.org_id, ln.ik), ln.qty * c, 0);
        perform jl(je, s.org_id, acct(s.org_id, 'project_materials'), 0, ln.qty * c, null, s.cost_center_id);
      end if;
      update stock_doc_lines set unit_cost = c where id = ln.id;
    end loop;
    if exists (select 1 from journal_lines where entry_id = je) then update journal_entries set status = 'posted' where id = je;
    else delete from journal_entries where id = je; end if;
    n := fmt_no(case s.kind when 'issue' then 'ISS-' else 'RTN-' end, next_number(s.org_id, s.kind));
  else
    wh := coalesce(s.from_warehouse_id, s.to_warehouse_id);
    if wh is null then raise exception 'warehouse not found'; end if;
    je := new_entry(s.org_id, s.doc_date, case s.kind when 'count' then 'تسوية جرد' when 'waste' then 'تالف وهالك' else 'أرصدة مخزون افتتاحية' end, 'stock', sd);
    for ln in select l.*, i.kind ik, i.avg_cost from stock_doc_lines l join items i on i.id = l.item_id where l.stock_doc_id = sd loop
      if s.kind = 'count' then
        if ln.qty < 0 then raise exception 'qty must be >= 0'; end if;
        select coalesce(sum(qty),0) into sysq from stock_moves where item_id = ln.item_id and warehouse_id = wh;
        diff := ln.qty - sysq;
        update stock_doc_lines set system_qty = sysq, unit_cost = ln.avg_cost where id = ln.id;
        if diff > 0 then
          perform receive_stock(s.org_id, ln.item_id, wh, s.doc_date, diff, ln.avg_cost, 'count', sd);
          perform jl(je, s.org_id, inv_acct(s.org_id, ln.ik), diff * ln.avg_cost, 0);
          perform jl(je, s.org_id, acct(s.org_id,'stock_variance'), 0, diff * ln.avg_cost);
        elsif diff < 0 then
          c := issue_stock(s.org_id, ln.item_id, wh, s.doc_date, -diff, 'count', sd);
          perform jl(je, s.org_id, acct(s.org_id,'stock_variance'), -diff * c, 0);
          perform jl(je, s.org_id, inv_acct(s.org_id, ln.ik), 0, -diff * c);
        end if;
      elsif s.kind = 'waste' then
        if ln.qty <= 0 then raise exception 'qty must be > 0'; end if;
        c := issue_stock(s.org_id, ln.item_id, wh, s.doc_date, ln.qty, 'waste', sd);
        update stock_doc_lines set unit_cost = c where id = ln.id;
        perform jl(je, s.org_id, acct(s.org_id,'waste'), ln.qty * c, 0, null, s.cost_center_id);
        perform jl(je, s.org_id, inv_acct(s.org_id, ln.ik), 0, ln.qty * c);
      else -- opening
        if ln.qty <= 0 or coalesce(ln.unit_cost, -1) < 0 then raise exception 'OPENING_COST: enter quantity and unit cost'; end if;
        perform receive_stock(s.org_id, ln.item_id, wh, s.doc_date, ln.qty, ln.unit_cost, 'opening', sd);
        perform jl(je, s.org_id, inv_acct(s.org_id, ln.ik), ln.qty * ln.unit_cost, 0);
        perform jl(je, s.org_id, acct(s.org_id,'opening_balance'), 0, ln.qty * ln.unit_cost);
      end if;
    end loop;
    if exists (select 1 from journal_lines where entry_id = je) then update journal_entries set status = 'posted' where id = je;
    else delete from journal_entries where id = je; end if;
    n := fmt_no(case s.kind when 'count' then 'CNT-' when 'waste' then 'WST-' else 'OPN-' end, next_number(s.org_id, s.kind));
  end if;
  update stock_docs set status = 'posted', posted_at = now(), number = n where id = sd;
  return sd;
end $$;

-- ---------- tasks: employees, phases, estimates ----------
alter table tasks add column employee_ids uuid[] not null default '{}', add column est_hours numeric(8,2) check (est_hours is null or est_hours >= 0),
  add column start_date date, add column phase text, add column sort int not null default 0;
create or replace function guard_client_task() returns trigger language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  if tg_op = 'UPDATE' then
    if new.org_id <> old.org_id then raise exception 'not allowed'; end if;
    new.created_by := old.created_by;
    if not can_write(new.org_id) and (new.title, new.notes, new.assignee, new.due_date, new.priority, new.cost_center_id, new.employee_ids, new.est_hours, new.start_date, new.phase)
         is distinct from (old.title, old.notes, old.assignee, old.due_date, old.priority, old.cost_center_id, old.employee_ids, old.est_hours, old.start_date, old.phase) then raise exception 'not allowed'; end if;
  else new.created_by := auth.uid(); end if;
  if exists (select 1 from unnest(new.employee_ids) x where not exists (select 1 from employees e where e.id = x and e.org_id = new.org_id)) then raise exception 'not allowed'; end if;
  if new.start_date is not null and new.due_date is not null and new.due_date < new.start_date then raise exception 'TASK_DATES: the due date is before the start date'; end if;
  new.done_at := case when new.status = 'done' then coalesce(old.done_at, now()) else null end;
  return new;
end $$;

-- ---------- hourly cost ----------
alter table employees add column hourly_rate bigint check (hourly_rate is null or hourly_rate >= 0);
create or replace function employee_hour_rate(e employees) returns bigint language sql stable set search_path = public as $$
  select coalesce(e.hourly_rate, round((e.basic_salary + e.housing_allowance + e.transport_allowance + other_allowances_total(e.other_allowances)) / 240.0)::bigint)
$$;

-- ---------- timesheets ----------
create table timesheets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  cost_center_id uuid not null references cost_centers(id) on delete cascade,
  task_id uuid references tasks(id) on delete set null,
  employee_id uuid not null references employees(id) on delete restrict,
  work_date date not null default current_date,
  hours numeric(6,2) not null check (hours > 0 and hours <= 24),
  rate bigint not null default 0 check (rate >= 0),
  rate_manual boolean not null default false,
  amount bigint not null default 0,
  note text,
  status text not null default 'draft' check (status in ('draft','posted')),
  entry_id uuid references journal_entries(id),
  created_by uuid, created_at timestamptz not null default now()
);
create index on timesheets (org_id, cost_center_id, status);
alter table timesheets enable row level security;
create policy timesheets_read on timesheets for select using (has_perm(org_id, 'hr', 'view') or has_perm(org_id, 'accounting', 'view') or has_perm(org_id, 'manufacturing', 'view'));
create policy timesheets_write on timesheets for all
  using ((has_perm(org_id, 'hr', 'create') or has_perm(org_id, 'manufacturing', 'create') or has_perm(org_id, 'accounting', 'create')) and status = 'draft')
  with check ((has_perm(org_id, 'hr', 'create') or has_perm(org_id, 'manufacturing', 'create') or has_perm(org_id, 'accounting', 'create')) and status = 'draft');
grant select, insert, update, delete on timesheets to authenticated;
-- hourly cost of an employee, for whoever may log hours in that company (they need no HR access)
create or replace function timesheet_rate(p_org uuid, p_emp uuid) returns bigint
language plpgsql stable security definer set search_path = public as $$
declare e employees;
begin
  if not (has_perm(p_org, 'hr', 'create') or has_perm(p_org, 'manufacturing', 'create') or has_perm(p_org, 'accounting', 'create')) then raise exception 'not allowed'; end if;
  select * into e from employees where id = p_emp and org_id = p_org;
  if e.id is null then raise exception 'not allowed'; end if;
  return employee_hour_rate(e);
end $$;
create or replace function guard_client_timesheet() returns trigger language plpgsql set search_path = public as $$
declare r bigint;
begin
  if not is_client() then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'UPDATE' and (old.status <> 'draft' or new.org_id <> old.org_id) then raise exception 'TIMESHEET_POSTED: posted hours cannot be changed'; end if;
  new.status := 'draft'; new.entry_id := null;
  if tg_op = 'INSERT' then new.created_by := auth.uid(); else new.created_by := old.created_by; end if;
  r := timesheet_rate(new.org_id, new.employee_id);
  if not exists (select 1 from cost_centers where id = new.cost_center_id and org_id = new.org_id) then raise exception 'cost center not found'; end if;
  if new.task_id is not null and not exists (select 1 from tasks where id = new.task_id and org_id = new.org_id and cost_center_id = new.cost_center_id) then raise exception 'not allowed'; end if;
  if not new.rate_manual then new.rate := r; end if;
  new.amount := round(new.hours * new.rate);
  return new;
end $$;
create trigger timesheets_client_guard before insert or update or delete on timesheets for each row execute function guard_client_timesheet();

-- post the project's unposted hours up to a date: Dr salaries (project) / Cr salaries (general) —
-- moves labor already in payroll onto the project without changing the company's totals
create or replace function post_labor(p_cc uuid, p_until date) returns int
language plpgsql security definer set search_path = public as $$
declare c cost_centers; je uuid; ln record; n int := 0; tot bigint := 0;
begin
  select * into c from cost_centers where id = p_cc;
  if c.id is null then raise exception 'not allowed'; end if;
  if not (has_perm(c.org_id, 'accounting', 'post') or has_perm(c.org_id, 'manufacturing', 'post')) then raise exception 'not allowed'; end if;
  if not exists (select 1 from timesheets where cost_center_id = p_cc and status = 'draft' and work_date <= p_until) then return 0; end if;
  je := new_entry(c.org_id, p_until, 'تحميل تكلفة العمالة على المشروع: ' || c.name, 'manual', p_cc);
  for ln in select t.employee_id, e.full_name, sum(t.amount) amt, sum(t.hours) hrs, count(*) cnt from timesheets t join employees e on e.id = t.employee_id
            where t.cost_center_id = p_cc and t.status = 'draft' and t.work_date <= p_until group by t.employee_id, e.full_name loop
    perform jl(je, c.org_id, acct(c.org_id, 'salaries'), ln.amt, 0, null, p_cc, ln.full_name || ' — ' || ln.hrs || ' ساعة');
    tot := tot + ln.amt; n := n + ln.cnt;
  end loop;
  perform jl(je, c.org_id, acct(c.org_id, 'salaries'), 0, tot, null, null, 'عمالة محمّلة على ' || c.name);
  if tot > 0 then update journal_entries set status = 'posted' where id = je; else delete from journal_entries where id = je; je := null; end if;
  update timesheets set status = 'posted', entry_id = je where cost_center_id = p_cc and status = 'draft' and work_date <= p_until;
  return n;
end $$;

-- ---------- copy a project (or save one as a template) ----------
create or replace function copy_project(p_src uuid, p_code text, p_name text, p_party uuid, p_start date, p_template boolean default false) returns uuid
language plpgsql security definer set search_path = public as $$
declare s cost_centers; nid uuid; shift int;
begin
  select * into s from cost_centers where id = p_src;
  if s.id is null then raise exception 'not allowed'; end if;
  if not (has_perm(s.org_id, 'accounting', 'create') or has_perm(s.org_id, 'manufacturing', 'create')) then raise exception 'not allowed'; end if;
  if coalesce(trim(p_code), '') = '' or coalesce(trim(p_name), '') = '' then raise exception 'PROJECT_NAME: enter the code and name'; end if;
  if exists (select 1 from cost_centers where org_id = s.org_id and code = trim(p_code)) then raise exception 'PROJECT_CODE: this code is already used'; end if;
  if p_party is not null and not exists (select 1 from parties where id = p_party and org_id = s.org_id) then raise exception 'customer not found'; end if;
  shift := case when s.start_date is not null and p_start is not null then p_start - s.start_date else null end;
  insert into cost_centers (org_id, code, name, is_project, project_type, contract_value, retention_pct, party_id, product_item_id, production_qty, start_date, due_date,
                            description, is_template, source_project_id, manager_employee_id, budget_other, status)
  values (s.org_id, trim(p_code), trim(p_name), s.project_type <> 'internal', s.project_type, s.contract_value, s.retention_pct,
          case when p_template then null else coalesce(p_party, s.party_id) end, s.product_item_id, s.production_qty,
          case when p_template then null else p_start end,
          case when p_template or p_start is null then null when s.due_date is not null and s.start_date is not null then p_start + (s.due_date - s.start_date) else null end,
          s.description, coalesce(p_template, false), s.id, s.manager_employee_id, s.budget_other, 'active')
  returning id into nid;
  insert into project_materials (org_id, cost_center_id, item_id, planned_qty, note)
  select org_id, nid, item_id, planned_qty, note from project_materials where cost_center_id = p_src;
  insert into tasks (org_id, cost_center_id, title, notes, priority, status, est_hours, phase, sort, employee_ids, start_date, due_date, created_by)
  select org_id, nid, title, notes, priority, 'todo', est_hours, phase, sort, employee_ids,
         case when shift is null or p_template then null else start_date + shift end, case when shift is null or p_template then null else due_date + shift end, auth.uid()
  from tasks where cost_center_id = p_src;
  return nid;
end $$;

-- names of active workers for task assignment and hour logging (no salaries)
create or replace function list_workers(p_org uuid) returns table (id uuid, full_name text, job_title text, hour_rate bigint, rate_manual boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (has_perm(p_org, 'hr', 'view') or has_perm(p_org, 'manufacturing', 'view') or has_perm(p_org, 'accounting', 'view')) then raise exception 'not allowed'; end if;
  return query select e.id, e.full_name, e.job_title,
    case when has_perm(p_org, 'hr', 'view') or has_perm(p_org, 'accounting', 'view') then employee_hour_rate(e) end, e.hourly_rate is not null
  from employees e where e.org_id = p_org and e.status <> 'terminated' order by e.full_name;
end $$;
revoke execute on function employee_hour_rate(employees), guard_client_timesheet(), post_labor(uuid,date), copy_project(uuid,text,text,uuid,date,boolean),
  ensure_extra_accounts(uuid) from public, anon, authenticated;
revoke execute on function timesheet_rate(uuid,uuid) from public, anon;
grant execute on function post_labor(uuid,date), copy_project(uuid,text,text,uuid,date,boolean), timesheet_rate(uuid,uuid), list_workers(uuid) to authenticated;
revoke execute on function list_workers(uuid) from public, anon;
