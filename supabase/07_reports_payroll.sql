-- =====================================================================
-- Migration 07 — financial reports and payroll.
--  Reports: account balances for any period (income statement, balance
--  sheet, trial balance by date), monthly summary for the dashboard,
--  VAT return. All SECURITY INVOKER → RLS decides what the user sees.
--  Payroll: employees, monthly runs with GOSI and end-of-service accrual,
--  posting and paying salaries. Runs and payslips change only via RPCs.
-- =====================================================================

-- ---------- reports ----------
create or replace function account_balances(p_org uuid, p_from date, p_to date)
returns table (account_id uuid, code text, name_ar text, type text, system_key text, parent_id uuid, is_postable boolean,
               opening bigint, debit bigint, credit bigint, closing bigint)
language sql stable security invoker set search_path = public as $$
  select a.id, a.code, a.name_ar, a.type, a.system_key, a.parent_id, a.is_postable,
    coalesce(sum(l.debit - l.credit) filter (where l.entry_date < p_from), 0)::bigint,
    coalesce(sum(l.debit) filter (where l.entry_date between p_from and p_to), 0)::bigint,
    coalesce(sum(l.credit) filter (where l.entry_date between p_from and p_to), 0)::bigint,
    coalesce(sum(l.debit - l.credit) filter (where l.entry_date <= p_to), 0)::bigint
  from accounts a
  left join (select l.account_id, l.debit, l.credit, e.entry_date from journal_lines l
             join journal_entries e on e.id = l.entry_id and e.status = 'posted' where l.org_id = p_org) l on l.account_id = a.id
  where a.org_id = p_org
  group by a.id order by a.code
$$;

create or replace function monthly_summary(p_org uuid, p_months int default 6)
returns table (month date, revenue bigint, cogs bigint, expenses bigint, cash_in bigint, cash_out bigint)
language sql stable security invoker set search_path = public as $$
  with m as (select generate_series(date_trunc('month', current_date) - make_interval(months => least(greatest(p_months,1),24) - 1),
                                    date_trunc('month', current_date), interval '1 month')::date mm)
  select m.mm,
    coalesce(sum(l.credit - l.debit) filter (where a.type = 'revenue'), 0)::bigint,
    coalesce(sum(l.debit - l.credit) filter (where a.system_key in ('cogs','waste','stock_variance')), 0)::bigint,
    coalesce(sum(l.debit - l.credit) filter (where a.type = 'expense' and coalesce(a.system_key,'') not in ('cogs','waste','stock_variance')), 0)::bigint,
    coalesce(sum(l.debit) filter (where a.system_key in ('cash','bank','card_clearing')), 0)::bigint,
    coalesce(sum(l.credit) filter (where a.system_key in ('cash','bank','card_clearing')), 0)::bigint
  from m
  left join journal_entries e on e.org_id = p_org and e.status = 'posted' and date_trunc('month', e.entry_date) = m.mm
  left join journal_lines l on l.entry_id = e.id
  left join accounts a on a.id = l.account_id
  group by m.mm order by m.mm
$$;

-- VAT return (ZATCA form layout): sales & purchases by category, with adjustments from credit notes / returns
create or replace function vat_return(p_org uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (has_perm(p_org, 'reports', 'view') or has_perm(p_org, 'accounting', 'view')) then raise exception 'not allowed'; end if;
  return (with s as (
    select d.kind, l.tax_category cat, sum(l.line_net) net, sum(l.line_vat) vat
    from documents d join document_lines l on l.document_id = d.id
    where d.org_id = p_org and d.status = 'posted' and d.issue_date between p_from and p_to
      and d.kind in ('tax_invoice','simplified_invoice','credit_note','purchase_bill','purchase_return')
    group by d.kind, l.tax_category),
  x as (select coalesce(sum(amount),0) net, coalesce(sum(vat_amount),0) vat from expenses
        where org_id = p_org and status = 'posted' and expense_date between p_from and p_to and vat_amount > 0)
  select jsonb_build_object(
    'sales_standard',   jsonb_build_object('net', coalesce((select sum(net) from s where kind in ('tax_invoice','simplified_invoice') and cat = 'S'),0),
                                           'vat', coalesce((select sum(vat) from s where kind in ('tax_invoice','simplified_invoice') and cat = 'S'),0),
                                           'adj_net', coalesce((select sum(net) from s where kind = 'credit_note' and cat = 'S'),0),
                                           'adj_vat', coalesce((select sum(vat) from s where kind = 'credit_note' and cat = 'S'),0)),
    'sales_zero',       jsonb_build_object('net', coalesce((select sum(net) from s where kind in ('tax_invoice','simplified_invoice') and cat = 'Z'),0),
                                           'adj_net', coalesce((select sum(net) from s where kind = 'credit_note' and cat = 'Z'),0)),
    'sales_exempt',     jsonb_build_object('net', coalesce((select sum(net) from s where kind in ('tax_invoice','simplified_invoice') and cat in ('E','O')),0),
                                           'adj_net', coalesce((select sum(net) from s where kind = 'credit_note' and cat in ('E','O')),0)),
    'purchases_standard', jsonb_build_object('net', coalesce((select sum(net) from s where kind = 'purchase_bill' and cat = 'S'),0) + (select net from x),
                                           'vat', coalesce((select sum(vat) from s where kind = 'purchase_bill' and cat = 'S'),0) + (select vat from x),
                                           'adj_net', coalesce((select sum(net) from s where kind = 'purchase_return' and cat = 'S'),0),
                                           'adj_vat', coalesce((select sum(vat) from s where kind = 'purchase_return' and cat = 'S'),0)),
    'purchases_zero',   jsonb_build_object('net', coalesce((select sum(net) from s where kind = 'purchase_bill' and cat in ('Z','E','O')),0),
                                           'adj_net', coalesce((select sum(net) from s where kind = 'purchase_return' and cat in ('Z','E','O')),0))));
end $$;

-- ---------- payroll ----------
alter table payroll_runs drop constraint payroll_runs_status_check;
alter table payroll_runs add constraint payroll_runs_status_check check (status in ('draft','posted','paid'));
alter table payroll_runs add column number text, add column posted_at timestamptz, add column paid_at timestamptz,
  add column submitted_at timestamptz, add column include_eosb boolean not null default true,
  add column total_gross bigint not null default 0, add column total_net bigint not null default 0,
  add column total_gosi bigint not null default 0, add column total_eosb bigint not null default 0;
alter table payslips add column org_id uuid references orgs(id) on delete cascade,
  add column eosb bigint not null default 0, add column note text;
alter table employees add column job_title text, add column phone text;

-- runs and payslips: read through RLS, write only through the functions below
revoke insert, update, delete on payroll_runs, payslips from authenticated;
drop policy if exists payroll_runs_all on payroll_runs;
create policy payroll_runs_read on payroll_runs for select using (has_perm(org_id, 'hr', 'view'));

-- employees: hr-create writes; keep linked rows inside the same company
create or replace function guard_client_employee() returns trigger language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  if tg_op = 'UPDATE' and new.org_id <> old.org_id then raise exception 'not allowed'; end if;
  if new.party_id is not null and not exists (select 1 from parties where id = new.party_id and org_id = new.org_id) then raise exception 'customer not found'; end if;
  if new.branch_id is not null and not exists (select 1 from branches where id = new.branch_id and org_id = new.org_id) then raise exception 'branch not found'; end if;
  if new.cost_center_id is not null and not exists (select 1 from cost_centers where id = new.cost_center_id and org_id = new.org_id) then raise exception 'cost center not found'; end if;
  if new.basic_salary < 0 or new.housing_allowance < 0 or new.transport_allowance < 0 then raise exception 'EMP_SALARY: salary amounts cannot be negative'; end if;
  new.updated_at := now();
  return new;
end $$;
create trigger employees_client_guard before insert or update on employees for each row execute function guard_client_employee();

-- the end-of-service expense account (new companies via create_org, existing ones here)
create or replace function ensure_extra_accounts(o uuid) returns void
language sql security definer set search_path = public as $$
  insert into accounts (org_id, parent_id, code, name_ar, type, system_key)
  select o, (select id from accounts where org_id = o and code = '52'), '5212', 'مكافأة نهاية الخدمة', 'expense', 'eosb_expense'
  where not exists (select 1 from accounts where org_id = o and (system_key = 'eosb_expense' or code = '5212'));
$$;
select ensure_extra_accounts(id) from orgs;
create or replace function create_org(p_name text, p_vat text default null, p_cr text default null,
  p_city text default null, p_street text default null, p_building text default null, p_postal text default null,
  p_district text default null, p_sector text default 'general') returns uuid
language plpgsql security definer set search_path = public as $$
declare o uuid; b uuid;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if not is_platform_admin() and not (select open_signup from platform_settings) then
    raise exception 'NOT_ALLOWED_CREATE_ORG: only the owner can create a company';
  end if;
  insert into orgs (name_ar, vat_number, cr_number, city, street, building_no, postal_code, district, sector)
  values (p_name, nullif(p_vat,''), nullif(p_cr,''), p_city, p_street, p_building, p_postal, p_district, p_sector) returning id into o;
  insert into members (org_id, user_id, role) values (o, auth.uid(), 'owner');
  insert into branches (org_id, name, city, street, building_no, postal_code) values (o, 'الفرع الرئيسي', p_city, p_street, p_building, p_postal) returning id into b;
  insert into warehouses (org_id, branch_id, name) values (o, b, 'المستودع الرئيسي');
  perform seed_chart(o);
  perform seed_roles(o);
  perform ensure_extra_accounts(o);
  return o;
end $$;


create or replace function other_allowances_total(j jsonb) returns bigint language sql immutable set search_path = public as $$
  select coalesce(sum(case when jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric else 0 end), 0)::bigint from jsonb_each(coalesce(j, '{}')) t(k, v)
$$;

-- GOSI (Saudi rules, standard rates): contribution base = basic + housing, capped at 45,000 SAR
--  Saudi:     employee 9.75%  (annuities 9% + SANED 0.75%), employer 11.75% (9% + hazards 2% + SANED 0.75%)
--  Non-Saudi: employee 0%,     employer 2% (occupational hazards)
create or replace function payslip_calc(e employees, p_add bigint, p_ded bigint, p_month date, p_eosb boolean) returns jsonb
language plpgsql stable set search_path = public as $$
declare gross bigint := e.basic_salary + e.housing_allowance + e.transport_allowance + other_allowances_total(e.other_allowances);
  base bigint := least(e.basic_salary + e.housing_allowance, 4500000); ee bigint := 0; er bigint := 0; yrs numeric; eosb bigint := 0;
begin
  if e.gosi_enrolled then
    if e.is_saudi then ee := round(base * 0.0975); er := round(base * 0.1175); else er := round(base * 0.02); end if;
  end if;
  if p_eosb then
    yrs := greatest((p_month + interval '1 month' - interval '1 day')::date - e.hire_date, 0) / 365.0;
    eosb := round((e.basic_salary + e.housing_allowance + e.transport_allowance) / 12.0 * case when yrs >= 5 then 1 else 0.5 end);
  end if;
  return jsonb_build_object('gross', gross, 'ee', ee, 'er', er, 'eosb', eosb, 'net', gross + p_add - p_ded - ee);
end $$;

create or replace function prepare_payroll(p_org uuid, p_month date) returns uuid
language plpgsql security definer set search_path = public as $$
declare m date := date_trunc('month', p_month)::date; rid uuid; e employees; c jsonb; st text;
begin
  perform require_perm(p_org, 'hr', 'create');
  select id, status into rid, st from payroll_runs where org_id = p_org and period_month = m;
  if st is not null and st <> 'draft' then raise exception 'PAYROLL_POSTED: this month is already posted'; end if;
  if rid is null then insert into payroll_runs (org_id, period_month) values (p_org, m) returning id into rid; end if;
  -- refresh: add employees active in the month, drop ones no longer active; keep manual additions/deductions
  delete from payslips p where p.run_id = rid and not exists (select 1 from employees x where x.id = p.employee_id and x.org_id = p_org
     and x.status <> 'terminated' and x.hire_date <= (m + interval '1 month' - interval '1 day')::date and (x.end_date is null or x.end_date >= m));
  for e in select * from employees where org_id = p_org and status <> 'terminated'
           and hire_date <= (m + interval '1 month' - interval '1 day')::date and (end_date is null or end_date >= m) loop
    insert into payslips (run_id, org_id, employee_id, gross, net) values (rid, p_org, e.id, 0, 0) on conflict (run_id, employee_id) do nothing;
  end loop;
  perform recalc_payroll(rid);
  return rid;
end $$;

create or replace function recalc_payroll(rid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r payroll_runs; p record; c jsonb;
begin
  select * into r from payroll_runs where id = rid;
  for p in select ps.id, ps.additions, ps.deductions, e from payslips ps join employees e on e.id = ps.employee_id where ps.run_id = rid loop
    c := payslip_calc(p.e, p.additions, p.deductions, r.period_month, r.include_eosb);
    update payslips set gross = (c->>'gross')::bigint, gosi_employee = (c->>'ee')::bigint, gosi_employer = (c->>'er')::bigint,
      eosb = (c->>'eosb')::bigint, net = (c->>'net')::bigint where id = p.id;
  end loop;
  update payroll_runs set total_gross = (select coalesce(sum(gross + additions - deductions),0) from payslips where run_id = rid),
    total_net = (select coalesce(sum(net),0) from payslips where run_id = rid),
    total_gosi = (select coalesce(sum(gosi_employee + gosi_employer),0) from payslips where run_id = rid),
    total_eosb = (select coalesce(sum(eosb),0) from payslips where run_id = rid) where id = rid;
end $$;

create or replace function update_payslip(p_id uuid, p_additions bigint, p_deductions bigint, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare r payroll_runs;
begin
  select pr.* into r from payroll_runs pr join payslips ps on ps.run_id = pr.id where ps.id = p_id;
  if r.id is null then raise exception 'not allowed'; end if;
  perform require_perm(r.org_id, 'hr', 'create');
  if r.status <> 'draft' then raise exception 'PAYROLL_POSTED: this month is already posted'; end if;
  if p_additions < 0 or p_deductions < 0 then raise exception 'EMP_SALARY: salary amounts cannot be negative'; end if;
  update payslips set additions = p_additions, deductions = p_deductions, note = nullif(trim(p_note), '') where id = p_id;
  perform recalc_payroll(r.id);
  if (select net from payslips where id = p_id) < 0 then raise exception 'PAYSLIP_NEGATIVE: deductions are larger than the salary'; end if;
end $$;

create or replace function set_payroll_options(p_run uuid, p_include_eosb boolean, p_submit boolean) returns void
language plpgsql security definer set search_path = public as $$
declare r payroll_runs;
begin
  select * into r from payroll_runs where id = p_run;
  if r.id is null then raise exception 'not allowed'; end if;
  perform require_perm(r.org_id, 'hr', 'create');
  if r.status <> 'draft' then raise exception 'PAYROLL_POSTED: this month is already posted'; end if;
  update payroll_runs set include_eosb = coalesce(p_include_eosb, include_eosb),
    submitted_at = case when p_submit then now() else submitted_at end where id = p_run;
  perform recalc_payroll(p_run);
end $$;

create or replace function delete_payroll(p_run uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r payroll_runs;
begin
  select * into r from payroll_runs where id = p_run;
  if r.id is null then raise exception 'not allowed'; end if;
  perform require_perm(r.org_id, 'hr', 'create');
  if r.status <> 'draft' then raise exception 'PAYROLL_POSTED: this month is already posted'; end if;
  delete from payroll_runs where id = p_run;
end $$;

-- accrue: Dr salaries (gross+add-ded), Dr GOSI expense (employer), Dr EOSB expense
--         Cr GOSI payable (employee+employer), Cr salaries payable (net), Cr EOSB provision
create or replace function post_payroll(p_run uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare r payroll_runs; je uuid; o uuid; d date; ln record;
begin
  select * into r from payroll_runs where id = p_run for update;
  if r.id is null then raise exception 'not allowed'; end if;
  o := r.org_id; perform require_perm(o, 'hr', 'post');
  if r.status <> 'draft' then raise exception 'PAYROLL_POSTED: this month is already posted'; end if;
  perform recalc_payroll(p_run); select * into r from payroll_runs where id = p_run;
  if not exists (select 1 from payslips where run_id = p_run) then raise exception 'PAYROLL_EMPTY: no employees in this month'; end if;
  if exists (select 1 from payslips where run_id = p_run and net < 0) then raise exception 'PAYSLIP_NEGATIVE: deductions are larger than the salary'; end if;
  d := (r.period_month + interval '1 month' - interval '1 day')::date;
  je := new_entry(o, d, 'رواتب شهر ' || to_char(r.period_month, 'YYYY-MM'), 'payroll', p_run);
  for ln in select e.cost_center_id cc, sum(p.gross + p.additions - p.deductions) sal, sum(p.gosi_employer) er, sum(p.eosb) eo
            from payslips p join employees e on e.id = p.employee_id where p.run_id = p_run group by e.cost_center_id loop
    perform jl(je, o, acct(o,'salaries'), ln.sal, 0, null, ln.cc);
    perform jl(je, o, acct(o,'gosi_expense'), ln.er, 0, null, ln.cc);
    perform jl(je, o, coalesce(acct(o,'eosb_expense'), acct(o,'salaries')), ln.eo, 0, null, ln.cc);
  end loop;
  perform jl(je, o, acct(o,'gosi_payable'), 0, r.total_gosi);
  perform jl(je, o, acct(o,'salaries_payable'), 0, r.total_net);
  perform jl(je, o, acct(o,'eosb_provision'), 0, r.total_eosb);
  update journal_entries set status = 'posted' where id = je;
  update payroll_runs set status = 'posted', posted_at = now(), number = fmt_no('PAY-', next_number(o, 'pay')) where id = p_run;
  return je;
end $$;

-- pay the net salaries (bank transfer / cash): Dr salaries payable, Cr bank
create or replace function pay_payroll(p_run uuid, p_account uuid, p_date date default current_date) returns uuid
language plpgsql security definer set search_path = public as $$
declare r payroll_runs; je uuid; k text;
begin
  select * into r from payroll_runs where id = p_run for update;
  if r.id is null then raise exception 'not allowed'; end if;
  perform require_perm(r.org_id, 'hr', 'post');
  if r.status <> 'posted' then raise exception 'PAYROLL_NOT_POSTED: post the payroll first'; end if;
  select system_key into k from accounts where id = p_account and org_id = r.org_id and is_postable;
  if k is null or k not in ('cash','bank') then raise exception 'PAID_FROM: choose the cash, bank, custody or supplier account'; end if;
  je := new_entry(r.org_id, p_date, 'صرف رواتب ' || r.number, 'payroll', p_run);
  perform jl(je, r.org_id, acct(r.org_id,'salaries_payable'), r.total_net, 0);
  perform jl(je, r.org_id, p_account, 0, r.total_net);
  update journal_entries set status = 'posted' where id = je;
  update payroll_runs set status = 'paid', paid_at = now() where id = p_run;
  return je;
end $$;

-- ---------- grants ----------
revoke execute on function account_balances(uuid,date,date), monthly_summary(uuid,int), vat_return(uuid,date,date),
  other_allowances_total(jsonb), payslip_calc(employees,bigint,bigint,date,boolean), prepare_payroll(uuid,date), recalc_payroll(uuid),
  update_payslip(uuid,bigint,bigint,text), set_payroll_options(uuid,boolean,boolean), delete_payroll(uuid), post_payroll(uuid),
  pay_payroll(uuid,uuid,date), guard_client_employee(), ensure_extra_accounts(uuid) from public, anon, authenticated;
grant execute on function account_balances(uuid,date,date), monthly_summary(uuid,int), vat_return(uuid,date,date),
  prepare_payroll(uuid,date), update_payslip(uuid,bigint,bigint,text), set_payroll_options(uuid,boolean,boolean),
  delete_payroll(uuid), post_payroll(uuid), pay_payroll(uuid,uuid,date) to authenticated;
