-- =====================================================================
-- Migration 14 — feasibility studies
--  • feasibility_studies: one row per study; every input number keeps its
--    source (history / manual / ai) inside `inputs`; the AI write-up text
--    the user imported is kept in ai_notes
--  • new permission module "feasibility" (owner has it automatically)
--  • project_cost_history / item_history: the numbers a study can pull
--    from past work (per-unit materials, labor, other costs, sale price)
-- =====================================================================
create or replace function all_modules() returns text[] language sql immutable set search_path = public as $$
  select array['sales','purchases','expenses','inventory','manufacturing','accounting','reports','hr','settings','users','feasibility']
$$;

create table feasibility_studies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null check (length(name) between 1 and 200),
  kind text not null default 'product' check (kind in ('product','investment')),
  inputs jsonb not null default '{}'::jsonb check (jsonb_typeof(inputs) = 'object' and length(inputs::text) < 60000),
  ai_notes text check (ai_notes is null or length(ai_notes) < 40000),
  status text not null default 'draft' check (status in ('draft','approved','rejected')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on feasibility_studies (org_id, updated_at desc);
alter table feasibility_studies enable row level security;
create policy feas_read on feasibility_studies for select using (has_perm(org_id, 'feasibility', 'view'));
create policy feas_ins on feasibility_studies for insert with check (has_perm(org_id, 'feasibility', 'create'));
create policy feas_upd on feasibility_studies for update using (has_perm(org_id, 'feasibility', 'create')) with check (has_perm(org_id, 'feasibility', 'create'));
create policy feas_del on feasibility_studies for delete using (has_perm(org_id, 'feasibility', 'create'));
revoke all on feasibility_studies from public, anon, authenticated;
grant select, insert, update, delete on feasibility_studies to authenticated;

create or replace function guard_client_feasibility() returns trigger language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  if tg_op = 'UPDATE' then
    if new.org_id <> old.org_id then raise exception 'not allowed'; end if;
    new.created_by := old.created_by; new.created_at := old.created_at;
  else new.created_by := auth.uid(); new.created_at := now(); end if;
  new.updated_at := now();
  return new;
end $$;
create trigger feasibility_client_guard before insert or update on feasibility_studies for each row execute function guard_client_feasibility();

-- ---------- what a past project actually cost (halalas) ----------
create or replace function project_cost_history(p_org uuid, p_cc uuid)
returns table (revenue bigint, materials bigint, labor bigint, other bigint, hours numeric, qty numeric, name text, product_item_id uuid)
language plpgsql stable security definer set search_path = public as $$
begin
  if not has_perm(p_org, 'feasibility', 'view') then raise exception 'not allowed'; end if;
  if not exists (select 1 from cost_centers where id = p_cc and org_id = p_org) then raise exception 'not allowed'; end if;
  return query
  select
    coalesce((select sum(l.credit - l.debit) from journal_lines l join journal_entries e on e.id = l.entry_id and e.status = 'posted' join accounts a on a.id = l.account_id
              where l.org_id = p_org and l.cost_center_id = p_cc and a.type = 'revenue'), 0)::bigint,
    coalesce((select sum(l.debit - l.credit) from journal_lines l join journal_entries e on e.id = l.entry_id and e.status = 'posted' join accounts a on a.id = l.account_id
              where l.org_id = p_org and l.cost_center_id = p_cc and a.system_key in ('cogs','waste','stock_variance','project_materials')), 0)::bigint,
    coalesce((select sum(l.debit - l.credit) from journal_lines l join journal_entries e on e.id = l.entry_id and e.status = 'posted' join accounts a on a.id = l.account_id
              where l.org_id = p_org and l.cost_center_id = p_cc and a.system_key = 'salaries'), 0)::bigint,
    coalesce((select sum(l.debit - l.credit) from journal_lines l join journal_entries e on e.id = l.entry_id and e.status = 'posted' join accounts a on a.id = l.account_id
              where l.org_id = p_org and l.cost_center_id = p_cc and a.type = 'expense'
                and coalesce(a.system_key, '') not in ('cogs','waste','stock_variance','project_materials','salaries')), 0)::bigint,
    coalesce((select sum(t.hours) from timesheets t where t.org_id = p_org and t.cost_center_id = p_cc), 0)::numeric,
    c.production_qty::numeric, c.name, c.product_item_id
  from cost_centers c where c.id = p_cc;
end $$;

-- ---------- an item's average cost and its average sale price (last 12 months) ----------
create or replace function item_history(p_org uuid, p_item uuid)
returns table (avg_cost numeric, avg_price numeric, sold_qty numeric, list_price bigint, name text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not has_perm(p_org, 'feasibility', 'view') then raise exception 'not allowed'; end if;
  if not exists (select 1 from items where id = p_item and org_id = p_org) then raise exception 'not allowed'; end if;
  return query
  select i.avg_cost::numeric,
    (select round(sum(l.line_net)::numeric / nullif(sum(l.qty), 0), 2) from document_lines l join documents d on d.id = l.document_id
      where l.org_id = p_org and l.item_id = p_item and d.status = 'posted' and d.kind in ('tax_invoice','simplified_invoice')
        and d.issue_date >= current_date - 365),
    coalesce((select sum(l.qty) from document_lines l join documents d on d.id = l.document_id
      where l.org_id = p_org and l.item_id = p_item and d.status = 'posted' and d.kind in ('tax_invoice','simplified_invoice')
        and d.issue_date >= current_date - 365), 0)::numeric,
    i.sale_price, i.name_ar
  from items i where i.id = p_item;
end $$;

-- ---------- the company's monthly overheads: last 12 months of expenses not charged to a project ----------
create or replace function overhead_history(p_org uuid)
returns table (account_id uuid, name text, monthly bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not has_perm(p_org, 'feasibility', 'view') then raise exception 'not allowed'; end if;
  return query
  select a.id, a.name_ar, round(sum(l.debit - l.credit)::numeric / 12)::bigint
  from journal_lines l join journal_entries e on e.id = l.entry_id and e.status = 'posted' join accounts a on a.id = l.account_id
  where l.org_id = p_org and l.cost_center_id is null and a.type = 'expense'
    and coalesce(a.system_key, '') not in ('cogs','waste','stock_variance','project_materials')
    and e.entry_date > current_date - 365
  group by a.id, a.name_ar having sum(l.debit - l.credit) > 0
  order by 3 desc;
end $$;

revoke execute on function overhead_history(uuid) from public, anon;
grant execute on function overhead_history(uuid) to authenticated;
revoke execute on function project_cost_history(uuid, uuid), item_history(uuid, uuid), guard_client_feasibility() from public, anon;
grant execute on function project_cost_history(uuid, uuid), item_history(uuid, uuid) to authenticated;
