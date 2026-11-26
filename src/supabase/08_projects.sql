-- =====================================================================
-- Migration 08 — projects (cost centers) profitability.
-- Uses the cost_center_id already carried on journal lines by invoices,
-- purchase bills, expenses, payroll and manufacturing. SECURITY INVOKER:
-- the journal's RLS decides what the caller sees.
-- =====================================================================
create or replace function project_pl(p_org uuid, p_from date, p_to date)
returns table (cost_center_id uuid, revenue bigint, cogs bigint, expenses bigint)
language sql stable security invoker set search_path = public as $$
  select l.cost_center_id,
    coalesce(sum(l.credit - l.debit) filter (where a.type = 'revenue'), 0)::bigint,
    coalesce(sum(l.debit - l.credit) filter (where a.system_key in ('cogs','waste','stock_variance')), 0)::bigint,
    coalesce(sum(l.debit - l.credit) filter (where a.type = 'expense' and coalesce(a.system_key,'') not in ('cogs','waste','stock_variance')), 0)::bigint
  from journal_lines l join journal_entries e on e.id = l.entry_id and e.status = 'posted'
  join accounts a on a.id = l.account_id
  where l.org_id = p_org and l.cost_center_id is not null and e.entry_date between p_from and p_to
  group by l.cost_center_id
$$;
create or replace function guard_client_cost_center() returns trigger language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  if tg_op = 'UPDATE' and new.org_id <> old.org_id then raise exception 'not allowed'; end if;
  if new.contract_value is not null and new.contract_value < 0 then raise exception 'not allowed'; end if;
  return new;
end $$;
drop trigger if exists cost_centers_client_guard on cost_centers;
create trigger cost_centers_client_guard before insert or update on cost_centers for each row execute function guard_client_cost_center();
revoke execute on function project_pl(uuid,date,date), guard_client_cost_center() from public, anon, authenticated;
grant execute on function project_pl(uuid,date,date) to authenticated;

-- manufacturing orders: project must belong to the same company
create or replace function guard_client_mfg_cc() returns trigger language plpgsql set search_path = public as $$
begin
  if is_client() and new.cost_center_id is not null and not exists (select 1 from cost_centers where id = new.cost_center_id and org_id = new.org_id) then
    raise exception 'cost center not found'; end if;
  return new;
end $$;
drop trigger if exists mfg_orders_cc_guard on mfg_orders;
create trigger mfg_orders_cc_guard before insert or update on mfg_orders for each row execute function guard_client_mfg_cc();
revoke execute on function guard_client_mfg_cc() from public, anon, authenticated;
