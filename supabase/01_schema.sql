-- =====================================================================
-- Schema v1 — accounting system (rebuild of Qoyoodak's features)
-- Target: Supabase (Postgres 15+). Multi-tenant by org_id + RLS.
-- Money: integer halalas (1 SAR = 100). Quantities: numeric(18,4).
-- Times: timestamptz (UTC). Business dates: date (Asia/Riyadh).
-- Rule: posted documents and journal entries are immutable.
--       Corrections = credit/debit note or reversal entry.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- helpers ----------
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

-- ---------- tenancy ----------
create table orgs (
  id uuid primary key default gen_random_uuid(),
  name_ar text not null,
  name_en text,
  vat_number text check (vat_number ~ '^3[0-9]{13}3$'),         -- 15 digits, starts & ends with 3
  cr_number text,
  street text, building_no text, district text, city text, postal_code text,
  sector text not null default 'general',
  logo_path text,                                                -- each company's own logo (Storage) on invoices & app header
  brand_color text check (brand_color ~ '^#[0-9a-fA-F]{6}$'),    -- optional accent per company
  invoice_footer text,
  base_currency char(3) not null default 'SAR',
  fiscal_year_start smallint not null default 1 check (fiscal_year_start between 1 and 12),
  locked_until date,                                             -- period lock: nothing posts on/before this date
  plan text not null default 'trial' check (plan in ('trial','start','growth','pro','enterprise')),
  trial_ends_at timestamptz default now() + interval '14 days',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table members (
  org_id uuid not null references orgs(id) on delete cascade,
  user_id uuid not null,                                         -- auth.users(id) on Supabase
  role text not null check (role in ('owner','admin','accountant','accountant_readonly','sales','cashier','storekeeper','hr')),
  branch_ids uuid[],                                             -- null = all branches
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index on members (user_id);

-- RLS helpers (security definer so policies don't recurse)
create or replace function is_member(o uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where org_id = o and user_id = auth.uid())
$$;
create or replace function can_write(o uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where org_id = o and user_id = auth.uid()
                 and role <> 'accountant_readonly')
$$;

create table branches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  street text, building_no text, city text, postal_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on branches (org_id);

create table warehouses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  branch_id uuid not null references branches(id) on delete restrict,
  name text not null,
  kind text not null default 'general' check (kind in ('general','raw','finished','site')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on warehouses (org_id); create index on warehouses (branch_id);

-- ---------- chart of accounts ----------
create table accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  parent_id uuid references accounts(id) on delete restrict,
  code text not null,
  name_ar text not null,
  name_en text,
  type text not null check (type in ('asset','liability','equity','revenue','expense')),
  is_postable boolean not null default true,                     -- false = group/heading
  system_key text,                                               -- e.g. 'ar','ap','vat_out','vat_in','inventory','cogs','sales','cash','retention_receivable'
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code),
  unique (org_id, system_key)
);
create index on accounts (org_id, parent_id);

create table cost_centers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  code text not null,
  name text not null,
  is_project boolean not null default false,
  contract_value bigint,                                         -- halalas, for projects
  retention_pct numeric(5,2) default 0,
  advance_amount bigint default 0,
  status text not null default 'active' check (status in ('active','closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code)
);

-- ---------- journal ----------
create table journal_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  number bigint not null,
  entry_date date not null,
  memo text,
  source_type text not null check (source_type in ('manual','document','payment','expense','payroll','stock','opening','reversal')),
  source_id uuid,
  reverses_id uuid references journal_entries(id) on delete restrict,
  status text not null default 'posted' check (status in ('draft','posted')),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (org_id, number)
);
create index on journal_entries (org_id, entry_date);
create index on journal_entries (source_type, source_id);

create table journal_lines (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references journal_entries(id) on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  account_id uuid not null references accounts(id) on delete restrict,
  cost_center_id uuid references cost_centers(id) on delete restrict,
  party_id uuid,                                                 -- FK added after parties
  debit bigint not null default 0 check (debit >= 0),
  credit bigint not null default 0 check (credit >= 0),
  memo text,
  constraint one_side check ((debit = 0) <> (credit = 0))
);
create index on journal_lines (entry_id);
create index on journal_lines (org_id, account_id);
create index on journal_lines (cost_center_id);
create index on journal_lines (party_id);

-- every posted entry must balance — checked at commit
create or replace function check_entry_balanced() returns trigger language plpgsql as $$
declare d bigint; c bigint; st text; eid uuid := coalesce(new.entry_id, old.entry_id);
begin
  select status into st from journal_entries where id = eid;
  if st is null or st <> 'posted' then return null; end if;
  select coalesce(sum(debit),0), coalesce(sum(credit),0) into d, c from journal_lines where entry_id = eid;
  if d <> c or d = 0 then
    raise exception 'journal entry % is not balanced (debit %, credit %)', eid, d, c;
  end if;
  return null;
end $$;
create constraint trigger journal_balanced after insert or update or delete on journal_lines
  deferrable initially deferred for each row execute function check_entry_balanced();

-- posted entries are immutable; period lock
create or replace function guard_posted_entry() returns trigger language plpgsql as $$
declare lock date;
begin
  if tg_op in ('UPDATE','DELETE') and old.status = 'posted' then
    raise exception 'posted journal entries cannot be changed — post a reversal';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  select locked_until into lock from orgs where id = new.org_id;
  if lock is not null and new.entry_date <= lock then
    raise exception 'period is locked until %', lock;
  end if;
  return new;
end $$;
create trigger journal_guard before insert or update or delete on journal_entries
  for each row execute function guard_posted_entry();

create or replace function guard_posted_lines() returns trigger language plpgsql as $$
begin
  if tg_op in ('UPDATE','DELETE')
     and exists (select 1 from journal_entries where id = old.entry_id and status = 'posted') then
    raise exception 'lines of a posted entry cannot be changed';
  end if;
  return coalesce(new, old);
end $$;
create trigger journal_lines_guard before update or delete on journal_lines
  for each row execute function guard_posted_lines();

-- ---------- numbering (gap-free, per org + series) ----------
create table counters (
  org_id uuid not null references orgs(id) on delete cascade,
  series text not null,                                          -- 'je', 'inv:<branch>', 'bill', 'rv', 'pv', ...
  last_value bigint not null default 0,
  primary key (org_id, series)
);
create or replace function next_number(o uuid, s text) returns bigint language plpgsql as $$
declare v bigint;
begin
  insert into counters (org_id, series, last_value) values (o, s, 1)
  on conflict (org_id, series) do update set last_value = counters.last_value + 1
  returning last_value into v;
  return v;
end $$;

-- ---------- parties ----------
create table parties (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  kind text not null check (kind in ('customer','supplier','both','employee')),
  name text not null,
  vat_number text,
  cr_number text,
  street text, building_no text, district text, city text, postal_code text,
  country char(2) not null default 'SA',
  phone text, email text,
  credit_limit bigint,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on parties (org_id, kind);
create index on parties (org_id, name);
alter table journal_lines add constraint journal_lines_party_fk
  foreign key (party_id) references parties(id) on delete restrict;

-- ---------- items ----------
create table items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  kind text not null check (kind in ('product','service','raw_material')),
  sku text,
  barcode text,
  name_ar text not null,
  name_en text,
  unit text not null default 'unit',
  sale_price bigint not null default 0,                          -- halalas, before VAT
  price_includes_vat boolean not null default false,
  tax_category text not null default 'S' check (tax_category in ('S','Z','E','O')),  -- ZATCA: standard, zero, exempt, out of scope
  vat_rate numeric(5,2) not null default 15,
  exemption_reason text,                                         -- required by ZATCA for Z/E/O
  track_stock boolean not null default true,
  avg_cost numeric(18,4) not null default 0,                     -- halalas per unit, weighted average
  revenue_account_id uuid references accounts(id) on delete restrict,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, sku),
  unique (org_id, barcode)
);
create index on items (org_id, name_ar);

create table price_lists (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null
);
create table price_list_items (
  price_list_id uuid not null references price_lists(id) on delete cascade,
  item_id uuid not null references items(id) on delete cascade,
  price bigint not null,
  primary key (price_list_id, item_id)
);

-- ---------- documents (all sales & purchase docs share one table) ----------
create table documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  branch_id uuid not null references branches(id) on delete restrict,
  warehouse_id uuid references warehouses(id) on delete restrict,
  kind text not null check (kind in ('tax_invoice','simplified_invoice','credit_note','debit_note',
                                     'quote','sales_order','purchase_bill','purchase_return','progress_bill')),
  number text,                                                   -- assigned on post
  party_id uuid references parties(id) on delete restrict,
  related_document_id uuid references documents(id) on delete restrict,  -- credit note -> invoice
  cost_center_id uuid references cost_centers(id) on delete restrict,
  issue_date date not null default current_date,
  issue_time time not null default (now() at time zone 'Asia/Riyadh')::time,
  due_date date,
  currency char(3) not null default 'SAR',
  fx_rate numeric(18,8) not null default 1,
  subtotal bigint not null default 0,
  discount bigint not null default 0,
  vat_total bigint not null default 0,
  total bigint not null default 0,
  amount_paid bigint not null default 0,
  status text not null default 'draft' check (status in ('draft','posted','void')),
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','partial','paid')),
  note text,
  -- ZATCA
  zatca_uuid uuid not null default gen_random_uuid(),
  zatca_icv bigint,                                              -- invoice counter value per device
  zatca_pih text,                                                -- previous invoice hash
  zatca_hash text,
  zatca_qr text,
  zatca_xml text,
  zatca_status text not null default 'not_sent' check (zatca_status in ('not_sent','pending','cleared','reported','warning','rejected')),
  zatca_device_id uuid,
  zatca_response jsonb,
  -- progress billing
  progress_pct numeric(6,3),
  retention_amount bigint default 0,
  advance_deduction bigint default 0,
  posted_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, kind, number),
  constraint credit_note_needs_invoice check (kind not in ('credit_note','debit_note') or related_document_id is not null),
  constraint paid_not_over check (amount_paid <= total)
);
create index on documents (org_id, kind, issue_date desc);
create index on documents (party_id);
create index on documents (branch_id);
create index on documents (cost_center_id);
create index on documents (org_id, zatca_status) where zatca_status in ('pending','rejected');

create table document_lines (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  line_no int not null,
  item_id uuid references items(id) on delete restrict,
  description text not null,
  qty numeric(18,4) not null check (qty > 0),
  unit_price bigint not null check (unit_price >= 0),            -- halalas, before VAT
  discount bigint not null default 0 check (discount >= 0),
  tax_category text not null check (tax_category in ('S','Z','E','O')),
  vat_rate numeric(5,2) not null,
  line_net bigint not null default 0,                            -- computed server-side on post
  line_vat bigint not null default 0,
  unit_cost numeric(18,4),                                       -- avg cost snapshot at post (sales) / landed cost (purchases)
  unique (document_id, line_no)
);
create index on document_lines (item_id);

create or replace function guard_posted_document() returns trigger language plpgsql as $$
begin
  if old.status = 'posted' then
    -- only payment & ZATCA fields may change after posting
    if new.total <> old.total or new.vat_total <> old.vat_total or new.party_id is distinct from old.party_id
       or new.issue_date <> old.issue_date or new.number is distinct from old.number
       or (new.status <> old.status and new.status <> 'void') then
      raise exception 'posted documents cannot be edited — issue a credit or debit note';
    end if;
  end if;
  return new;
end $$;
create trigger documents_guard before update on documents for each row execute function guard_posted_document();
create trigger documents_updated before update on documents for each row execute function set_updated_at();

-- ---------- payments (receipt & payment vouchers) ----------
create table payments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  branch_id uuid references branches(id) on delete restrict,
  kind text not null check (kind in ('receipt','payment')),
  number text,
  party_id uuid references parties(id) on delete restrict,
  pay_date date not null default current_date,
  amount bigint not null check (amount > 0),
  method text not null check (method in ('cash','card','bank_transfer','cheque')),
  cash_account_id uuid not null references accounts(id) on delete restrict,
  reference text,
  status text not null default 'draft' check (status in ('draft','posted','void')),
  created_at timestamptz not null default now()
);
create index on payments (org_id, pay_date desc);
create index on payments (party_id);

create table payment_allocations (
  payment_id uuid not null references payments(id) on delete cascade,
  document_id uuid not null references documents(id) on delete restrict,
  amount bigint not null check (amount > 0),
  primary key (payment_id, document_id)
);
create index on payment_allocations (document_id);

-- ---------- expenses & custody ----------
create table expenses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  branch_id uuid references branches(id) on delete restrict,
  expense_date date not null default current_date,
  account_id uuid not null references accounts(id) on delete restrict,
  paid_from_account_id uuid not null references accounts(id) on delete restrict,  -- cash/bank or employee custody account
  supplier_id uuid references parties(id) on delete restrict,
  employee_id uuid references parties(id) on delete restrict,
  cost_center_id uuid references cost_centers(id) on delete restrict,
  amount bigint not null check (amount > 0),
  vat_amount bigint not null default 0,
  supplier_vat_number text,                                      -- needed to claim input VAT
  receipt_path text,                                             -- storage path
  description text,
  status text not null default 'draft' check (status in ('draft','posted','void')),
  created_by uuid,
  created_at timestamptz not null default now()
);
create index on expenses (org_id, expense_date desc);
create index on expenses (cost_center_id);

-- ---------- inventory ----------
create table stock_moves (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  item_id uuid not null references items(id) on delete restrict,
  warehouse_id uuid not null references warehouses(id) on delete restrict,
  move_date date not null,
  qty numeric(18,4) not null check (qty <> 0),                   -- + in, - out
  unit_cost numeric(18,4) not null,
  source_type text not null check (source_type in ('sale','purchase','return','transfer','count','waste','opening','production')),
  source_id uuid,
  created_at timestamptz not null default now()
);
create index on stock_moves (org_id, item_id, warehouse_id);
create index on stock_moves (source_type, source_id);

create view stock_balances as
  select org_id, item_id, warehouse_id, sum(qty) as qty
  from stock_moves group by org_id, item_id, warehouse_id;

create table stock_docs (                                        -- transfers, counts, waste
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  kind text not null check (kind in ('transfer','count','waste','opening')),
  number text,
  doc_date date not null default current_date,
  from_warehouse_id uuid references warehouses(id) on delete restrict,
  to_warehouse_id uuid references warehouses(id) on delete restrict,
  status text not null default 'draft' check (status in ('draft','posted')),
  note text,
  created_at timestamptz not null default now(),
  constraint transfer_two_sides check (kind <> 'transfer' or (from_warehouse_id is not null and to_warehouse_id is not null and from_warehouse_id <> to_warehouse_id))
);
create table stock_doc_lines (
  id uuid primary key default gen_random_uuid(),
  stock_doc_id uuid not null references stock_docs(id) on delete cascade,
  item_id uuid not null references items(id) on delete restrict,
  qty numeric(18,4) not null,                                    -- for counts: counted qty
  system_qty numeric(18,4)                                       -- for counts: snapshot
);
create index on stock_doc_lines (stock_doc_id);

create table landed_costs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  bill_id uuid not null references documents(id) on delete restrict,
  description text not null,
  amount bigint not null check (amount > 0),
  allocation text not null default 'value' check (allocation in ('value','qty'))
);

-- ---------- POS ----------
create table pos_registers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  branch_id uuid not null references branches(id) on delete restrict,
  warehouse_id uuid not null references warehouses(id) on delete restrict,
  name text not null,
  zatca_device_id uuid
);
create table pos_shifts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  register_id uuid not null references pos_registers(id) on delete restrict,
  user_id uuid not null,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  opening_cash bigint not null default 0,
  expected_cash bigint, counted_cash bigint, card_total bigint,
  status text not null default 'open' check (status in ('open','closed'))
);
create unique index one_open_shift_per_register on pos_shifts (register_id) where status = 'open';
alter table documents add column pos_shift_id uuid references pos_shifts(id) on delete restrict;
alter table documents add column client_ref text;                -- idempotency key from offline POS
create unique index documents_client_ref on documents (org_id, client_ref) where client_ref is not null;

-- ---------- ZATCA devices (EGS units) ----------
create table zatca_devices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  branch_id uuid not null references branches(id) on delete restrict,
  egs_serial text not null,
  environment text not null default 'sandbox' check (environment in ('sandbox','simulation','production')),
  status text not null default 'new' check (status in ('new','compliance','production','expired','revoked')),
  csr_pem text,
  private_key_ref text,                                          -- pointer to Supabase Vault secret; never the key itself
  compliance_csid text, production_csid text,
  secret_ref text,
  last_icv bigint not null default 0,
  last_hash text not null default 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==',  -- ZATCA initial PIH (base64 of sha256("0"))
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index on zatca_devices (org_id);
alter table documents add constraint documents_zatca_device_fk
  foreign key (zatca_device_id) references zatca_devices(id) on delete restrict;

-- ---------- HR & payroll ----------
create table employees (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  party_id uuid references parties(id) on delete restrict,       -- for custody & payables
  branch_id uuid references branches(id) on delete restrict,
  cost_center_id uuid references cost_centers(id) on delete restrict,
  full_name text not null,
  national_id text,
  is_saudi boolean not null,
  hire_date date not null,
  end_date date,
  basic_salary bigint not null,
  housing_allowance bigint not null default 0,
  transport_allowance bigint not null default 0,
  other_allowances jsonb not null default '{}',
  gosi_enrolled boolean not null default true,
  iban text,
  status text not null default 'active' check (status in ('active','on_leave','terminated')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on employees (org_id, status);

create table payroll_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  period_month date not null,                                    -- first day of month
  status text not null default 'draft' check (status in ('draft','approved','posted')),
  created_at timestamptz not null default now(),
  unique (org_id, period_month)
);
create table payslips (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references payroll_runs(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete restrict,
  gross bigint not null,
  gosi_employee bigint not null default 0,
  gosi_employer bigint not null default 0,
  deductions bigint not null default 0,
  additions bigint not null default 0,
  net bigint not null,
  lines jsonb not null default '[]',
  unique (run_id, employee_id)
);
create table leaves (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  kind text not null check (kind in ('annual','sick','unpaid','other')),
  start_date date not null, end_date date not null,
  check (end_date >= start_date)
);
create index on leaves (employee_id);

-- ---------- reminders, audit, files ----------
create table reminders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  channel text not null check (channel in ('email','whatsapp_link')),
  sent_at timestamptz not null default now()
);
create table audit_log (
  id bigint generated always as identity primary key,
  org_id uuid not null references orgs(id) on delete cascade,
  user_id uuid,
  action text not null,
  table_name text not null,
  row_id uuid,
  diff jsonb,
  at timestamptz not null default now()
);
create index on audit_log (org_id, at desc);

-- =====================================================================
-- Posting: one function per document kind, all in one transaction.
-- The browser NEVER writes journal_entries directly — it calls RPC.
-- =====================================================================
create or replace function acct(o uuid, k text) returns uuid language sql stable as $$
  select id from accounts where org_id = o and system_key = k
$$;

create or replace function post_sales_invoice(doc uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare d documents; je uuid; ln record; cogs numeric := 0; s text;
begin
  select * into d from documents where id = doc for update;
  if d.status <> 'draft' then raise exception 'document already posted'; end if;
  if not can_write(d.org_id) then raise exception 'not allowed'; end if;
  if d.kind not in ('tax_invoice','simplified_invoice') then raise exception 'not a sales invoice'; end if;
  if d.kind = 'tax_invoice' and (select vat_number from parties where id = d.party_id) is null then
    raise exception 'tax invoice needs a customer VAT number';
  end if;

  -- recompute totals server-side (never trust the client)
  update document_lines set
    line_net = round(qty * unit_price) - discount,
    line_vat = round((round(qty * unit_price) - discount) * vat_rate / 100)
  where document_id = doc;
  update documents set
    subtotal = (select coalesce(sum(line_net),0) from document_lines where document_id = doc),
    vat_total = (select coalesce(sum(line_vat),0) from document_lines where document_id = doc)
  where id = doc;
  update documents set total = subtotal + vat_total where id = doc returning * into d;

  s := 'inv:' || d.branch_id;
  insert into journal_entries (org_id, number, entry_date, memo, source_type, source_id, status, created_by)
  values (d.org_id, next_number(d.org_id, 'je'), d.issue_date, 'Sales invoice', 'document', doc, 'draft', auth.uid())
  returning id into je;

  -- Dr receivable (or cash for simplified paid later via receipt) / Cr sales / Cr VAT output
  insert into journal_lines (entry_id, org_id, account_id, party_id, cost_center_id, debit)
  values (je, d.org_id, acct(d.org_id,'ar'), d.party_id, d.cost_center_id, d.total);
  insert into journal_lines (entry_id, org_id, account_id, cost_center_id, credit)
  select je, d.org_id, coalesce(i.revenue_account_id, acct(d.org_id, case when i.kind = 'service' then 'service_revenue' else 'sales' end)), d.cost_center_id, sum(l.line_net)
  from document_lines l left join items i on i.id = l.item_id
  where l.document_id = doc group by 3
  having sum(l.line_net) > 0;
  if d.vat_total > 0 then
    insert into journal_lines (entry_id, org_id, account_id, credit)
    values (je, d.org_id, acct(d.org_id,'vat_out'), d.vat_total);
  end if;

  -- stock out at weighted average cost + COGS
  for ln in select l.id, l.item_id, l.qty, i.avg_cost from document_lines l join items i on i.id = l.item_id
            where l.document_id = doc and i.track_stock loop
    update document_lines set unit_cost = ln.avg_cost where id = ln.id;
    insert into stock_moves (org_id, item_id, warehouse_id, move_date, qty, unit_cost, source_type, source_id)
    values (d.org_id, ln.item_id, d.warehouse_id, d.issue_date, -ln.qty, ln.avg_cost, 'sale', doc);
    cogs := cogs + ln.qty * ln.avg_cost;
  end loop;
  if round(cogs) > 0 then
    insert into journal_lines (entry_id, org_id, account_id, cost_center_id, debit)
    values (je, d.org_id, acct(d.org_id,'cogs'), d.cost_center_id, round(cogs));
    insert into journal_lines (entry_id, org_id, account_id, credit)
    values (je, d.org_id, acct(d.org_id,'inventory'), round(cogs));
  end if;

  update journal_entries set status = 'posted' where id = je;
  update documents set status = 'posted', posted_at = now(),
         number = 'INV-' || lpad(next_number(d.org_id, s)::text, 5, '0'), zatca_status = 'pending'
  where id = doc;
  return je;
end $$;

create or replace function post_purchase_bill(doc uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare d documents; je uuid; ln record; on_hand numeric; landed bigint; base bigint;
begin
  select * into d from documents where id = doc for update;
  if d.status <> 'draft' or d.kind <> 'purchase_bill' then raise exception 'not a draft purchase bill'; end if;
  if not can_write(d.org_id) then raise exception 'not allowed'; end if;

  update document_lines set
    line_net = round(qty * unit_price * d.fx_rate) - discount,
    line_vat = round((round(qty * unit_price * d.fx_rate) - discount) * vat_rate / 100)
  where document_id = doc;
  update documents set
    subtotal = (select coalesce(sum(line_net),0) from document_lines where document_id = doc),
    vat_total = (select coalesce(sum(line_vat),0) from document_lines where document_id = doc)
  where id = doc;
  update documents set total = subtotal + vat_total where id = doc returning * into d;
  select coalesce(sum(amount),0) into landed from landed_costs where bill_id = doc;
  base := d.subtotal;

  insert into journal_entries (org_id, number, entry_date, memo, source_type, source_id, status)
  values (d.org_id, next_number(d.org_id,'je'), d.issue_date, 'Purchase bill', 'document', doc, 'draft')
  returning id into je;

  for ln in select l.id, l.item_id, l.qty, l.line_net, i.track_stock, i.avg_cost
            from document_lines l join items i on i.id = l.item_id where l.document_id = doc loop
    if ln.track_stock then
      -- landed cost allocated by value; weighted average across all warehouses
      declare v_unit numeric := (ln.line_net + case when base > 0 then landed::numeric * ln.line_net / base else 0 end) / ln.qty;
      begin
        select coalesce(sum(qty),0) into on_hand from stock_moves where item_id = ln.item_id;
        update items set avg_cost = case when on_hand + ln.qty > 0 and on_hand > 0
            then (on_hand * avg_cost + ln.qty * v_unit) / (on_hand + ln.qty) else v_unit end
        where id = ln.item_id;
        update document_lines set unit_cost = v_unit where id = ln.id;
        insert into stock_moves (org_id, item_id, warehouse_id, move_date, qty, unit_cost, source_type, source_id)
        values (d.org_id, ln.item_id, d.warehouse_id, d.issue_date, ln.qty, v_unit, 'purchase', doc);
      end;
    end if;
  end loop;

  insert into journal_lines (entry_id, org_id, account_id, cost_center_id, debit)
  values (je, d.org_id, acct(d.org_id,'inventory'), d.cost_center_id, d.subtotal + landed);
  if d.vat_total > 0 then
    insert into journal_lines (entry_id, org_id, account_id, debit) values (je, d.org_id, acct(d.org_id,'vat_in'), d.vat_total);
  end if;
  insert into journal_lines (entry_id, org_id, account_id, party_id, credit)
  values (je, d.org_id, acct(d.org_id,'ap'), d.party_id, d.total);
  if landed > 0 then
    insert into journal_lines (entry_id, org_id, account_id, credit) values (je, d.org_id, acct(d.org_id,'landed_cost_clearing'), landed);
  end if;

  update journal_entries set status = 'posted' where id = je;
  update documents set status = 'posted', posted_at = now(), number = next_number(d.org_id,'bill')::text where id = doc;
  return je;
end $$;

create or replace function post_payment(p uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare r payments; je uuid; a record; allocated bigint;
begin
  select * into r from payments where id = p for update;
  if r.status <> 'draft' then raise exception 'already posted'; end if;
  if not can_write(r.org_id) then raise exception 'not allowed'; end if;
  select coalesce(sum(amount),0) into allocated from payment_allocations where payment_id = p;
  if allocated > r.amount then raise exception 'allocations exceed payment amount'; end if;

  insert into journal_entries (org_id, number, entry_date, memo, source_type, source_id, status)
  values (r.org_id, next_number(r.org_id,'je'), r.pay_date, initcap(r.kind), 'payment', p, 'draft') returning id into je;
  if r.kind = 'receipt' then
    insert into journal_lines (entry_id, org_id, account_id, debit) values (je, r.org_id, r.cash_account_id, r.amount);
    insert into journal_lines (entry_id, org_id, account_id, party_id, credit) values (je, r.org_id, acct(r.org_id,'ar'), r.party_id, r.amount);
  else
    insert into journal_lines (entry_id, org_id, account_id, party_id, debit) values (je, r.org_id, acct(r.org_id,'ap'), r.party_id, r.amount);
    insert into journal_lines (entry_id, org_id, account_id, credit) values (je, r.org_id, r.cash_account_id, r.amount);
  end if;

  for a in select * from payment_allocations where payment_id = p loop
    update documents set amount_paid = amount_paid + a.amount,
      payment_status = case when amount_paid + a.amount >= total then 'paid' else 'partial' end
    where id = a.document_id;
  end loop;

  update journal_entries set status = 'posted' where id = je;
  update payments set status = 'posted', number = case r.kind when 'receipt' then 'RV-' else 'PV-' end || lpad(next_number(r.org_id, case r.kind when 'receipt' then 'rv' else 'pv' end)::text, 5, '0') where id = p;
  return je;
end $$;

create or replace function reverse_entry(e uuid, on_date date default current_date) returns uuid
language plpgsql security definer set search_path = public as $$
declare o journal_entries; je uuid;
begin
  select * into o from journal_entries where id = e;
  if not can_write(o.org_id) then raise exception 'not allowed'; end if;
  insert into journal_entries (org_id, number, entry_date, memo, source_type, source_id, reverses_id, status)
  values (o.org_id, next_number(o.org_id,'je'), on_date, 'Reversal of #' || o.number, 'reversal', o.source_id, e, 'draft') returning id into je;
  insert into journal_lines (entry_id, org_id, account_id, cost_center_id, party_id, debit, credit, memo)
  select je, org_id, account_id, cost_center_id, party_id, credit, debit, memo from journal_lines where entry_id = e;
  update journal_entries set status = 'posted' where id = je;
  return je;
end $$;

-- =====================================================================
-- Sign-up: create a company with branch, warehouse and chart of accounts
-- (chart generated from app/chart.json — our own, SOCPA-style)
-- =====================================================================
create or replace function seed_chart(o uuid) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into accounts (org_id, code, name_ar, name_en, type, is_postable, system_key)
  select o, c, a, e, t, po, k from (values
    ('1',null,'الأصول','Assets','asset',false,null),
    ('11','1','الأصول المتداولة','Current assets','asset',false,null),
    ('1101','11','الصندوق','Cash on hand','asset',true,'cash'),
    ('1102','11','البنك','Bank','asset',true,'bank'),
    ('1103','11','مدفوعات الشبكة تحت التسوية','Card payments clearing','asset',true,'card_clearing'),
    ('1201','11','العملاء','Customers (receivable)','asset',true,'ar'),
    ('1202','11','محتجزات لدى العملاء','Retention receivable','asset',true,'retention_receivable'),
    ('1203','11','عهد الموظفين','Employee custody','asset',true,'custody'),
    ('1204','11','دفعات مقدمة للموردين','Advances to suppliers','asset',true,'supplier_advances'),
    ('1301','11','المخزون','Inventory','asset',true,'inventory'),
    ('1302','11','مخزون المواد الخام','Raw materials','asset',true,'raw_materials'),
    ('1303','11','إنتاج تحت التشغيل','Work in progress','asset',true,'wip'),
    ('1401','11','ضريبة القيمة المضافة — المدخلات','VAT input','asset',true,'vat_in'),
    ('1501','11','مصروفات مدفوعة مقدماً','Prepaid expenses','asset',true,null),
    ('12','1','الأصول الثابتة','Fixed assets','asset',false,null),
    ('1601','12','الآلات والمعدات','Machinery & equipment','asset',true,null),
    ('1602','12','السيارات','Vehicles','asset',true,null),
    ('1603','12','الأثاث والأجهزة','Furniture & IT','asset',true,null),
    ('1690','12','مجمع الإهلاك','Accumulated depreciation','asset',true,'acc_depreciation'),
    ('2',null,'الخصوم','Liabilities','liability',false,null),
    ('21','2','الخصوم المتداولة','Current liabilities','liability',false,null),
    ('2101','21','الموردون','Suppliers (payable)','liability',true,'ap'),
    ('2102','21','دفعات مقدمة من العملاء','Customer advances','liability',true,'customer_advances'),
    ('2201','21','ضريبة القيمة المضافة — المخرجات','VAT output','liability',true,'vat_out'),
    ('2202','21','تسوية ضريبة القيمة المضافة','VAT settlement','liability',true,'vat_settlement'),
    ('2301','21','تكاليف شحن وجمارك مستحقة','Landed costs clearing','liability',true,'landed_cost_clearing'),
    ('2401','21','رواتب مستحقة','Salaries payable','liability',true,'salaries_payable'),
    ('2402','21','التأمينات الاجتماعية المستحقة','GOSI payable','liability',true,'gosi_payable'),
    ('22','2','الخصوم طويلة الأجل','Long-term liabilities','liability',false,null),
    ('2501','22','مخصص مكافأة نهاية الخدمة','End-of-service provision','liability',true,'eosb_provision'),
    ('3',null,'حقوق الملكية','Equity','equity',false,null),
    ('3101','3','رأس المال','Capital','equity',true,'capital'),
    ('3201','3','جاري المالك','Owner''s current account','equity',true,'owner_current'),
    ('3301','3','الأرباح المبقاة','Retained earnings','equity',true,'retained_earnings'),
    ('3401','3','الأرصدة الافتتاحية','Opening balances','equity',true,'opening_balance'),
    ('4',null,'الإيرادات','Revenue','revenue',false,null),
    ('4101','4','المبيعات','Sales','revenue',true,'sales'),
    ('4102','4','إيرادات الخدمات والتركيب','Service & installation revenue','revenue',true,'service_revenue'),
    ('4103','4','مردودات المبيعات','Sales returns','revenue',true,'sales_returns'),
    ('4201','4','إيرادات أخرى','Other income','revenue',true,'other_income'),
    ('5',null,'المصروفات','Expenses','expense',false,null),
    ('51','5','تكلفة المبيعات','Cost of sales','expense',false,null),
    ('5101','51','تكلفة البضاعة المباعة','Cost of goods sold','expense',true,'cogs'),
    ('5102','51','الهالك والتالف','Waste & spoilage','expense',true,'waste'),
    ('5103','51','فروقات الجرد','Stock count variance','expense',true,'stock_variance'),
    ('52','5','المصاريف التشغيلية','Operating expenses','expense',false,null),
    ('5201','52','الرواتب والأجور','Salaries & wages','expense',true,'salaries'),
    ('5202','52','التأمينات الاجتماعية','GOSI expense','expense',true,'gosi_expense'),
    ('5203','52','الإيجار','Rent','expense',true,null),
    ('5204','52','الكهرباء والماء','Utilities','expense',true,null),
    ('5205','52','الوقود والنقل','Fuel & transport','expense',true,null),
    ('5206','52','الصيانة','Maintenance','expense',true,null),
    ('5207','52','الاتصالات والإنترنت','Telecom & internet','expense',true,null),
    ('5208','52','الرسوم الحكومية','Government fees','expense',true,null),
    ('5209','52','المصاريف البنكية','Bank charges','expense',true,'bank_fees'),
    ('5210','52','الإهلاك','Depreciation','expense',true,'depreciation'),
    ('5211','52','مصاريف أخرى','Other expenses','expense',true,'other_expense'),
    ('5301','5','فروقات العملة','FX differences','expense',true,'fx_diff')
  ) v(c, p, a, e, t, po, k);
  -- link parents by code
  update accounts ch set parent_id = pa.id
  from (values
    ('11','1'),('1101','11'),('1102','11'),('1103','11'),('1201','11'),('1202','11'),('1203','11'),('1204','11'),('1301','11'),('1302','11'),('1303','11'),('1401','11'),('1501','11'),('12','1'),('1601','12'),('1602','12'),('1603','12'),('1690','12'),('21','2'),('2101','21'),('2102','21'),('2201','21'),('2202','21'),('2301','21'),('2401','21'),('2402','21'),('22','2'),('2501','22'),('3101','3'),('3201','3'),('3301','3'),('3401','3'),('4101','4'),('4102','4'),('4103','4'),('4201','4'),('51','5'),('5101','51'),('5102','51'),('5103','51'),('52','5'),('5201','52'),('5202','52'),('5203','52'),('5204','52'),('5205','52'),('5206','52'),('5207','52'),('5208','52'),('5209','52'),('5210','52'),('5211','52'),('5301','5')
  ) m(c, p) join accounts pa on pa.org_id = o and pa.code = m.p
  where ch.org_id = o and ch.code = m.c;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function create_org(p_name text, p_vat text default null, p_cr text default null,
  p_city text default null, p_street text default null, p_building text default null, p_postal text default null,
  p_district text default null, p_sector text default 'general') returns uuid
language plpgsql security definer set search_path = public as $$
declare o uuid; b uuid;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  insert into orgs (name_ar, vat_number, cr_number, city, street, building_no, postal_code, district, sector)
  values (p_name, nullif(p_vat,''), nullif(p_cr,''), p_city, p_street, p_building, p_postal, p_district, p_sector) returning id into o;
  insert into members (org_id, user_id, role) values (o, auth.uid(), 'owner');
  insert into branches (org_id, name, city, street, building_no, postal_code) values (o, 'الفرع الرئيسي', p_city, p_street, p_building, p_postal) returning id into b;
  insert into warehouses (org_id, branch_id, name) values (o, b, 'المستودع الرئيسي');
  perform seed_chart(o);
  return o;
end $$;

-- ---------- reports (views; RLS applies through base tables via security_invoker) ----------
create view trial_balance with (security_invoker = true) as
  select l.org_id, a.id as account_id, a.code, a.name_ar, a.type,
         sum(l.debit) as debit, sum(l.credit) as credit, sum(l.debit - l.credit) as balance
  from journal_lines l
  join journal_entries e on e.id = l.entry_id and e.status = 'posted'
  join accounts a on a.id = l.account_id
  group by l.org_id, a.id, a.code, a.name_ar, a.type;

create view ar_aging with (security_invoker = true) as
  select org_id, party_id, id as document_id, number, issue_date, due_date, total - amount_paid as open_amount,
    case when coalesce(due_date, issue_date) >= current_date then 'current'
         when current_date - coalesce(due_date, issue_date) <= 30 then '1-30'
         when current_date - coalesce(due_date, issue_date) <= 60 then '31-60'
         when current_date - coalesce(due_date, issue_date) <= 90 then '61-90'
         else '90+' end as bucket
  from documents
  where kind in ('tax_invoice','simplified_invoice') and status = 'posted' and payment_status <> 'paid';

create view project_profit with (security_invoker = true) as
  select l.org_id, l.cost_center_id,
    sum(case when a.type = 'revenue' then l.credit - l.debit else 0 end) as revenue,
    sum(case when a.type = 'expense' then l.debit - l.credit else 0 end) as cost
  from journal_lines l join accounts a on a.id = l.account_id
  join journal_entries e on e.id = l.entry_id and e.status = 'posted'
  where l.cost_center_id is not null group by l.org_id, l.cost_center_id;

-- =====================================================================
-- Row level security: every table with org_id
-- read = member; write = member that is not read-only.
-- journal_* & stock_moves: read only from the client; writes via RPC above.
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array['branches','warehouses','accounts','cost_centers','parties','items','price_lists',
    'documents','document_lines','payments','expenses','stock_docs','landed_costs','pos_registers','pos_shifts',
    'employees','payroll_runs','leaves','reminders'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for select using (is_member(org_id))', t||'_read', t);
    execute format('create policy %I on %I for insert with check (can_write(org_id))', t||'_ins', t);
    execute format('create policy %I on %I for update using (can_write(org_id)) with check (can_write(org_id))', t||'_upd', t);
    execute format('create policy %I on %I for delete using (can_write(org_id) and %s)', t||'_del', t,
      case when t in ('documents','payments','expenses','stock_docs') then 'status = ''draft''' else 'true' end);
  end loop;
  foreach t in array array['journal_entries','journal_lines','stock_moves','audit_log','counters'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for select using (is_member(org_id))', t||'_read', t);
  end loop;
end $$;

alter table orgs enable row level security;
create policy orgs_read on orgs for select using (is_member(id));
create policy orgs_upd on orgs for update using (exists (select 1 from members where org_id = id and user_id = auth.uid() and role in ('owner','admin')));
alter table members enable row level security;
create policy members_read on members for select using (is_member(org_id));
alter table zatca_devices enable row level security;
create policy zatca_read on zatca_devices for select using (is_member(org_id));   -- writes only from the edge function (service role)
-- child tables without org_id
alter table price_list_items enable row level security;
create policy pli_all on price_list_items for all
  using (exists (select 1 from price_lists p where p.id = price_list_id and is_member(p.org_id)))
  with check (exists (select 1 from price_lists p where p.id = price_list_id and can_write(p.org_id)));
alter table payment_allocations enable row level security;
create policy pa_all on payment_allocations for all
  using (exists (select 1 from payments p where p.id = payment_id and is_member(p.org_id)))
  with check (exists (select 1 from payments p where p.id = payment_id and can_write(p.org_id) and p.status = 'draft'));
alter table stock_doc_lines enable row level security;
create policy sdl_all on stock_doc_lines for all
  using (exists (select 1 from stock_docs s where s.id = stock_doc_id and is_member(s.org_id)))
  with check (exists (select 1 from stock_docs s where s.id = stock_doc_id and can_write(s.org_id) and s.status = 'draft'));
alter table payslips enable row level security;
create policy payslips_read on payslips for select
  using (exists (select 1 from payroll_runs r join members m on m.org_id = r.org_id
                 where r.id = run_id and m.user_id = auth.uid() and m.role in ('owner','admin','hr','accountant','accountant_readonly')));
