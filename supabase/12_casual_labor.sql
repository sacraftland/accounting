-- =====================================================================
-- Migration 12 — casual labor and outside workshops on projects
--  • employees get an employment type: monthly (payroll), daily or hourly
--    (paid by the day / hour worked, never in the monthly payroll)
--  • posting project hours: monthly staff → moved from general salaries to
--    the project; daily / hourly workers → wages owed to the worker
--  • paying casual workers from cash / bank, and their outstanding balances
--  Outside workshops (subcontractors) are suppliers: their work is a purchase
--  bill tagged with the project — no schema change needed.
-- =====================================================================
alter table employees add column employment_type text not null default 'monthly' check (employment_type in ('monthly','daily','hourly')),
  add column daily_rate bigint check (daily_rate is null or daily_rate > 0),
  add constraint employees_casual_rate check (
    (employment_type <> 'daily' or daily_rate is not null) and (employment_type <> 'hourly' or hourly_rate is not null));

create or replace function employee_hour_rate(e employees) returns bigint language sql stable set search_path = public as $$
  select coalesce(e.hourly_rate,
    case when e.employment_type = 'daily' and e.daily_rate is not null then round(e.daily_rate / 8.0)::bigint
         else round((e.basic_salary + e.housing_allowance + e.transport_allowance + other_allowances_total(e.other_allowances)) / 240.0)::bigint end)
$$;

-- monthly payroll: monthly staff only
create or replace function prepare_payroll(p_org uuid, p_month date) returns uuid
language plpgsql security definer set search_path = public as $$
declare m date := date_trunc('month', p_month)::date; rid uuid; e employees; c jsonb; st text;
begin
  perform require_perm(p_org, 'hr', 'create');
  select id, status into rid, st from payroll_runs where org_id = p_org and period_month = m;
  if st is not null and st <> 'draft' then raise exception 'PAYROLL_POSTED: this month is already posted'; end if;
  if rid is null then insert into payroll_runs (org_id, period_month) values (p_org, m) returning id into rid; end if;
  delete from payslips p where p.run_id = rid and not exists (select 1 from employees x where x.id = p.employee_id and x.org_id = p_org and x.employment_type = 'monthly'
     and x.status <> 'terminated' and x.hire_date <= (m + interval '1 month' - interval '1 day')::date and (x.end_date is null or x.end_date >= m));
  for e in select * from employees where org_id = p_org and status <> 'terminated' and employment_type = 'monthly'
           and hire_date <= (m + interval '1 month' - interval '1 day')::date and (end_date is null or end_date >= m) loop
    insert into payslips (run_id, org_id, employee_id, gross, net) values (rid, p_org, e.id, 0, 0) on conflict (run_id, employee_id) do nothing;
  end loop;
  perform recalc_payroll(rid);
  return rid;
end $$;

-- a party for the worker, so wages owed and paid show on one statement
create or replace function worker_party(e employees) returns uuid
language plpgsql security definer set search_path = public as $$
declare pid uuid;
begin
  if e.party_id is not null then return e.party_id; end if;
  insert into parties (org_id, kind, name, phone) values (e.org_id, 'employee', e.full_name, e.phone) returning id into pid;
  update employees set party_id = pid where id = e.id;
  return pid;
end $$;

create or replace function post_labor(p_cc uuid, p_until date) returns int
language plpgsql security definer set search_path = public as $$
declare c cost_centers; je uuid; ln record; n int := 0; moved bigint := 0; e employees;
begin
  select * into c from cost_centers where id = p_cc;
  if c.id is null then raise exception 'not allowed'; end if;
  if not (has_perm(c.org_id, 'accounting', 'post') or has_perm(c.org_id, 'manufacturing', 'post')) then raise exception 'not allowed'; end if;
  if not exists (select 1 from timesheets where cost_center_id = p_cc and status = 'draft' and work_date <= p_until) then return 0; end if;
  je := new_entry(c.org_id, p_until, 'تحميل تكلفة العمالة على المشروع: ' || c.name, 'manual', p_cc);
  for ln in select t.employee_id, sum(t.amount) amt, sum(t.hours) hrs, count(*) cnt from timesheets t
            where t.cost_center_id = p_cc and t.status = 'draft' and t.work_date <= p_until group by t.employee_id loop
    select * into e from employees where id = ln.employee_id;
    perform jl(je, c.org_id, acct(c.org_id, 'salaries'), ln.amt, 0, null, p_cc, e.full_name || ' — ' || ln.hrs || ' ساعة');
    if e.employment_type = 'monthly' then moved := moved + ln.amt;
    else perform jl(je, c.org_id, acct(c.org_id, 'salaries_payable'), 0, ln.amt, worker_party(e), null, 'أجور مستحقة: ' || e.full_name || ' — ' || c.name); end if;
    n := n + ln.cnt;
  end loop;
  perform jl(je, c.org_id, acct(c.org_id, 'salaries'), 0, moved, null, null, 'عمالة محمّلة على ' || c.name);
  if exists (select 1 from journal_lines where entry_id = je) then update journal_entries set status = 'posted' where id = je; else delete from journal_entries where id = je; je := null; end if;
  update timesheets set status = 'posted', entry_id = je where cost_center_id = p_cc and status = 'draft' and work_date <= p_until;
  return n;
end $$;

-- wages owed to daily / hourly workers
create or replace function casual_balances(p_org uuid) returns table (employee_id uuid, full_name text, employment_type text, earned bigint, paid bigint, owed bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (has_perm(p_org, 'hr', 'view') or has_perm(p_org, 'accounting', 'view') or has_perm(p_org, 'expenses', 'view') or has_perm(p_org, 'manufacturing', 'view')) then raise exception 'not allowed'; end if;
  return query select e.id, e.full_name, e.employment_type,
    coalesce(sum(l.credit), 0)::bigint, coalesce(sum(l.debit), 0)::bigint, coalesce(sum(l.credit - l.debit), 0)::bigint
  from employees e
  left join journal_lines l on l.party_id = e.party_id and l.party_id is not null and l.org_id = p_org
    and l.account_id = acct(p_org, 'salaries_payable') and exists (select 1 from journal_entries j where j.id = l.entry_id and j.status = 'posted')
  where e.org_id = p_org and e.employment_type <> 'monthly'
  group by e.id, e.full_name, e.employment_type order by 6 desc, 2;
end $$;

create or replace function pay_casual(p_org uuid, p_emp uuid, p_amount bigint, p_cash uuid, p_date date, p_memo text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare e employees; owed bigint; je uuid; k text;
begin
  if not (has_perm(p_org, 'expenses', 'post') or has_perm(p_org, 'accounting', 'post') or has_perm(p_org, 'hr', 'post')) then raise exception 'not allowed'; end if;
  select * into e from employees where id = p_emp and org_id = p_org;
  if e.id is null or e.employment_type = 'monthly' then raise exception 'not allowed'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'not allowed'; end if;
  select system_key into k from accounts where id = p_cash and org_id = p_org and is_postable;
  if k is null or k not in ('cash','bank') then raise exception 'PAID_FROM: choose the cash, bank, custody or supplier account'; end if;
  select coalesce(sum(credit - debit), 0) into owed from journal_lines l join journal_entries j on j.id = l.entry_id and j.status = 'posted'
   where l.org_id = p_org and l.party_id = e.party_id and l.account_id = acct(p_org, 'salaries_payable');
  if e.party_id is null or p_amount > owed then raise exception 'WAGES_MORE_THAN_OWED: the amount is more than the wages owed'; end if;
  je := new_entry(p_org, coalesce(p_date, current_date), coalesce(nullif(trim(p_memo), ''), 'صرف أجور: ' || e.full_name), 'manual', e.id);
  perform jl(je, p_org, acct(p_org, 'salaries_payable'), p_amount, 0, e.party_id);
  perform jl(je, p_org, p_cash, 0, p_amount);
  update journal_entries set status = 'posted' where id = je;
  return je;
end $$;

-- workers list carries the type and rates
drop function if exists list_workers(uuid);
create or replace function list_workers(p_org uuid) returns table (id uuid, full_name text, job_title text, hour_rate bigint, rate_manual boolean, employment_type text, daily_rate bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (has_perm(p_org, 'hr', 'view') or has_perm(p_org, 'manufacturing', 'view') or has_perm(p_org, 'accounting', 'view')) then raise exception 'not allowed'; end if;
  return query select e.id, e.full_name, e.job_title,
    case when has_perm(p_org, 'hr', 'view') or has_perm(p_org, 'accounting', 'view') then employee_hour_rate(e) end, e.hourly_rate is not null, e.employment_type,
    case when has_perm(p_org, 'hr', 'view') or has_perm(p_org, 'accounting', 'view') then e.daily_rate end
  from employees e where e.org_id = p_org and e.status <> 'terminated' order by e.employment_type, e.full_name;
end $$;

revoke execute on function worker_party(employees), casual_balances(uuid), pay_casual(uuid,uuid,bigint,uuid,date,text), list_workers(uuid), employee_hour_rate(employees) from public, anon, authenticated;
grant execute on function casual_balances(uuid), pay_casual(uuid,uuid,bigint,uuid,date,text), list_workers(uuid) to authenticated;
