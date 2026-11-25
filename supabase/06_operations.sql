-- =====================================================================
-- Migration 06 — the operations: purchases, returns, quotes & orders,
-- expenses, manual journal entries, warehouses & stock documents,
-- and manufacturing (bills of materials + manufacturing orders).
-- Every posting function checks has_perm(module, 'post').
-- Stock is weighted-average cost across warehouses; quantities per
-- warehouse. Raw materials sit in 1302, other stock in 1301.
-- =====================================================================

-- ---------- columns ----------
alter table documents drop constraint documents_kind_check;
alter table documents add constraint documents_kind_check check (kind in ('tax_invoice','simplified_invoice','credit_note','debit_note',
  'quote','sales_order','purchase_bill','purchase_return','purchase_order','progress_bill'));
alter table documents add column submitted_at timestamptz;              -- "sent for approval"
alter table document_lines add column account_id uuid references accounts(id) on delete restrict;   -- non-stock purchase lines
alter table orgs add column allow_negative_stock boolean not null default true;
grant update (allow_negative_stock) on orgs to authenticated;

alter table expenses add column number text, add column posted_at timestamptz, add column submitted_at timestamptz,
  add column warehouse_id uuid references warehouses(id) on delete restrict;
alter table stock_docs add column posted_at timestamptz, add column submitted_at timestamptz, add column created_by uuid;
alter table stock_doc_lines add column unit_cost numeric(18,4), add column line_no int;

-- ---------- manufacturing ----------
create table boms (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  item_id uuid not null references items(id) on delete cascade,       -- the finished product
  output_qty numeric(18,4) not null default 1 check (output_qty > 0),  -- components below make this many
  notes text,
  updated_at timestamptz not null default now(),
  unique (org_id, item_id)
);
create table bom_lines (
  id uuid primary key default gen_random_uuid(),
  bom_id uuid not null references boms(id) on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  line_no int not null default 1,
  item_id uuid not null references items(id) on delete restrict,       -- component
  qty numeric(18,4) not null check (qty > 0),
  waste_pct numeric(5,2) not null default 0 check (waste_pct between 0 and 100)
);
create index on bom_lines (bom_id);

create table mfg_orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  number text,
  item_id uuid not null references items(id) on delete restrict,
  warehouse_id uuid not null references warehouses(id) on delete restrict,
  qty numeric(18,4) not null check (qty > 0),
  order_date date not null default current_date,
  party_id uuid references parties(id) on delete restrict,             -- made for this customer (optional)
  related_document_id uuid references documents(id) on delete set null,-- quote / order it serves (optional)
  cost_center_id uuid references cost_centers(id) on delete restrict,
  status text not null default 'draft' check (status in ('draft','posted','void')),
  notes text,
  material_cost bigint not null default 0,
  waste_cost bigint not null default 0,
  extra_cost bigint not null default 0,
  total_cost bigint not null default 0,
  unit_cost numeric(18,4),
  submitted_at timestamptz,
  posted_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (org_id, number)
);
create index on mfg_orders (org_id, order_date desc);
create table mfg_order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references mfg_orders(id) on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  line_no int not null default 1,
  item_id uuid not null references items(id) on delete restrict,
  planned_qty numeric(18,4) not null default 0 check (planned_qty >= 0),
  actual_qty numeric(18,4) not null default 0 check (actual_qty >= 0),
  waste_qty numeric(18,4) not null default 0 check (waste_qty >= 0),
  unit_cost numeric(18,4)
);
create index on mfg_order_lines (order_id);
create table mfg_order_costs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references mfg_orders(id) on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  description text not null,
  amount bigint not null check (amount > 0),
  account_id uuid not null references accounts(id) on delete restrict  -- credited (cash, salaries payable, …)
);

alter table boms enable row level security;
alter table bom_lines enable row level security;
alter table mfg_orders enable row level security;
alter table mfg_order_lines enable row level security;
alter table mfg_order_costs enable row level security;
create policy boms_read on boms for select using (has_perm(org_id, 'manufacturing', 'view'));
create policy boms_write on boms for all using (has_perm(org_id, 'manufacturing', 'create')) with check (has_perm(org_id, 'manufacturing', 'create'));
create policy bom_lines_read on bom_lines for select using (has_perm(org_id, 'manufacturing', 'view'));
create policy bom_lines_write on bom_lines for all using (has_perm(org_id, 'manufacturing', 'create'))
  with check (has_perm(org_id, 'manufacturing', 'create') and exists (select 1 from boms b where b.id = bom_id and b.org_id = bom_lines.org_id));
create policy mfg_orders_read on mfg_orders for select using (has_perm(org_id, 'manufacturing', 'view'));
create policy mfg_orders_ins on mfg_orders for insert with check (has_perm(org_id, 'manufacturing', 'create'));
create policy mfg_orders_upd on mfg_orders for update using (has_perm(org_id, 'manufacturing', 'create')) with check (has_perm(org_id, 'manufacturing', 'create'));
create policy mfg_orders_del on mfg_orders for delete using (has_perm(org_id, 'manufacturing', 'create') and status = 'draft');
create policy mfg_lines_read on mfg_order_lines for select using (has_perm(org_id, 'manufacturing', 'view'));
create policy mfg_lines_write on mfg_order_lines for all using (has_perm(org_id, 'manufacturing', 'create')) with check (has_perm(org_id, 'manufacturing', 'create'));
create policy mfg_costs_read on mfg_order_costs for select using (has_perm(org_id, 'manufacturing', 'view'));
create policy mfg_costs_write on mfg_order_costs for all using (has_perm(org_id, 'manufacturing', 'create')) with check (has_perm(org_id, 'manufacturing', 'create'));
grant select, insert, update, delete on boms, bom_lines, mfg_orders, mfg_order_lines, mfg_order_costs to authenticated;

-- stock per warehouse, with value (RLS through stock_moves)
create or replace view stock_by_warehouse with (security_invoker = true) as
  select m.org_id, m.item_id, m.warehouse_id, sum(m.qty) as qty
  from stock_moves m group by m.org_id, m.item_id, m.warehouse_id;
grant select on stock_by_warehouse to authenticated;

-- ---------- client-write guards for the new / reused tables ----------
create or replace function guard_client_document() returns trigger language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  if tg_op = 'UPDATE' then
    if old.status <> 'draft' then raise exception 'posted documents cannot be edited — issue a credit or debit note'; end if;
    if new.org_id <> old.org_id or new.kind <> old.kind then raise exception 'not allowed'; end if;
    new.zatca_uuid := old.zatca_uuid; new.created_by := old.created_by;
  else
    new.created_by := auth.uid();
    if new.kind not in ('tax_invoice','simplified_invoice','credit_note','quote','sales_order','purchase_bill','purchase_return','purchase_order') then
      raise exception 'not allowed'; end if;
  end if;
  if new.status <> 'draft' then raise exception 'use the posting function to post'; end if;
  new.number := null; new.amount_paid := 0; new.payment_status := 'unpaid'; new.posted_at := null;
  new.subtotal := 0; new.vat_total := 0; new.total := 0;
  new.zatca_status := 'not_sent'; new.zatca_icv := null; new.zatca_pih := null; new.zatca_hash := null;
  new.zatca_qr := null; new.zatca_xml := null; new.zatca_device_id := null; new.zatca_response := null;
  if new.party_id is not null and not exists (select 1 from parties where id = new.party_id and org_id = new.org_id) then raise exception 'customer not found'; end if;
  if not exists (select 1 from branches where id = new.branch_id and org_id = new.org_id) then raise exception 'branch not found'; end if;
  if new.warehouse_id is not null and not exists (select 1 from warehouses where id = new.warehouse_id and org_id = new.org_id) then raise exception 'warehouse not found'; end if;
  if new.related_document_id is not null and not exists (select 1 from documents where id = new.related_document_id and org_id = new.org_id) then raise exception 'document not found'; end if;
  if new.cost_center_id is not null and not exists (select 1 from cost_centers where id = new.cost_center_id and org_id = new.org_id) then raise exception 'cost center not found'; end if;
  return new;
end $$;

create or replace function guard_client_doc_line() returns trigger language plpgsql set search_path = public as $$
declare r document_lines := coalesce(new, old);
begin
  if not is_client() then return coalesce(new, old); end if;
  if not exists (select 1 from documents where id = r.document_id and org_id = r.org_id and status = 'draft') then
    raise exception 'lines of a posted document cannot be changed'; end if;
  if tg_op = 'UPDATE' and (new.document_id <> old.document_id or new.org_id <> old.org_id) then raise exception 'not allowed'; end if;
  if tg_op = 'DELETE' then return old; end if;
  if new.item_id is not null and not exists (select 1 from items where id = new.item_id and org_id = new.org_id) then raise exception 'item not found'; end if;
  if new.account_id is not null and not exists (select 1 from accounts where id = new.account_id and org_id = new.org_id and is_postable) then raise exception 'account not found'; end if;
  new.line_net := 0; new.line_vat := 0; new.unit_cost := null;
  return new;
end $$;

create or replace function guard_client_expense() returns trigger language plpgsql set search_path = public as $$
begin
  if not is_client() then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'UPDATE' and (old.status <> 'draft' or new.org_id <> old.org_id) then raise exception 'posted vouchers cannot be edited'; end if;
  if new.status <> 'draft' then raise exception 'use the posting function to post'; end if;
  new.number := null; new.posted_at := null;
  if tg_op = 'INSERT' then new.created_by := auth.uid(); else new.created_by := old.created_by; end if;
  if not exists (select 1 from accounts where id = new.account_id and org_id = new.org_id and is_postable) then raise exception 'account not found'; end if;
  if not exists (select 1 from accounts where id = new.paid_from_account_id and org_id = new.org_id and is_postable) then raise exception 'account not found'; end if;
  if new.supplier_id is not null and not exists (select 1 from parties where id = new.supplier_id and org_id = new.org_id) then raise exception 'customer not found'; end if;
  if new.employee_id is not null and not exists (select 1 from parties where id = new.employee_id and org_id = new.org_id) then raise exception 'customer not found'; end if;
  if new.cost_center_id is not null and not exists (select 1 from cost_centers where id = new.cost_center_id and org_id = new.org_id) then raise exception 'cost center not found'; end if;
  return new;
end $$;
create trigger expenses_client_guard before insert or update on expenses for each row execute function guard_client_expense();

create or replace function guard_client_stock_doc() returns trigger language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  if tg_op = 'UPDATE' and (old.status <> 'draft' or new.org_id <> old.org_id) then raise exception 'posted documents cannot be edited — issue a credit or debit note'; end if;
  if new.status <> 'draft' then raise exception 'use the posting function to post'; end if;
  new.number := null; new.posted_at := null;
  if tg_op = 'INSERT' then new.created_by := auth.uid(); else new.created_by := old.created_by; end if;
  if new.from_warehouse_id is not null and not exists (select 1 from warehouses where id = new.from_warehouse_id and org_id = new.org_id) then raise exception 'warehouse not found'; end if;
  if new.to_warehouse_id is not null and not exists (select 1 from warehouses where id = new.to_warehouse_id and org_id = new.org_id) then raise exception 'warehouse not found'; end if;
  return new;
end $$;
create trigger stock_docs_client_guard before insert or update on stock_docs for each row execute function guard_client_stock_doc();

create or replace function guard_client_stock_line() returns trigger language plpgsql set search_path = public as $$
declare r stock_doc_lines := coalesce(new, old); o uuid;
begin
  if not is_client() then return coalesce(new, old); end if;
  select org_id into o from stock_docs where id = r.stock_doc_id and status = 'draft';
  if o is null then raise exception 'lines of a posted document cannot be changed'; end if;
  if tg_op = 'DELETE' then return old; end if;
  if not exists (select 1 from items where id = new.item_id and org_id = o) then raise exception 'item not found'; end if;
  new.system_qty := null;
  return new;
end $$;
create trigger stock_lines_client_guard before insert or update or delete on stock_doc_lines for each row execute function guard_client_stock_line();

create or replace function guard_client_mfg() returns trigger language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  if tg_op = 'UPDATE' and (old.status <> 'draft' or new.org_id <> old.org_id) then raise exception 'posted documents cannot be edited — issue a credit or debit note'; end if;
  if new.status <> 'draft' then raise exception 'use the posting function to post'; end if;
  new.number := null; new.posted_at := null; new.material_cost := 0; new.waste_cost := 0; new.extra_cost := 0; new.total_cost := 0; new.unit_cost := null;
  if tg_op = 'INSERT' then new.created_by := auth.uid(); else new.created_by := old.created_by; end if;
  if not exists (select 1 from items where id = new.item_id and org_id = new.org_id) then raise exception 'item not found'; end if;
  if not exists (select 1 from warehouses where id = new.warehouse_id and org_id = new.org_id) then raise exception 'warehouse not found'; end if;
  if new.party_id is not null and not exists (select 1 from parties where id = new.party_id and org_id = new.org_id) then raise exception 'customer not found'; end if;
  if new.related_document_id is not null and not exists (select 1 from documents where id = new.related_document_id and org_id = new.org_id) then raise exception 'document not found'; end if;
  return new;
end $$;
create trigger mfg_orders_client_guard before insert or update on mfg_orders for each row execute function guard_client_mfg();

create or replace function guard_client_mfg_child() returns trigger language plpgsql set search_path = public as $$
declare oid uuid := coalesce(new.order_id, old.order_id); org uuid := coalesce(new.org_id, old.org_id);
begin
  if not is_client() then return coalesce(new, old); end if;
  if not exists (select 1 from mfg_orders where id = oid and org_id = org and status = 'draft') then
    raise exception 'lines of a posted document cannot be changed'; end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_table_name = 'mfg_order_lines' then
    if not exists (select 1 from items where id = new.item_id and org_id = org) then raise exception 'item not found'; end if;
    new.unit_cost := null;
  else
    if not exists (select 1 from accounts where id = new.account_id and org_id = org and is_postable) then raise exception 'account not found'; end if;
  end if;
  return new;
end $$;
create trigger mfg_lines_client_guard before insert or update or delete on mfg_order_lines for each row execute function guard_client_mfg_child();
create trigger mfg_costs_client_guard before insert or update or delete on mfg_order_costs for each row execute function guard_client_mfg_child();

create or replace function guard_client_bom_line() returns trigger language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  if not exists (select 1 from items where id = new.item_id and org_id = new.org_id) then raise exception 'item not found'; end if;
  if exists (select 1 from boms where id = new.bom_id and item_id = new.item_id) then raise exception 'BOM_SELF: a product cannot be its own component'; end if;
  return new;
end $$;
create trigger bom_lines_client_guard before insert or update on bom_lines for each row execute function guard_client_bom_line();
create or replace function guard_client_bom() returns trigger language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  if not exists (select 1 from items where id = new.item_id and org_id = new.org_id) then raise exception 'item not found'; end if;
  new.updated_at := now();
  return new;
end $$;
create trigger boms_client_guard before insert or update on boms for each row execute function guard_client_bom();

-- ---------- helpers ----------
create or replace function fmt_no(prefix text, n bigint) returns text language sql immutable set search_path = public as $$ select prefix || lpad(n::text, 5, '0') $$;
create or replace function inv_acct(o uuid, item_kind text) returns uuid language sql stable set search_path = public as $$
  select acct(o, case when item_kind = 'raw_material' then 'raw_materials' else 'inventory' end)
$$;
create or replace function require_perm(o uuid, module text, action text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if o is null or not has_perm(o, module, action) then raise exception 'not allowed'; end if;
end $$;

-- receive stock at a unit cost: weighted average across all warehouses
create or replace function receive_stock(o uuid, it uuid, wh uuid, d date, q numeric, p_unit numeric, src text, sid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare on_hand numeric; cur numeric;
begin
  if q <= 0 then return; end if;
  select coalesce(sum(qty),0) into on_hand from stock_moves where item_id = it;
  select avg_cost into cur from items where id = it for update;
  update items set avg_cost = case when on_hand > 0 then (on_hand * cur + q * p_unit) / (on_hand + q) else p_unit end where id = it;
  insert into stock_moves (org_id, item_id, warehouse_id, move_date, qty, unit_cost, source_type, source_id) values (o, it, wh, d, q, p_unit, src, sid);
end $$;

-- issue stock at the current average; returns the unit cost used
create or replace function issue_stock(o uuid, it uuid, wh uuid, d date, q numeric, src text, sid uuid) returns numeric
language plpgsql security definer set search_path = public as $$
declare cur numeric; in_wh numeric; allow boolean; nm text;
begin
  if q <= 0 then return 0; end if;
  select avg_cost, name_ar into cur, nm from items where id = it for update;
  select allow_negative_stock into allow from orgs where id = o;
  if not allow then
    select coalesce(sum(qty),0) into in_wh from stock_moves where item_id = it and warehouse_id = wh;
    if in_wh < q then raise exception 'NOT_ENOUGH_STOCK: % (available %)', nm, in_wh; end if;
  end if;
  insert into stock_moves (org_id, item_id, warehouse_id, move_date, qty, unit_cost, source_type, source_id) values (o, it, wh, d, -q, cur, src, sid);
  return cur;
end $$;

create or replace function new_entry(o uuid, d date, memo text, src text, sid uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare je uuid;
begin
  insert into journal_entries (org_id, number, entry_date, memo, source_type, source_id, status, created_by)
  values (o, next_number(o, 'je'), d, memo, src, sid, 'draft', auth.uid()) returning id into je;
  return je;
end $$;
create or replace function jl(je uuid, o uuid, a uuid, dr numeric, cr numeric, p uuid default null, cc uuid default null, m text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if round(coalesce(dr,0)) = 0 and round(coalesce(cr,0)) = 0 then return; end if;
  if a is null then raise exception 'system account missing'; end if;
  insert into journal_lines (entry_id, org_id, account_id, party_id, cost_center_id, debit, credit, memo)
  values (je, o, a, p, cc, round(coalesce(dr,0)), round(coalesce(cr,0)), m);
end $$;
-- net debit/credit so one account gets one line
create or replace function jl_net(je uuid, o uuid, a uuid, amount numeric, p uuid default null, cc uuid default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if amount > 0 then perform jl(je, o, a, amount, 0, p, cc); elsif amount < 0 then perform jl(je, o, a, 0, -amount, p, cc); end if;
end $$;

create or replace function compute_lines(doc uuid, fx numeric default 1) returns void
language sql security definer set search_path = public as $$
  update document_lines set
    line_net = round(qty * unit_price * fx) - discount,
    line_vat = round((round(qty * unit_price * fx) - discount) * vat_rate / 100)
  where document_id = doc;
  update documents set
    subtotal = (select coalesce(sum(line_net),0) from document_lines where document_id = doc),
    vat_total = (select coalesce(sum(line_vat),0) from document_lines where document_id = doc)
  where id = doc;
  update documents set total = subtotal + vat_total where id = doc;
$$;

-- ---------- sales invoice (rewritten: permissions + per-kind stock accounts) ----------
create or replace function post_sales_invoice(doc uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare d documents; je uuid; ln record; s text;
begin
  select * into d from documents where id = doc for update;
  if d.id is null then raise exception 'not allowed'; end if;
  perform require_perm(d.org_id, 'sales', 'post');
  if d.status <> 'draft' then raise exception 'document already posted'; end if;
  if d.kind not in ('tax_invoice','simplified_invoice') then raise exception 'not a sales invoice'; end if;
  if d.kind = 'tax_invoice' and (select vat_number from parties where id = d.party_id) is null then raise exception 'tax invoice needs a customer VAT number'; end if;
  if not exists (select 1 from document_lines where document_id = doc) then raise exception 'NO_LINES: add at least one line'; end if;
  perform compute_lines(doc);
  select * into d from documents where id = doc;
  if d.total <= 0 then raise exception 'NO_LINES: add at least one line'; end if;
  je := new_entry(d.org_id, d.issue_date, 'فاتورة مبيعات', 'document', doc);
  perform jl(je, d.org_id, acct(d.org_id,'ar'), d.total, 0, d.party_id, d.cost_center_id);
  for ln in select coalesce(i.revenue_account_id, acct(d.org_id, case when i.kind = 'service' then 'service_revenue' else 'sales' end)) a, sum(l.line_net) v
            from document_lines l left join items i on i.id = l.item_id where l.document_id = doc group by 1 loop
    perform jl_net(je, d.org_id, ln.a, -ln.v, null, d.cost_center_id);
  end loop;
  perform jl(je, d.org_id, acct(d.org_id,'vat_out'), 0, d.vat_total);
  for ln in select l.id, l.item_id, l.qty, i.kind from document_lines l join items i on i.id = l.item_id
            where l.document_id = doc and i.track_stock loop
    declare c numeric := issue_stock(d.org_id, ln.item_id, d.warehouse_id, d.issue_date, ln.qty, 'sale', doc);
    begin
      update document_lines set unit_cost = c where id = ln.id;
      perform jl(je, d.org_id, acct(d.org_id,'cogs'), ln.qty * c, 0, null, d.cost_center_id);
      perform jl(je, d.org_id, inv_acct(d.org_id, ln.kind), 0, ln.qty * c);
    end;
  end loop;
  update journal_entries set status = 'posted' where id = je;
  s := 'inv:' || d.branch_id;
  update documents set status = 'posted', posted_at = now(), number = fmt_no('INV-', next_number(d.org_id, s)), zatca_status = 'pending' where id = doc;
  return je;
end $$;

-- ---------- credit note (sales return) ----------
create or replace function post_credit_note(doc uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare d documents; inv documents; je uuid; ln record; prior bigint; applied bigint;
begin
  select * into d from documents where id = doc for update;
  if d.id is null then raise exception 'not allowed'; end if;
  perform require_perm(d.org_id, 'sales', 'post');
  if d.status <> 'draft' or d.kind <> 'credit_note' then raise exception 'document already posted'; end if;
  select * into inv from documents where id = d.related_document_id for update;
  if inv.id is null or inv.org_id <> d.org_id or inv.status <> 'posted' or inv.kind not in ('tax_invoice','simplified_invoice') then
    raise exception 'RETURN_NEEDS_SOURCE: choose the posted invoice being returned'; end if;
  if d.party_id is distinct from inv.party_id then raise exception 'RETURN_PARTY: the return must be for the same customer'; end if;
  if not exists (select 1 from document_lines where document_id = doc) then raise exception 'NO_LINES: add at least one line'; end if;
  perform compute_lines(doc);
  select * into d from documents where id = doc;
  select coalesce(sum(total),0) into prior from documents where related_document_id = inv.id and kind = 'credit_note' and status = 'posted';
  if prior + d.total > inv.total then raise exception 'RETURN_TOO_BIG: returns exceed the invoice total'; end if;
  je := new_entry(d.org_id, d.issue_date, 'إشعار دائن (مرتجع مبيعات) على ' || inv.number, 'document', doc);
  for ln in select coalesce(i.revenue_account_id, acct(d.org_id, case when i.kind = 'service' then 'service_revenue' else 'sales' end)) a, sum(l.line_net) v
            from document_lines l left join items i on i.id = l.item_id where l.document_id = doc group by 1 loop
    perform jl_net(je, d.org_id, ln.a, ln.v, null, d.cost_center_id);
  end loop;
  perform jl(je, d.org_id, acct(d.org_id,'vat_out'), d.vat_total, 0);
  perform jl(je, d.org_id, acct(d.org_id,'ar'), 0, d.total, d.party_id, d.cost_center_id);
  for ln in select l.id, l.item_id, l.qty, i.kind, i.avg_cost,
                   (select sum(x.qty * x.unit_cost) / nullif(sum(x.qty),0) from document_lines x where x.document_id = inv.id and x.item_id = l.item_id) orig
            from document_lines l join items i on i.id = l.item_id where l.document_id = doc and i.track_stock loop
    declare c numeric := coalesce(ln.orig, ln.avg_cost);
    begin
      perform receive_stock(d.org_id, ln.item_id, coalesce(d.warehouse_id, inv.warehouse_id), d.issue_date, ln.qty, c, 'return', doc);
      update document_lines set unit_cost = c where id = ln.id;
      perform jl(je, d.org_id, inv_acct(d.org_id, ln.kind), ln.qty * c, 0);
      perform jl(je, d.org_id, acct(d.org_id,'cogs'), 0, ln.qty * c, null, d.cost_center_id);
    end;
  end loop;
  update journal_entries set status = 'posted' where id = je;
  applied := least(d.total, inv.total - inv.amount_paid);
  if applied > 0 then
    update documents set amount_paid = amount_paid + applied, payment_status = case when amount_paid + applied >= total then 'paid' else 'partial' end where id = inv.id;
  end if;
  update documents set status = 'posted', posted_at = now(), number = fmt_no('CN-', next_number(d.org_id, 'cn')), zatca_status = 'pending',
    amount_paid = applied, payment_status = case when applied >= d.total then 'paid' when applied > 0 then 'partial' else 'unpaid' end where id = doc;
  return je;
end $$;

-- ---------- purchase bill (rewritten) ----------
create or replace function post_purchase_bill(doc uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare d documents; je uuid; ln record; landed bigint; stock_base bigint;
begin
  select * into d from documents where id = doc for update;
  if d.id is null then raise exception 'not allowed'; end if;
  perform require_perm(d.org_id, 'purchases', 'post');
  if d.status <> 'draft' or d.kind <> 'purchase_bill' then raise exception 'document already posted'; end if;
  if d.party_id is null then raise exception 'SUPPLIER_REQUIRED: choose the supplier'; end if;
  if not exists (select 1 from document_lines where document_id = doc) then raise exception 'NO_LINES: add at least one line'; end if;
  perform compute_lines(doc, d.fx_rate);
  select * into d from documents where id = doc;
  select coalesce(sum(amount),0) into landed from landed_costs where bill_id = doc;
  select coalesce(sum(l.line_net),0) into stock_base from document_lines l join items i on i.id = l.item_id where l.document_id = doc and i.track_stock;
  if landed > 0 and stock_base = 0 then raise exception 'LANDED_NO_STOCK: shipping costs need at least one stock item line'; end if;
  je := new_entry(d.org_id, d.issue_date, 'فاتورة مشتريات', 'document', doc);
  for ln in select l.id, l.item_id, l.qty, l.line_net, l.account_id, i.kind, coalesce(i.track_stock, false) ts
            from document_lines l left join items i on i.id = l.item_id where l.document_id = doc loop
    if ln.ts then
      declare v_total numeric := ln.line_net + case when stock_base > 0 then landed::numeric * ln.line_net / stock_base else 0 end;
      begin
        perform receive_stock(d.org_id, ln.item_id, d.warehouse_id, d.issue_date, ln.qty, v_total / ln.qty, 'purchase', doc);
        update document_lines set unit_cost = v_total / ln.qty where id = ln.id;
        perform jl(je, d.org_id, inv_acct(d.org_id, ln.kind), v_total, 0, null, d.cost_center_id);
      end;
    else
      perform jl(je, d.org_id, coalesce(ln.account_id, acct(d.org_id, 'other_expense')), ln.line_net, 0, null, d.cost_center_id);
    end if;
  end loop;
  perform jl(je, d.org_id, acct(d.org_id,'vat_in'), d.vat_total, 0);
  perform jl(je, d.org_id, acct(d.org_id,'ap'), 0, d.total, d.party_id);
  perform jl(je, d.org_id, acct(d.org_id,'landed_cost_clearing'), 0, landed);
  update journal_entries set status = 'posted' where id = je;
  update documents set status = 'posted', posted_at = now(), number = fmt_no('PUR-', next_number(d.org_id, 'pur')) where id = doc;
  return je;
end $$;

-- ---------- purchase return (supplier debit note) ----------
create or replace function post_purchase_return(doc uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare d documents; bill documents; je uuid; ln record; prior bigint; applied bigint;
begin
  select * into d from documents where id = doc for update;
  if d.id is null then raise exception 'not allowed'; end if;
  perform require_perm(d.org_id, 'purchases', 'post');
  if d.status <> 'draft' or d.kind <> 'purchase_return' then raise exception 'document already posted'; end if;
  select * into bill from documents where id = d.related_document_id for update;
  if bill.id is null or bill.org_id <> d.org_id or bill.status <> 'posted' or bill.kind <> 'purchase_bill' then
    raise exception 'RETURN_NEEDS_SOURCE: choose the posted invoice being returned'; end if;
  if d.party_id is distinct from bill.party_id then raise exception 'RETURN_PARTY: the return must be for the same customer'; end if;
  if not exists (select 1 from document_lines where document_id = doc) then raise exception 'NO_LINES: add at least one line'; end if;
  perform compute_lines(doc, bill.fx_rate);
  select * into d from documents where id = doc;
  select coalesce(sum(total),0) into prior from documents where related_document_id = bill.id and kind = 'purchase_return' and status = 'posted';
  if prior + d.total > bill.total then raise exception 'RETURN_TOO_BIG: returns exceed the invoice total'; end if;
  je := new_entry(d.org_id, d.issue_date, 'إشعار مدين (مرتجع مشتريات) على ' || bill.number, 'document', doc);
  perform jl(je, d.org_id, acct(d.org_id,'ap'), d.total, 0, d.party_id);
  for ln in select l.id, l.item_id, l.qty, l.line_net, l.account_id, i.kind, coalesce(i.track_stock, false) ts
            from document_lines l left join items i on i.id = l.item_id where l.document_id = doc loop
    if ln.ts then
      declare on_hand numeric; cur numeric; v_unit numeric := ln.line_net::numeric / ln.qty;
      begin
        select coalesce(sum(qty),0) into on_hand from stock_moves where item_id = ln.item_id;
        select avg_cost into cur from items where id = ln.item_id for update;
        update items set avg_cost = case when on_hand - ln.qty > 0 then greatest((on_hand * cur - ln.line_net) / (on_hand - ln.qty), 0) else cur end where id = ln.item_id;
        insert into stock_moves (org_id, item_id, warehouse_id, move_date, qty, unit_cost, source_type, source_id)
        values (d.org_id, ln.item_id, coalesce(d.warehouse_id, bill.warehouse_id), d.issue_date, -ln.qty, v_unit, 'return', doc);
        update document_lines set unit_cost = v_unit where id = ln.id;
        perform jl(je, d.org_id, inv_acct(d.org_id, ln.kind), 0, ln.line_net);
      end;
    else
      perform jl(je, d.org_id, coalesce(ln.account_id, acct(d.org_id, 'other_expense')), 0, ln.line_net);
    end if;
  end loop;
  perform jl(je, d.org_id, acct(d.org_id,'vat_in'), 0, d.vat_total);
  update journal_entries set status = 'posted' where id = je;
  applied := least(d.total, bill.total - bill.amount_paid);
  if applied > 0 then
    update documents set amount_paid = amount_paid + applied, payment_status = case when amount_paid + applied >= total then 'paid' else 'partial' end where id = bill.id;
  end if;
  update documents set status = 'posted', posted_at = now(), number = fmt_no('PRE-', next_number(d.org_id, 'pre')),
    amount_paid = applied, payment_status = case when applied >= d.total then 'paid' when applied > 0 then 'partial' else 'unpaid' end where id = doc;
  return je;
end $$;

-- ---------- quotes / orders: issue (numbered, no journal) & convert ----------
create or replace function issue_document(doc uuid) returns text
language plpgsql security definer set search_path = public as $$
declare d documents; n text;
begin
  select * into d from documents where id = doc for update;
  if d.id is null then raise exception 'not allowed'; end if;
  perform require_perm(d.org_id, doc_module(d.kind), 'create');
  if d.status <> 'draft' or d.kind not in ('quote','sales_order','purchase_order') then raise exception 'document already posted'; end if;
  if not exists (select 1 from document_lines where document_id = doc) then raise exception 'NO_LINES: add at least one line'; end if;
  perform compute_lines(doc, d.fx_rate);
  n := fmt_no(case d.kind when 'quote' then 'QUO-' when 'sales_order' then 'SO-' else 'PO-' end, next_number(d.org_id, d.kind));
  update documents set status = 'posted', posted_at = now(), number = n where id = doc;
  return n;
end $$;

create or replace function convert_document(src uuid, target text) returns uuid
language plpgsql security definer set search_path = public as $$
declare s documents; nid uuid;
begin
  select * into s from documents where id = src;
  if s.id is null then raise exception 'not allowed'; end if;
  if not ((s.kind in ('quote','sales_order') and target in ('tax_invoice','simplified_invoice'))
       or (s.kind = 'purchase_order' and target = 'purchase_bill')
       or (s.kind in ('tax_invoice','simplified_invoice') and target = 'credit_note')
       or (s.kind = 'purchase_bill' and target = 'purchase_return')) then raise exception 'not allowed'; end if;
  perform require_perm(s.org_id, doc_module(target), 'create');
  if s.status <> 'posted' then raise exception 'RETURN_NEEDS_SOURCE: choose the posted invoice being returned'; end if;
  insert into documents (org_id, branch_id, warehouse_id, kind, party_id, related_document_id, cost_center_id, issue_date, due_date, currency, fx_rate, note, created_by)
  values (s.org_id, s.branch_id, s.warehouse_id, target, s.party_id, src, s.cost_center_id, current_date, null, s.currency, s.fx_rate, s.note, auth.uid())
  returning id into nid;
  insert into document_lines (document_id, org_id, line_no, item_id, account_id, description, qty, unit_price, discount, tax_category, vat_rate)
  select nid, org_id, line_no, item_id, account_id, description, qty, unit_price, discount, tax_category, vat_rate from document_lines where document_id = src;
  return nid;
end $$;

-- ---------- vouchers (receipt / payment) with permissions ----------
create or replace function post_payment(p uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare r payments; je uuid; a record; allocated bigint; d documents;
begin
  select * into r from payments where id = p for update;
  if r.id is null then raise exception 'not allowed'; end if;
  perform require_perm(r.org_id, case r.kind when 'receipt' then 'sales' else 'purchases' end, 'post');
  if r.status <> 'draft' then raise exception 'already posted'; end if;
  select coalesce(sum(amount),0) into allocated from payment_allocations where payment_id = p;
  if allocated > r.amount then raise exception 'allocations exceed payment amount'; end if;
  je := new_entry(r.org_id, r.pay_date, case r.kind when 'receipt' then 'سند قبض' else 'سند صرف' end, 'payment', p);
  if r.kind = 'receipt' then
    perform jl(je, r.org_id, r.cash_account_id, r.amount, 0);
    perform jl(je, r.org_id, acct(r.org_id,'ar'), 0, r.amount, r.party_id);
  else
    perform jl(je, r.org_id, acct(r.org_id,'ap'), r.amount, 0, r.party_id);
    perform jl(je, r.org_id, r.cash_account_id, 0, r.amount);
  end if;
  for a in select * from payment_allocations where payment_id = p loop
    select * into d from documents where id = a.document_id for update;
    if d.id is null or d.org_id <> r.org_id or d.status <> 'posted' then raise exception 'invoice not found or not posted'; end if;
    if r.kind = 'receipt' and d.kind not in ('tax_invoice','simplified_invoice','debit_note','progress_bill') then raise exception 'not a sales invoice'; end if;
    if r.kind = 'payment' and d.kind <> 'purchase_bill' then raise exception 'not a purchase bill'; end if;
    if a.amount > d.total - d.amount_paid then raise exception 'amount exceeds what is still open on %', d.number; end if;
    update documents set amount_paid = amount_paid + a.amount, payment_status = case when amount_paid + a.amount >= total then 'paid' else 'partial' end where id = a.document_id;
  end loop;
  update journal_entries set status = 'posted' where id = je;
  update payments set status = 'posted', number = fmt_no(case r.kind when 'receipt' then 'RV-' else 'PV-' end, next_number(r.org_id, case r.kind when 'receipt' then 'rv' else 'pv' end)) where id = p;
  return je;
end $$;

-- ---------- expenses ----------
create or replace function post_expense(e uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare x expenses; je uuid; at text; pt text; pk text;
begin
  select * into x from expenses where id = e for update;
  if x.id is null then raise exception 'not allowed'; end if;
  perform require_perm(x.org_id, 'expenses', 'post');
  if x.status <> 'draft' then raise exception 'already posted'; end if;
  select type into at from accounts where id = x.account_id and org_id = x.org_id and is_postable;
  select type, system_key into pt, pk from accounts where id = x.paid_from_account_id and org_id = x.org_id and is_postable;
  if at not in ('expense','asset') then raise exception 'EXPENSE_ACCOUNT: choose an expense account'; end if;
  if pt not in ('asset','liability','equity') then raise exception 'PAID_FROM: choose the cash, bank, custody or supplier account'; end if;
  if x.vat_amount < 0 then raise exception 'not allowed'; end if;
  je := new_entry(x.org_id, x.expense_date, coalesce(nullif(x.description,''), 'مصروف'), 'expense', e);
  perform jl(je, x.org_id, x.account_id, x.amount, 0, null, x.cost_center_id, x.description);
  perform jl(je, x.org_id, acct(x.org_id,'vat_in'), x.vat_amount, 0);
  perform jl(je, x.org_id, x.paid_from_account_id, 0, x.amount + x.vat_amount,
             case when pk = 'ap' then x.supplier_id when pk = 'custody' then x.employee_id end);
  update journal_entries set status = 'posted' where id = je;
  update expenses set status = 'posted', posted_at = now(), number = fmt_no('EXP-', next_number(x.org_id, 'exp')) where id = e;
  return je;
end $$;

-- ---------- manual journal entry ----------
create or replace function post_manual_entry(p_org uuid, p_date date, p_memo text, p_lines jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare je uuid; l jsonb; dr bigint; cr bigint; n int := 0; td bigint := 0; tc bigint := 0;
begin
  perform require_perm(p_org, 'accounting', 'post');
  if jsonb_typeof(p_lines) <> 'array' then raise exception 'not allowed'; end if;
  je := new_entry(p_org, p_date, coalesce(nullif(trim(p_memo),''), 'قيد يدوي'), 'manual', null);
  for l in select * from jsonb_array_elements(p_lines) loop
    dr := coalesce((l->>'debit')::bigint, 0); cr := coalesce((l->>'credit')::bigint, 0);
    if dr < 0 or cr < 0 or (dr > 0 and cr > 0) then raise exception 'ENTRY_LINE: each line is either debit or credit'; end if;
    if dr = 0 and cr = 0 then continue; end if;
    if not exists (select 1 from accounts where id = (l->>'account_id')::uuid and org_id = p_org and is_postable) then raise exception 'account not found'; end if;
    if l->>'party_id' is not null and not exists (select 1 from parties where id = (l->>'party_id')::uuid and org_id = p_org) then raise exception 'customer not found'; end if;
    if l->>'cost_center_id' is not null and not exists (select 1 from cost_centers where id = (l->>'cost_center_id')::uuid and org_id = p_org) then raise exception 'cost center not found'; end if;
    perform jl(je, p_org, (l->>'account_id')::uuid, dr, cr, (l->>'party_id')::uuid, (l->>'cost_center_id')::uuid, l->>'memo');
    n := n + 1; td := td + dr; tc := tc + cr;
  end loop;
  if n < 2 then raise exception 'ENTRY_LINES: an entry needs at least two lines'; end if;
  if td <> tc then raise exception 'ENTRY_UNBALANCED: debit % ≠ credit %', td, tc; end if;
  update journal_entries set status = 'posted' where id = je;
  return je;
end $$;

create or replace function reverse_entry(e uuid, on_date date default current_date) returns uuid
language plpgsql security definer set search_path = public as $$
declare o journal_entries; je uuid;
begin
  select * into o from journal_entries where id = e;
  if o.id is null then raise exception 'not allowed'; end if;
  perform require_perm(o.org_id, 'accounting', 'post');
  if o.source_type <> 'manual' then raise exception 'REVERSE_MANUAL_ONLY: reverse documents with a credit note or return'; end if;
  if exists (select 1 from journal_entries where reverses_id = e) then raise exception 'already reversed'; end if;
  insert into journal_entries (org_id, number, entry_date, memo, source_type, source_id, reverses_id, status, created_by)
  values (o.org_id, next_number(o.org_id,'je'), on_date, 'عكس القيد رقم ' || o.number, 'reversal', o.source_id, e, 'draft', auth.uid()) returning id into je;
  insert into journal_lines (entry_id, org_id, account_id, cost_center_id, party_id, debit, credit, memo)
  select je, org_id, account_id, cost_center_id, party_id, credit, debit, memo from journal_lines where entry_id = e;
  update journal_entries set status = 'posted' where id = je;
  return je;
end $$;

-- ---------- stock documents: transfer, count, waste, opening ----------
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
        perform jl(je, s.org_id, acct(s.org_id,'waste'), ln.qty * c, 0);
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

-- ---------- manufacturing order ----------
create or replace function post_mfg_order(mo uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare o mfg_orders; prod items; je uuid; ln record; c numeric; mat numeric := 0; wst numeric := 0; ext bigint := 0; tot bigint;
begin
  select * into o from mfg_orders where id = mo for update;
  if o.id is null then raise exception 'not allowed'; end if;
  perform require_perm(o.org_id, 'manufacturing', 'post');
  if o.status <> 'draft' then raise exception 'already posted'; end if;
  select * into prod from items where id = o.item_id;
  if not prod.track_stock then raise exception 'MFG_PRODUCT: the finished product must be a stock item'; end if;
  je := new_entry(o.org_id, o.order_date, 'أمر تصنيع: ' || prod.name_ar, 'stock', mo);
  for ln in select l.*, i.kind ik, i.track_stock ts from mfg_order_lines l join items i on i.id = l.item_id where l.order_id = mo loop
    if ln.item_id = o.item_id then raise exception 'BOM_SELF: a product cannot be its own component'; end if;
    if ln.actual_qty + ln.waste_qty = 0 then continue; end if;
    if not ln.ts then raise exception 'MFG_COMPONENT_STOCK: components must be stock items (use extra costs for services)'; end if;
    c := issue_stock(o.org_id, ln.item_id, o.warehouse_id, o.order_date, ln.actual_qty + ln.waste_qty, 'production', mo);
    update mfg_order_lines set unit_cost = c where id = ln.id;
    mat := mat + ln.actual_qty * c; wst := wst + ln.waste_qty * c;
    perform jl(je, o.org_id, inv_acct(o.org_id, ln.ik), 0, (ln.actual_qty + ln.waste_qty) * c);
  end loop;
  for ln in select * from mfg_order_costs where order_id = mo loop
    perform jl(je, o.org_id, ln.account_id, 0, ln.amount, null, o.cost_center_id, ln.description);
    ext := ext + ln.amount;
  end loop;
  -- total = what was credited (rounded per line), so the entry always balances
  select coalesce(sum(credit),0) into tot from journal_lines where entry_id = je;
  if tot <= 0 then raise exception 'MFG_EMPTY: add components or costs'; end if;
  perform jl(je, o.org_id, inv_acct(o.org_id, prod.kind), tot, 0, null, o.cost_center_id);
  perform receive_stock(o.org_id, o.item_id, o.warehouse_id, o.order_date, o.qty, tot::numeric / o.qty, 'production', mo);
  update journal_entries set status = 'posted' where id = je;
  update mfg_orders set status = 'posted', posted_at = now(), number = fmt_no('MO-', next_number(o.org_id, 'mo')),
    material_cost = round(mat), waste_cost = round(wst), extra_cost = ext, total_cost = tot, unit_cost = tot::numeric / o.qty where id = mo;
  return je;
end $$;

-- ---------- grants ----------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function is_member(uuid), can_write(uuid), has_perm(uuid,text,text), is_owner(uuid), doc_module(text),
  all_modules(), full_permissions(), is_client() to authenticated;
grant execute on function whoami(), accept_invitations(), my_permissions(uuid), save_role(uuid,uuid,text,jsonb), delete_role(uuid),
  invite_member(uuid,text,uuid), revoke_invitation(uuid), list_members(uuid), set_member_role(uuid,uuid,uuid), remove_member(uuid,uuid),
  create_org(text,text,text,text,text,text,text,text,text),
  post_sales_invoice(uuid), post_credit_note(uuid), post_purchase_bill(uuid), post_purchase_return(uuid), issue_document(uuid),
  convert_document(uuid,text), post_payment(uuid), post_expense(uuid), post_manual_entry(uuid,date,text,jsonb), reverse_entry(uuid,date),
  post_stock_doc(uuid), post_mfg_order(uuid) to authenticated;
