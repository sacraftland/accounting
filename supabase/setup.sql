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


-- =====================================================================
-- Migration 02 — what a LIVE Supabase project needs on top of schema v1.
-- Runs after 01_schema.sql. Safe to run once on a fresh project.
--
--  1. members.user_id -> auth.users (deleting a user removes membership)
--  2. stock_balances view respects RLS (was leaking every company's stock)
--  3. Explicit grants: anon gets nothing; signed-in users get tables,
--     but journal / stock / counters / members stay read-only.
--  4. orgs: users may edit profile columns only (not plan, trial, lock).
--  5. Functions: only the public API is callable from the browser.
--  6. Browser writes are drafts only: a client can't insert a "posted"
--     invoice, edit a posted one, set its number/paid amount, or point a
--     line, receipt or allocation at another company's records.
--  7. post_payment validates every allocation (same company, posted,
--     not more than what is still open).
-- =====================================================================

-- 1 ------------------------------------------------------------------
alter table members
  add constraint members_user_fk foreign key (user_id) references auth.users(id) on delete cascade;

-- 2 ------------------------------------------------------------------
alter view stock_balances set (security_invoker = true);

-- 3 ------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke insert, update, delete on journal_entries, journal_lines, stock_moves, audit_log, counters,
  members, zatca_devices, orgs from authenticated;

-- 4 ------------------------------------------------------------------
grant update (name_ar, name_en, vat_number, cr_number, street, building_no, district, city, postal_code,
  sector, logo_path, brand_color, invoice_footer) on orgs to authenticated;

-- 5 ------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function is_member(uuid), can_write(uuid) to authenticated;          -- used by RLS policies
grant execute on function create_org(text,text,text,text,text,text,text,text,text),
  post_sales_invoice(uuid), post_purchase_bill(uuid), post_payment(uuid), reverse_entry(uuid,date)
  to authenticated;
-- future functions are NOT callable by the browser unless granted explicitly
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- 6 ------------------------------------------------------------------
-- These guards only bite for browser roles. The posting functions are
-- SECURITY DEFINER, so inside them current_user is the owner and they pass.
create or replace function is_client() returns boolean language sql stable as $$
  select current_user in ('anon', 'authenticated')
$$;

create or replace function guard_client_document() returns trigger language plpgsql as $$
begin
  if not is_client() then return new; end if;
  if tg_op = 'UPDATE' then
    if old.status <> 'draft' then raise exception 'posted documents cannot be edited — issue a credit or debit note'; end if;
    if new.org_id <> old.org_id then raise exception 'not allowed'; end if;
    new.zatca_uuid := old.zatca_uuid;
    new.created_by := old.created_by;
  else
    new.created_by := auth.uid();
  end if;
  if new.status <> 'draft' then raise exception 'use the posting function to post'; end if;
  -- server-owned fields
  new.number := null; new.amount_paid := 0; new.payment_status := 'unpaid'; new.posted_at := null;
  new.subtotal := 0; new.vat_total := 0; new.total := 0;
  new.zatca_status := 'not_sent'; new.zatca_icv := null; new.zatca_pih := null; new.zatca_hash := null;
  new.zatca_qr := null; new.zatca_xml := null; new.zatca_device_id := null; new.zatca_response := null;
  -- references must be this company's (RLS hides other companies' rows)
  if new.party_id is not null and not exists (select 1 from parties where id = new.party_id and org_id = new.org_id) then
    raise exception 'customer not found'; end if;
  if not exists (select 1 from branches where id = new.branch_id and org_id = new.org_id) then
    raise exception 'branch not found'; end if;
  if new.warehouse_id is not null and not exists (select 1 from warehouses where id = new.warehouse_id and org_id = new.org_id) then
    raise exception 'warehouse not found'; end if;
  if new.related_document_id is not null and not exists (select 1 from documents where id = new.related_document_id and org_id = new.org_id) then
    raise exception 'document not found'; end if;
  return new;
end $$;
create trigger documents_client_guard before insert or update on documents
  for each row execute function guard_client_document();

create or replace function guard_client_doc_line() returns trigger language plpgsql as $$
declare r document_lines := coalesce(new, old);
begin
  if not is_client() then return coalesce(new, old); end if;
  if not exists (select 1 from documents where id = r.document_id and org_id = r.org_id and status = 'draft') then
    raise exception 'lines of a posted document cannot be changed';
  end if;
  if tg_op = 'UPDATE' and (new.document_id <> old.document_id or new.org_id <> old.org_id) then raise exception 'not allowed'; end if;
  if tg_op = 'DELETE' then return old; end if;
  if new.item_id is not null and not exists (select 1 from items where id = new.item_id and org_id = new.org_id) then
    raise exception 'item not found'; end if;
  new.line_net := 0; new.line_vat := 0; new.unit_cost := null;     -- computed on post
  return new;
end $$;
create trigger document_lines_client_guard before insert or update or delete on document_lines
  for each row execute function guard_client_doc_line();

create or replace function guard_client_payment() returns trigger language plpgsql as $$
begin
  if not is_client() then return new; end if;
  if tg_op = 'UPDATE' and (old.status <> 'draft' or new.org_id <> old.org_id) then raise exception 'posted vouchers cannot be edited'; end if;
  if new.status <> 'draft' then raise exception 'use the posting function to post'; end if;
  new.number := null;
  if new.party_id is not null and not exists (select 1 from parties where id = new.party_id and org_id = new.org_id) then
    raise exception 'customer not found'; end if;
  if not exists (select 1 from accounts where id = new.cash_account_id and org_id = new.org_id and type = 'asset' and is_postable) then
    raise exception 'cash or bank account not found'; end if;
  if new.branch_id is not null and not exists (select 1 from branches where id = new.branch_id and org_id = new.org_id) then
    raise exception 'branch not found'; end if;
  return new;
end $$;
create trigger payments_client_guard before insert or update on payments
  for each row execute function guard_client_payment();

create or replace function guard_client_allocation() returns trigger language plpgsql as $$
begin
  if not is_client() then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then
    if exists (select 1 from payments where id = old.payment_id and status <> 'draft') then raise exception 'posted vouchers cannot be edited'; end if;
    return old;
  end if;
  if not exists (select 1 from payments p join documents d on d.org_id = p.org_id
                 where p.id = new.payment_id and d.id = new.document_id) then
    raise exception 'document not found'; end if;
  return new;
end $$;
create trigger allocations_client_guard before insert or update or delete on payment_allocations
  for each row execute function guard_client_allocation();

-- 7 ------------------------------------------------------------------
create or replace function post_payment(p uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare r payments; je uuid; a record; allocated bigint; d documents;
begin
  select * into r from payments where id = p for update;
  if r.id is null then raise exception 'not allowed'; end if;
  if not can_write(r.org_id) then raise exception 'not allowed'; end if;
  if r.status <> 'draft' then raise exception 'already posted'; end if;
  select coalesce(sum(amount),0) into allocated from payment_allocations where payment_id = p;
  if allocated > r.amount then raise exception 'allocations exceed payment amount'; end if;

  insert into journal_entries (org_id, number, entry_date, memo, source_type, source_id, status, created_by)
  values (r.org_id, next_number(r.org_id,'je'), r.pay_date, initcap(r.kind), 'payment', p, 'draft', auth.uid()) returning id into je;
  if r.kind = 'receipt' then
    insert into journal_lines (entry_id, org_id, account_id, debit) values (je, r.org_id, r.cash_account_id, r.amount);
    insert into journal_lines (entry_id, org_id, account_id, party_id, credit) values (je, r.org_id, acct(r.org_id,'ar'), r.party_id, r.amount);
  else
    insert into journal_lines (entry_id, org_id, account_id, party_id, debit) values (je, r.org_id, acct(r.org_id,'ap'), r.party_id, r.amount);
    insert into journal_lines (entry_id, org_id, account_id, credit) values (je, r.org_id, r.cash_account_id, r.amount);
  end if;

  for a in select * from payment_allocations where payment_id = p loop
    select * into d from documents where id = a.document_id for update;
    if d.id is null or d.org_id <> r.org_id or d.status <> 'posted' then raise exception 'invoice not found or not posted'; end if;
    if r.kind = 'receipt' and d.kind not in ('tax_invoice','simplified_invoice','debit_note','progress_bill') then raise exception 'not a sales invoice'; end if;
    if r.kind = 'payment' and d.kind <> 'purchase_bill' then raise exception 'not a purchase bill'; end if;
    if a.amount > d.total - d.amount_paid then raise exception 'amount exceeds what is still open on %', d.number; end if;
    update documents set amount_paid = amount_paid + a.amount,
      payment_status = case when amount_paid + a.amount >= total then 'paid' else 'partial' end
    where id = a.document_id;
  end loop;

  update journal_entries set status = 'posted' where id = je;
  update payments set status = 'posted', number = case r.kind when 'receipt' then 'RV-' else 'PV-' end || lpad(next_number(r.org_id, case r.kind when 'receipt' then 'rv' else 'pv' end)::text, 5, '0') where id = p;
  return je;
end $$;
revoke execute on function post_payment(uuid) from public, anon;
grant execute on function post_payment(uuid) to authenticated;


-- Migration 03 — pin search_path on every non-definer function (Supabase advisor 0011).
alter function public.set_updated_at() set search_path = public;
alter function public.check_entry_balanced() set search_path = public;
alter function public.guard_posted_entry() set search_path = public;
alter function public.guard_posted_lines() set search_path = public;
alter function public.next_number(uuid, text) set search_path = public;
alter function public.guard_posted_document() set search_path = public;
alter function public.acct(uuid, text) set search_path = public;
alter function public.is_client() set search_path = public;
alter function public.guard_client_document() set search_path = public;
alter function public.guard_client_doc_line() set search_path = public;
alter function public.guard_client_payment() set search_path = public;
alter function public.guard_client_allocation() set search_path = public;


-- =====================================================================
-- Migration 04 — invite-only access.
--  * platform_admins: the only emails that may sign up without an invite
--    and create companies (Ali). Later, for SaaS, flip settings.open_signup.
--  * invitations: an owner/admin invites an email with a role. That email
--    may then sign up (password, magic link or Google) and is added to the
--    company automatically on first sign-in (accept_invitations()).
--  * sign-up gate: a trigger on auth.users refuses any other email, so
--    strangers can't create an account at all — by email or by Google.
--  * member management RPCs for owners/admins.
-- =====================================================================

create table platform_admins (email text primary key check (email = lower(email)));
create table platform_settings (id boolean primary key default true check (id), open_signup boolean not null default false);
insert into platform_settings default values;

create table invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  email text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role text not null check (role in ('admin','accountant','accountant_readonly','sales','cashier','storekeeper','hr')),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null
);
create unique index invitations_one_pending on invitations (org_id, email) where accepted_at is null;
create index on invitations (email) where accepted_at is null;

alter table platform_admins enable row level security;     -- no policies: invisible to the browser
alter table platform_settings enable row level security;
alter table invitations enable row level security;
create policy invitations_read on invitations for select using (
  exists (select 1 from members m where m.org_id = invitations.org_id and m.user_id = auth.uid() and m.role in ('owner','admin')));
revoke all on platform_admins, platform_settings from anon, authenticated;
revoke all on invitations from anon;
revoke insert, update, delete on invitations from authenticated;
grant select on invitations to authenticated;

-- ---------- helpers ----------
create or replace function my_email() returns text
language sql stable security definer set search_path = public, auth as $$
  select lower(email) from auth.users where id = auth.uid()
$$;
create or replace function is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from platform_admins where email = my_email())
$$;
create or replace function is_org_admin(o uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where org_id = o and user_id = auth.uid() and role in ('owner','admin'))
$$;

-- ---------- sign-up gate ----------
create or replace function gate_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare e text := lower(new.email);
begin
  if (select open_signup from platform_settings) then return new; end if;
  if e is not null and (exists (select 1 from platform_admins where email = e)
                     or exists (select 1 from invitations where email = e and accepted_at is null)) then
    return new;
  end if;
  raise exception 'NOT_INVITED: this email has not been invited';
end $$;
create trigger gate_new_user before insert on auth.users for each row execute function gate_new_user();

-- ---------- companies: only platform admins create them (until open_signup) ----------
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
  return o;
end $$;

-- ---------- who am I ----------
create or replace function whoami() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('email', my_email(), 'is_platform_admin', is_platform_admin(),
    'pending_invitations', (select count(*) from invitations where email = my_email() and accepted_at is null))
$$;

-- ---------- accept: called by the app right after sign-in ----------
create or replace function accept_invitations() returns int
language plpgsql security definer set search_path = public as $$
declare i record; n int := 0; e text := my_email();
begin
  if auth.uid() is null or e is null then return 0; end if;
  for i in select * from invitations where email = e and accepted_at is null for update loop
    insert into members (org_id, user_id, role) values (i.org_id, auth.uid(), i.role)
      on conflict (org_id, user_id) do nothing;
    update invitations set accepted_at = now(), accepted_by = auth.uid() where id = i.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- owner/admin: invite, revoke, list, change role, remove ----------
create or replace function invite_member(p_org uuid, p_email text, p_role text) returns uuid
language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(p_email)); id uuid; uid uuid;
begin
  if not is_org_admin(p_org) then raise exception 'not allowed'; end if;
  if p_role = 'admin' and not exists (select 1 from members where org_id = p_org and user_id = auth.uid() and role = 'owner') then
    raise exception 'ONLY_OWNER_ADMIN: only the owner can add admins'; end if;
  select u.id into uid from auth.users u where lower(u.email) = e;
  if uid is not null and exists (select 1 from members where org_id = p_org and user_id = uid) then
    raise exception 'ALREADY_MEMBER: already a member'; end if;
  insert into invitations (org_id, email, role, invited_by) values (p_org, e, p_role, auth.uid())
    on conflict (org_id, email) where accepted_at is null do update set role = excluded.role, invited_by = excluded.invited_by, created_at = now()
    returning invitations.id into id;
  return id;
end $$;

create or replace function revoke_invitation(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o uuid;
begin
  select org_id into o from invitations where id = p_id and accepted_at is null;
  if o is null or not is_org_admin(o) then raise exception 'not allowed'; end if;
  delete from invitations where id = p_id;
end $$;

create or replace function list_members(p_org uuid) returns table (user_id uuid, email text, role text, joined_at timestamptz, is_me boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_org_admin(p_org) then raise exception 'not allowed'; end if;
  return query select m.user_id, lower(u.email)::text, m.role, m.created_at, m.user_id = auth.uid()
    from members m join auth.users u on u.id = m.user_id where m.org_id = p_org
    order by (m.role = 'owner') desc, m.created_at;
end $$;

create or replace function set_member_role(p_org uuid, p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
declare cur text; me_owner boolean;
begin
  if not is_org_admin(p_org) then raise exception 'not allowed'; end if;
  if p_role not in ('admin','accountant','accountant_readonly','sales','cashier','storekeeper','hr') then raise exception 'invalid role'; end if;
  select role into cur from members where org_id = p_org and user_id = p_user;
  if cur is null then raise exception 'not a member'; end if;
  if cur = 'owner' then raise exception 'OWNER_PROTECTED: the owner cannot be changed'; end if;
  me_owner := exists (select 1 from members where org_id = p_org and user_id = auth.uid() and role = 'owner');
  if (cur = 'admin' or p_role = 'admin') and not me_owner then raise exception 'ONLY_OWNER_ADMIN: only the owner can add admins'; end if;
  update members set role = p_role where org_id = p_org and user_id = p_user;
end $$;

create or replace function remove_member(p_org uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare cur text;
begin
  if not is_org_admin(p_org) then raise exception 'not allowed'; end if;
  select role into cur from members where org_id = p_org and user_id = p_user;
  if cur is null then raise exception 'not a member'; end if;
  if cur = 'owner' then raise exception 'OWNER_PROTECTED: the owner cannot be removed'; end if;
  if cur = 'admin' and not exists (select 1 from members where org_id = p_org and user_id = auth.uid() and role = 'owner') then
    raise exception 'ONLY_OWNER_ADMIN: only the owner can remove admins'; end if;
  delete from members where org_id = p_org and user_id = p_user;
end $$;

-- ---------- grants ----------
revoke execute on function my_email(), is_platform_admin(), is_org_admin(uuid), gate_new_user(), whoami(), accept_invitations(),
  invite_member(uuid,text,text), revoke_invitation(uuid), list_members(uuid), set_member_role(uuid,uuid,text), remove_member(uuid,uuid),
  create_org(text,text,text,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function whoami(), accept_invitations(), invite_member(uuid,text,text), revoke_invitation(uuid),
  list_members(uuid), set_member_role(uuid,uuid,text), remove_member(uuid,uuid),
  create_org(text,text,text,text,text,text,text,text,text) to authenticated;
-- the auth service inserts users as supabase_auth_admin; the trigger runs as its owner (definer)


-- =====================================================================
-- Migration 05 — flexible, role-based permissions (designed by the owner).
--  * roles: per company, a name + permissions {module: [view|create|post]}
--      view   = see the module's records
--      create = create / edit drafts
--      post   = approve & post (writes the journal)
--    Anyone can get any role, even a workshop worker.
--  * members.role is now 'owner' (everything) or 'member' (uses role_id).
--  * Every RLS policy and every posting function checks has_perm().
--  * A user who manages users can only hand out permissions they hold.
-- Modules: sales, purchases, expenses, inventory, manufacturing,
--          accounting, reports, hr, settings, users
-- =====================================================================

create table roles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  permissions jsonb not null default '{}'::jsonb check (jsonb_typeof(permissions) = 'object'),
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  unique (org_id, name)
);
create index on roles (org_id);

-- members: owner | member(+role_id)
alter table members drop constraint if exists members_role_check;
alter table members add column role_id uuid references roles(id) on delete restrict;
-- invitations: role_id instead of fixed role text
alter table invitations drop constraint if exists invitations_role_check;
alter table invitations alter column role drop not null;
alter table invitations add column role_id uuid references roles(id) on delete cascade;

create or replace function all_modules() returns text[] language sql immutable set search_path = public as $$
  select array['sales','purchases','expenses','inventory','manufacturing','accounting','reports','hr','settings','users']
$$;

create or replace function full_permissions() returns jsonb language sql immutable set search_path = public as $$
  select jsonb_object_agg(m, '["view","create","post"]'::jsonb) from unnest(all_modules()) m
$$;

-- the core check: owner → everything; member → role permissions; view is implied by create/post
create or replace function has_perm(o uuid, module text, action text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from members m left join roles r on r.id = m.role_id
    where m.org_id = o and m.user_id = auth.uid()
      and (m.role = 'owner'
           or (action = 'view' and (r.permissions -> module) ?| array['view','create','post'])
           or (action <> 'view' and (r.permissions -> module) ? action)))
$$;
create or replace function is_owner(o uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where org_id = o and user_id = auth.uid() and role = 'owner')
$$;
-- keep old helper names meaningful for anything still using them
create or replace function is_org_admin(o uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select has_perm(o, 'users', 'create')
$$;
create or replace function can_write(o uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_owner(o) or exists (select 1 from members m join roles r on r.id = m.role_id
    where m.org_id = o and m.user_id = auth.uid()
      and exists (select 1 from jsonb_each(r.permissions) p where p.value ?| array['create','post']))
$$;

-- every permission in p must be held by the current user (no privilege escalation)
create or replace function perms_within_mine(o uuid, p jsonb) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare k text; a text;
begin
  if is_owner(o) then return true; end if;
  for k in select jsonb_object_keys(p) loop
    if not (k = any(all_modules())) then return false; end if;
    for a in select jsonb_array_elements_text(p -> k) loop
      if a not in ('view','create','post') or not has_perm(o, k, a) then return false; end if;
    end loop;
  end loop;
  return true;
end $$;

create or replace function clean_permissions(p jsonb) returns jsonb language sql immutable set search_path = public as $$
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from (
    select k, to_jsonb(array(select distinct a from jsonb_array_elements_text(p -> k) a
                             where a in ('view','create','post') order by a)) v
    from jsonb_object_keys(p) k where k = any(all_modules())) s
  where jsonb_array_length(v) > 0
$$;

-- default roles for a new company (owner can edit or delete the non-system ones)
create or replace function seed_roles(o uuid) returns void
language plpgsql security definer set search_path = public as $$
declare vcp jsonb := '["view","create","post"]'; v jsonb := '["view"]'; vc jsonb := '["view","create"]';
begin
  insert into roles (org_id, name, permissions, is_system) values
   (o, 'مدير عام', full_permissions(), true),
   (o, 'محاسب', jsonb_build_object('sales',vcp,'purchases',vcp,'expenses',vcp,'inventory',vcp,'manufacturing',vcp,'accounting',vcp,'reports',v,'settings',v), false),
   (o, 'محاسب — قراءة فقط', (select jsonb_object_agg(m, v) from unnest(all_modules()) m where m not in ('users')), false),
   (o, 'مندوب مبيعات', jsonb_build_object('sales',vc,'inventory',v), false),
   (o, 'أمين مستودع', jsonb_build_object('inventory',vcp,'purchases',vc,'manufacturing',v), false),
   (o, 'مشرف إنتاج', jsonb_build_object('manufacturing',vcp,'inventory',vc), false),
   (o, 'عامل ورشة', jsonb_build_object('manufacturing',vc,'inventory',v), false)
  on conflict (org_id, name) do nothing;
end $$;

-- migrate existing companies / members / invitations
do $$
declare o record;
begin
  for o in select id from orgs loop perform seed_roles(o.id); end loop;
  update members m set role_id = (select id from roles r where r.org_id = m.org_id and r.name = case m.role
      when 'admin' then 'مدير عام' when 'accountant' then 'محاسب' when 'accountant_readonly' then 'محاسب — قراءة فقط'
      when 'sales' then 'مندوب مبيعات' when 'cashier' then 'مندوب مبيعات' when 'storekeeper' then 'أمين مستودع'
      else 'محاسب — قراءة فقط' end), role = 'member'
    where m.role <> 'owner';
  update invitations i set role_id = (select id from roles r where r.org_id = i.org_id and r.name = case i.role
      when 'admin' then 'مدير عام' when 'accountant' then 'محاسب' when 'accountant_readonly' then 'محاسب — قراءة فقط'
      when 'sales' then 'مندوب مبيعات' when 'cashier' then 'مندوب مبيعات' when 'storekeeper' then 'أمين مستودع'
      else 'محاسب — قراءة فقط' end)
    where i.role_id is null;
end $$;
alter table members add constraint members_role_check check (role in ('owner','member'));
alter table members add constraint members_member_has_role check (role = 'owner' or role_id is not null);

-- ---------- which module owns a row ----------
create or replace function doc_module(kind text) returns text language sql immutable set search_path = public as $$
  select case when kind in ('purchase_bill','purchase_return','purchase_order') then 'purchases' else 'sales' end
$$;

-- ---------- re-do every policy by module ----------
do $$
declare r record;
begin
  for r in select schemaname, tablename, policyname from pg_policies where schemaname = 'public' loop
    execute format('drop policy %I on %I', r.policyname, r.tablename);
  end loop;
end $$;

-- company & membership
create policy orgs_read on orgs for select using (is_member(id));
create policy orgs_upd on orgs for update using (has_perm(id, 'settings', 'create')) with check (has_perm(id, 'settings', 'create'));
create policy members_read on members for select using (user_id = auth.uid() or has_perm(org_id, 'users', 'view'));
create policy roles_read on roles for select using (is_member(org_id));
create policy invitations_read on invitations for select using (has_perm(org_id, 'users', 'view'));
create policy zatca_read on zatca_devices for select using (has_perm(org_id, 'settings', 'view'));
alter table roles enable row level security;

-- shared lists every member needs in forms
create policy branches_read on branches for select using (is_member(org_id));
create policy branches_write on branches for all using (has_perm(org_id, 'settings', 'create')) with check (has_perm(org_id, 'settings', 'create'));
create policy warehouses_read on warehouses for select using (is_member(org_id));
create policy warehouses_write on warehouses for all using (has_perm(org_id, 'inventory', 'create')) with check (has_perm(org_id, 'inventory', 'create'));
create policy accounts_read on accounts for select using (is_member(org_id));
create policy accounts_ins on accounts for insert with check (has_perm(org_id, 'accounting', 'create'));
create policy accounts_upd on accounts for update using (has_perm(org_id, 'accounting', 'create')) with check (has_perm(org_id, 'accounting', 'create'));
create policy accounts_del on accounts for delete using (has_perm(org_id, 'accounting', 'create') and system_key is null);
create policy cost_centers_read on cost_centers for select using (is_member(org_id));
create policy cost_centers_write on cost_centers for all using (has_perm(org_id, 'accounting', 'create') or has_perm(org_id, 'manufacturing', 'create'))
  with check (has_perm(org_id, 'accounting', 'create') or has_perm(org_id, 'manufacturing', 'create'));
create policy parties_read on parties for select using (is_member(org_id));
create policy parties_write on parties for all
  using (has_perm(org_id, 'sales', 'create') or has_perm(org_id, 'purchases', 'create') or has_perm(org_id, 'expenses', 'create'))
  with check (has_perm(org_id, 'sales', 'create') or has_perm(org_id, 'purchases', 'create') or has_perm(org_id, 'expenses', 'create'));
create policy items_read on items for select using (is_member(org_id));
create policy items_write on items for all
  using (has_perm(org_id, 'inventory', 'create') or has_perm(org_id, 'purchases', 'create') or has_perm(org_id, 'sales', 'create') or has_perm(org_id, 'manufacturing', 'create'))
  with check (has_perm(org_id, 'inventory', 'create') or has_perm(org_id, 'purchases', 'create') or has_perm(org_id, 'sales', 'create') or has_perm(org_id, 'manufacturing', 'create'));
create policy price_lists_all on price_lists for all using (has_perm(org_id, 'sales', 'view')) with check (has_perm(org_id, 'sales', 'create'));
create policy pli_all on price_list_items for all
  using (exists (select 1 from price_lists p where p.id = price_list_id and has_perm(p.org_id, 'sales', 'view')))
  with check (exists (select 1 from price_lists p where p.id = price_list_id and has_perm(p.org_id, 'sales', 'create')));

-- documents (sales and purchases share the table)
create policy documents_read on documents for select using (has_perm(org_id, doc_module(kind), 'view'));
create policy documents_ins on documents for insert with check (has_perm(org_id, doc_module(kind), 'create'));
create policy documents_upd on documents for update using (has_perm(org_id, doc_module(kind), 'create')) with check (has_perm(org_id, doc_module(kind), 'create'));
create policy documents_del on documents for delete using (has_perm(org_id, doc_module(kind), 'create') and status = 'draft');
create policy document_lines_read on document_lines for select
  using (exists (select 1 from documents d where d.id = document_id and has_perm(d.org_id, doc_module(d.kind), 'view')));
create policy document_lines_write on document_lines for all
  using (exists (select 1 from documents d where d.id = document_id and has_perm(d.org_id, doc_module(d.kind), 'create')))
  with check (exists (select 1 from documents d where d.id = document_id and d.org_id = document_lines.org_id and has_perm(d.org_id, doc_module(d.kind), 'create')));
create policy landed_costs_all on landed_costs for all using (has_perm(org_id, 'purchases', 'view')) with check (has_perm(org_id, 'purchases', 'create'));

-- vouchers: receipts = sales, payments = purchases
create policy payments_read on payments for select using (has_perm(org_id, case kind when 'receipt' then 'sales' else 'purchases' end, 'view'));
create policy payments_ins on payments for insert with check (has_perm(org_id, case kind when 'receipt' then 'sales' else 'purchases' end, 'create'));
create policy payments_upd on payments for update using (has_perm(org_id, case kind when 'receipt' then 'sales' else 'purchases' end, 'create'))
  with check (has_perm(org_id, case kind when 'receipt' then 'sales' else 'purchases' end, 'create'));
create policy payments_del on payments for delete using (has_perm(org_id, case kind when 'receipt' then 'sales' else 'purchases' end, 'create') and status = 'draft');
create policy pa_all on payment_allocations for all
  using (exists (select 1 from payments p where p.id = payment_id and has_perm(p.org_id, case p.kind when 'receipt' then 'sales' else 'purchases' end, 'view')))
  with check (exists (select 1 from payments p where p.id = payment_id and p.status = 'draft' and has_perm(p.org_id, case p.kind when 'receipt' then 'sales' else 'purchases' end, 'create')));

-- expenses
create policy expenses_read on expenses for select using (has_perm(org_id, 'expenses', 'view'));
create policy expenses_ins on expenses for insert with check (has_perm(org_id, 'expenses', 'create'));
create policy expenses_upd on expenses for update using (has_perm(org_id, 'expenses', 'create')) with check (has_perm(org_id, 'expenses', 'create'));
create policy expenses_del on expenses for delete using (has_perm(org_id, 'expenses', 'create') and status = 'draft');

-- inventory
create policy stock_docs_read on stock_docs for select using (has_perm(org_id, 'inventory', 'view'));
create policy stock_docs_ins on stock_docs for insert with check (has_perm(org_id, 'inventory', 'create'));
create policy stock_docs_upd on stock_docs for update using (has_perm(org_id, 'inventory', 'create')) with check (has_perm(org_id, 'inventory', 'create'));
create policy stock_docs_del on stock_docs for delete using (has_perm(org_id, 'inventory', 'create') and status = 'draft');
create policy sdl_all on stock_doc_lines for all
  using (exists (select 1 from stock_docs s where s.id = stock_doc_id and has_perm(s.org_id, 'inventory', 'view')))
  with check (exists (select 1 from stock_docs s where s.id = stock_doc_id and s.status = 'draft' and has_perm(s.org_id, 'inventory', 'create')));
create policy stock_moves_read on stock_moves for select
  using (has_perm(org_id, 'inventory', 'view') or has_perm(org_id, 'manufacturing', 'view') or has_perm(org_id, 'reports', 'view')
         or has_perm(org_id, 'sales', 'view') or has_perm(org_id, 'purchases', 'view'));

-- accounting & reports
create policy journal_entries_read on journal_entries for select using (has_perm(org_id, 'accounting', 'view') or has_perm(org_id, 'reports', 'view'));
create policy journal_lines_read on journal_lines for select using (has_perm(org_id, 'accounting', 'view') or has_perm(org_id, 'reports', 'view'));
create policy counters_read on counters for select using (is_member(org_id));
create policy audit_log_read on audit_log for select using (has_perm(org_id, 'settings', 'view'));

-- sales extras, HR
create policy pos_registers_all on pos_registers for all using (has_perm(org_id, 'sales', 'view')) with check (has_perm(org_id, 'settings', 'create'));
create policy pos_shifts_all on pos_shifts for all using (has_perm(org_id, 'sales', 'view')) with check (has_perm(org_id, 'sales', 'create'));
create policy reminders_all on reminders for all using (has_perm(org_id, 'sales', 'view')) with check (has_perm(org_id, 'sales', 'create'));
create policy employees_all on employees for all using (has_perm(org_id, 'hr', 'view')) with check (has_perm(org_id, 'hr', 'create'));
create policy payroll_runs_all on payroll_runs for all using (has_perm(org_id, 'hr', 'view')) with check (has_perm(org_id, 'hr', 'create'));
create policy leaves_all on leaves for all using (has_perm(org_id, 'hr', 'view')) with check (has_perm(org_id, 'hr', 'create'));
create policy payslips_read on payslips for select using (exists (select 1 from payroll_runs r where r.id = run_id and has_perm(r.org_id, 'hr', 'view')));

-- roles are changed only through the RPCs below
revoke insert, update, delete on roles from authenticated;
grant select on roles to authenticated;

-- ---------- company creation seeds the default roles ----------
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
  return o;
end $$;

-- ---------- my permissions (for the screens) ----------
create or replace function my_permissions(p_org uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when m.role = 'owner' then full_permissions() || '{"_owner": true}'::jsonb
              else coalesce(r.permissions, '{}'::jsonb) || jsonb_build_object('_role', r.name) end
  from members m left join roles r on r.id = m.role_id
  where m.org_id = p_org and m.user_id = auth.uid()
$$;

-- ---------- roles ----------
create or replace function save_role(p_org uuid, p_id uuid, p_name text, p_permissions jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare clean jsonb := clean_permissions(coalesce(p_permissions, '{}')); rid uuid; sys boolean;
begin
  if not has_perm(p_org, 'users', 'create') then raise exception 'not allowed'; end if;
  if not perms_within_mine(p_org, clean) then raise exception 'PERM_ESCALATION: you cannot grant permissions you do not have'; end if;
  if p_id is null then
    insert into roles (org_id, name, permissions) values (p_org, trim(p_name), clean) returning id into rid;
  else
    select is_system into sys from roles where id = p_id and org_id = p_org;
    if sys is null then raise exception 'role not found'; end if;
    if sys and not is_owner(p_org) then raise exception 'SYSTEM_ROLE: only the owner can change this role'; end if;
    -- editing a role changes everyone who holds it: the editor must hold its current permissions too
    if not perms_within_mine(p_org, (select permissions from roles where id = p_id)) then raise exception 'PERM_ESCALATION: you cannot grant permissions you do not have'; end if;
    update roles set name = trim(p_name), permissions = clean where id = p_id returning id into rid;
  end if;
  return rid;
end $$;

create or replace function delete_role(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o uuid; sys boolean;
begin
  select org_id, is_system into o, sys from roles where id = p_id;
  if o is null or not has_perm(o, 'users', 'create') then raise exception 'not allowed'; end if;
  if sys then raise exception 'SYSTEM_ROLE: this role cannot be deleted'; end if;
  if exists (select 1 from members where role_id = p_id) then raise exception 'ROLE_IN_USE: move its members to another role first'; end if;
  delete from roles where id = p_id;
end $$;

-- ---------- members & invitations (role_id) ----------
drop function if exists invite_member(uuid, text, text);
drop function if exists set_member_role(uuid, uuid, text);
drop function if exists list_members(uuid);

create or replace function invite_member(p_org uuid, p_email text, p_role_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(p_email)); v_id uuid; uid uuid; rp jsonb;
begin
  if not has_perm(p_org, 'users', 'create') then raise exception 'not allowed'; end if;
  select permissions into rp from roles where id = p_role_id and org_id = p_org;
  if rp is null then raise exception 'role not found'; end if;
  if not perms_within_mine(p_org, rp) then raise exception 'PERM_ESCALATION: you cannot grant permissions you do not have'; end if;
  select u.id into uid from auth.users u where lower(u.email) = e;
  if uid is not null and exists (select 1 from members where org_id = p_org and user_id = uid) then
    raise exception 'ALREADY_MEMBER: already a member'; end if;
  insert into invitations (org_id, email, role_id, invited_by) values (p_org, e, p_role_id, auth.uid())
    on conflict (org_id, email) where accepted_at is null do update set role_id = excluded.role_id, invited_by = excluded.invited_by, created_at = now()
    returning invitations.id into v_id;
  return v_id;
end $$;

create or replace function accept_invitations() returns int
language plpgsql security definer set search_path = public as $$
declare i record; n int := 0; e text := my_email();
begin
  if auth.uid() is null or e is null then return 0; end if;
  for i in select * from invitations where email = e and accepted_at is null and role_id is not null for update loop
    insert into members (org_id, user_id, role, role_id) values (i.org_id, auth.uid(), 'member', i.role_id)
      on conflict (org_id, user_id) do nothing;
    update invitations set accepted_at = now(), accepted_by = auth.uid() where id = i.id;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function revoke_invitation(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o uuid;
begin
  select org_id into o from invitations where id = p_id and accepted_at is null;
  if o is null or not has_perm(o, 'users', 'create') then raise exception 'not allowed'; end if;
  delete from invitations where id = p_id;
end $$;

create or replace function list_members(p_org uuid) returns table (user_id uuid, email text, role text, role_id uuid, role_name text, joined_at timestamptz, is_me boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not has_perm(p_org, 'users', 'view') then raise exception 'not allowed'; end if;
  return query select m.user_id, lower(u.email)::text, m.role, m.role_id, coalesce(r.name, 'المالك'), m.created_at, m.user_id = auth.uid()
    from members m join auth.users u on u.id = m.user_id left join roles r on r.id = m.role_id
    where m.org_id = p_org order by (m.role = 'owner') desc, m.created_at;
end $$;

create or replace function set_member_role(p_org uuid, p_user uuid, p_role_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare cur text; cur_role uuid; rp jsonb;
begin
  if not has_perm(p_org, 'users', 'create') then raise exception 'not allowed'; end if;
  select role, role_id into cur, cur_role from members where org_id = p_org and user_id = p_user;
  if cur is null then raise exception 'not a member'; end if;
  if cur = 'owner' then raise exception 'OWNER_PROTECTED: the owner cannot be changed'; end if;
  if p_user = auth.uid() then raise exception 'SELF_ROLE: you cannot change your own role'; end if;
  select permissions into rp from roles where id = p_role_id and org_id = p_org;
  if rp is null then raise exception 'role not found'; end if;
  if not perms_within_mine(p_org, rp) or not perms_within_mine(p_org, (select permissions from roles where id = cur_role)) then
    raise exception 'PERM_ESCALATION: you cannot grant permissions you do not have'; end if;
  update members set role_id = p_role_id where org_id = p_org and user_id = p_user;
end $$;

create or replace function remove_member(p_org uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare cur text; cur_role uuid;
begin
  if not has_perm(p_org, 'users', 'create') then raise exception 'not allowed'; end if;
  select role, role_id into cur, cur_role from members where org_id = p_org and user_id = p_user;
  if cur is null then raise exception 'not a member'; end if;
  if cur = 'owner' then raise exception 'OWNER_PROTECTED: the owner cannot be removed'; end if;
  if not perms_within_mine(p_org, (select permissions from roles where id = cur_role)) then
    raise exception 'PERM_ESCALATION: you cannot remove someone with more permissions than you'; end if;
  delete from members where org_id = p_org and user_id = p_user;
end $$;

-- ---------- grants ----------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function is_member(uuid), can_write(uuid), has_perm(uuid,text,text), is_owner(uuid), doc_module(text),
  all_modules(), full_permissions(), is_client() to authenticated;
grant execute on function whoami(), accept_invitations(), my_permissions(uuid), save_role(uuid,uuid,text,jsonb), delete_role(uuid),
  invite_member(uuid,text,uuid), revoke_invitation(uuid), list_members(uuid), set_member_role(uuid,uuid,uuid), remove_member(uuid,uuid),
  create_org(text,text,text,text,text,text,text,text,text) to authenticated;


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


-- =====================================================================
-- Migration 09 — extended modules (Qoyoodak parity, waves 1–3)
--  Accounting: account statement / general ledger, fixed assets & monthly
--   depreciation & disposal, custody issue/return, card-network settlement,
--   delivery notes, budgets.
--  CRM & work: leads, tasks, commitments & renewals, calendar notes.
--  HR: leave requests & approvals with annual balances, attendance,
--   performance evaluations.
-- =====================================================================

-- ---------- delivery notes (no stock, no accounting; convert to invoice) ----------
alter table documents drop constraint documents_kind_check;
alter table documents add constraint documents_kind_check check (kind in ('tax_invoice','simplified_invoice','credit_note','debit_note',
  'quote','sales_order','purchase_bill','purchase_return','purchase_order','progress_bill','delivery_note'));

create or replace function guard_client_document() returns trigger language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  if tg_op = 'UPDATE' then
    if old.status <> 'draft' then raise exception 'posted documents cannot be edited — issue a credit or debit note'; end if;
    if new.org_id <> old.org_id or new.kind <> old.kind then raise exception 'not allowed'; end if;
    new.zatca_uuid := old.zatca_uuid; new.created_by := old.created_by;
  else
    new.created_by := auth.uid();
    if new.kind not in ('tax_invoice','simplified_invoice','credit_note','quote','sales_order','purchase_bill','purchase_return','purchase_order','delivery_note') then
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

create or replace function issue_document(doc uuid) returns text
language plpgsql security definer set search_path = public as $$
declare d documents; n text;
begin
  select * into d from documents where id = doc for update;
  if d.id is null then raise exception 'not allowed'; end if;
  perform require_perm(d.org_id, doc_module(d.kind), 'create');
  if d.status <> 'draft' or d.kind not in ('quote','sales_order','purchase_order','delivery_note') then raise exception 'document already posted'; end if;
  if not exists (select 1 from document_lines where document_id = doc) then raise exception 'NO_LINES: add at least one line'; end if;
  perform compute_lines(doc, d.fx_rate);
  n := fmt_no(case d.kind when 'quote' then 'QUO-' when 'sales_order' then 'SO-' when 'delivery_note' then 'DN-' else 'PO-' end, next_number(d.org_id, d.kind));
  update documents set status = 'posted', posted_at = now(), number = n where id = doc;
  return n;
end $$;

create or replace function convert_document(src uuid, target text) returns uuid
language plpgsql security definer set search_path = public as $$
declare s documents; nid uuid;
begin
  select * into s from documents where id = src;
  if s.id is null then raise exception 'not allowed'; end if;
  if not ((s.kind in ('quote','sales_order','delivery_note') and target in ('tax_invoice','simplified_invoice'))
       or (s.kind in ('quote','sales_order') and target = 'delivery_note')
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

-- ---------- account statement / general ledger ----------
create or replace function account_statement(p_org uuid, p_account uuid, p_from date, p_to date, p_party uuid default null)
returns table (entry_id uuid, entry_no text, entry_date date, memo text, source_type text, source_id uuid, party_name text,
               debit bigint, credit bigint, balance bigint)
language sql stable security invoker set search_path = public as $$
  with base as (
    select e.id, e.number::text number, e.entry_date, coalesce(l.memo, e.memo) memo, e.source_type, e.source_id, p.name pname, l.debit, l.credit, l.id lid, e.created_at
    from journal_lines l join journal_entries e on e.id = l.entry_id and e.status = 'posted'
    left join parties p on p.id = l.party_id
    where l.org_id = p_org and l.account_id = p_account and (p_party is null or l.party_id = p_party)),
  op as (select coalesce(sum(debit - credit), 0)::bigint v from base where entry_date < p_from)
  select null::uuid, null::text, p_from, 'رصيد افتتاحي'::text, 'opening'::text, null::uuid, null::text, 0::bigint, 0::bigint, (select v from op)
  union all
  select * from (
    select id, number, entry_date, memo, source_type, source_id, pname, debit::bigint, credit::bigint,
      ((select v from op) + sum(debit - credit) over (order by entry_date, created_at, lid))::bigint
    from base where entry_date between p_from and p_to order by entry_date, created_at, lid) x
$$;

-- ---------- fixed assets ----------
create table fixed_assets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  code text not null,
  name text not null,
  account_id uuid not null references accounts(id) on delete restrict,
  acquisition_date date not null,
  cost bigint not null check (cost > 0),
  salvage bigint not null default 0 check (salvage >= 0),
  life_months int not null check (life_months between 1 and 600),
  depreciation_start date not null,
  cost_center_id uuid references cost_centers(id) on delete restrict,
  status text not null default 'active' check (status in ('active','disposed')),
  disposed_at date, disposal_entry_id uuid references journal_entries(id),
  notes text,
  created_at timestamptz not null default now(),
  unique (org_id, code),
  check (salvage < cost)
);
create table asset_depreciation (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  asset_id uuid not null references fixed_assets(id) on delete cascade,
  month date not null,
  amount bigint not null,
  entry_id uuid references journal_entries(id),
  unique (asset_id, month)
);
alter table fixed_assets enable row level security;
alter table asset_depreciation enable row level security;
create policy fixed_assets_read on fixed_assets for select using (has_perm(org_id, 'accounting', 'view') or has_perm(org_id, 'reports', 'view'));
create policy fixed_assets_write on fixed_assets for all using (has_perm(org_id, 'accounting', 'create')) with check (has_perm(org_id, 'accounting', 'create'));
create policy asset_dep_read on asset_depreciation for select using (has_perm(org_id, 'accounting', 'view') or has_perm(org_id, 'reports', 'view'));
grant select, insert, update, delete on fixed_assets to authenticated;
grant select on asset_depreciation to authenticated;

create or replace function guard_client_asset() returns trigger language plpgsql set search_path = public as $$
begin
  if not is_client() then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then
    if exists (select 1 from asset_depreciation where asset_id = old.id) then raise exception 'ASSET_HAS_DEPRECIATION: the asset has posted depreciation — dispose of it instead'; end if;
    return old; end if;
  if tg_op = 'UPDATE' then
    if new.org_id <> old.org_id then raise exception 'not allowed'; end if;
    if old.status <> 'active' then raise exception 'ASSET_DISPOSED: this asset was disposed'; end if;
    if exists (select 1 from asset_depreciation where asset_id = old.id)
       and (new.cost <> old.cost or new.salvage <> old.salvage or new.life_months <> old.life_months or new.depreciation_start <> old.depreciation_start) then
      raise exception 'ASSET_HAS_DEPRECIATION: the asset has posted depreciation — dispose of it instead'; end if;
  end if;
  new.status := coalesce(old.status, 'active'); new.disposed_at := old.disposed_at; new.disposal_entry_id := old.disposal_entry_id;
  if tg_op = 'INSERT' then new.status := 'active'; new.disposed_at := null; new.disposal_entry_id := null; end if;
  if not exists (select 1 from accounts where id = new.account_id and org_id = new.org_id and is_postable and type = 'asset') then raise exception 'account not found'; end if;
  if new.cost_center_id is not null and not exists (select 1 from cost_centers where id = new.cost_center_id and org_id = new.org_id) then raise exception 'cost center not found'; end if;
  return new;
end $$;
create trigger fixed_assets_client_guard before insert or update or delete on fixed_assets for each row execute function guard_client_asset();

create or replace function asset_book_value(a fixed_assets) returns bigint language sql stable set search_path = public as $$
  select a.cost - coalesce((select sum(amount) from asset_depreciation where asset_id = a.id), 0)::bigint
$$;

-- straight-line monthly depreciation for every active asset up to p_month (one entry per month)
create or replace function run_depreciation(p_org uuid, p_month date) returns int
language plpgsql security definer set search_path = public as $$
declare m date := date_trunc('month', p_month)::date; a fixed_assets; mon date; amt bigint; done bigint; per numeric; je uuid; n int := 0;
begin
  perform require_perm(p_org, 'accounting', 'post');
  for mon in select generate_series(coalesce((select min(date_trunc('month', depreciation_start)) from fixed_assets where org_id = p_org and status = 'active'), m), m, interval '1 month')::date loop
    je := null;
    for a in select * from fixed_assets where org_id = p_org and status = 'active' and date_trunc('month', depreciation_start) <= mon order by code loop
      if exists (select 1 from asset_depreciation where asset_id = a.id and month = mon) then continue; end if;
      select coalesce(sum(amount),0) into done from asset_depreciation where asset_id = a.id;
      per := (a.cost - a.salvage)::numeric / a.life_months;
      amt := least(round(per), a.cost - a.salvage - done);
      if amt <= 0 then continue; end if;
      if je is null then je := new_entry(p_org, (mon + interval '1 month' - interval '1 day')::date, 'إهلاك الأصول — ' || to_char(mon, 'YYYY-MM'), 'depreciation', null); end if;
      perform jl(je, p_org, acct(p_org, 'depreciation'), amt, 0, null, a.cost_center_id, a.name);
      perform jl(je, p_org, acct(p_org, 'acc_depreciation'), 0, amt, null, null, a.name);
      insert into asset_depreciation (org_id, asset_id, month, amount, entry_id) values (p_org, a.id, mon, amt, je);
      n := n + 1;
    end loop;
    if je is not null then update journal_entries set status = 'posted' where id = je; end if;
  end loop;
  return n;
end $$;

-- disposal / sale: Dr accumulated depreciation, Dr cash (proceeds), Cr asset cost, gain → other income / loss → other expense
create or replace function dispose_asset(p_asset uuid, p_date date, p_proceeds bigint, p_account uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare a fixed_assets; je uuid; dep bigint; gl bigint;
begin
  select * into a from fixed_assets where id = p_asset for update;
  if a.id is null then raise exception 'not allowed'; end if;
  perform require_perm(a.org_id, 'accounting', 'post');
  if a.status <> 'active' then raise exception 'ASSET_DISPOSED: this asset was disposed'; end if;
  if p_proceeds < 0 then raise exception 'not allowed'; end if;
  if p_proceeds > 0 and not exists (select 1 from accounts where id = p_account and org_id = a.org_id and is_postable) then raise exception 'account not found'; end if;
  select coalesce(sum(amount),0) into dep from asset_depreciation where asset_id = a.id;
  gl := p_proceeds - (a.cost - dep);
  je := new_entry(a.org_id, p_date, 'استبعاد أصل: ' || a.name, 'depreciation', a.id);
  perform jl(je, a.org_id, acct(a.org_id, 'acc_depreciation'), dep, 0);
  if p_proceeds > 0 then perform jl(je, a.org_id, p_account, p_proceeds, 0); end if;
  perform jl(je, a.org_id, a.account_id, 0, a.cost);
  if gl > 0 then perform jl(je, a.org_id, acct(a.org_id, 'other_income'), 0, gl);
  elsif gl < 0 then perform jl(je, a.org_id, acct(a.org_id, 'other_expense'), -gl, 0); end if;
  update journal_entries set status = 'posted' where id = je;
  update fixed_assets set status = 'disposed', disposed_at = p_date, disposal_entry_id = je where id = a.id;
  return je;
end $$;

-- ---------- custody (عهد) ----------
create or replace function employee_party(p_emp uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare e employees; pid uuid;
begin
  select * into e from employees where id = p_emp;
  if e.id is null or not (has_perm(e.org_id, 'expenses', 'create') or has_perm(e.org_id, 'hr', 'create') or has_perm(e.org_id, 'accounting', 'create')) then raise exception 'not allowed'; end if;
  if e.party_id is not null then return e.party_id; end if;
  insert into parties (org_id, kind, name, phone) values (e.org_id, 'employee', e.full_name, e.phone) returning id into pid;
  update employees set party_id = pid where id = e.id;
  return pid;
end $$;

-- issue cash custody to an employee, or receive the unspent balance back
create or replace function custody_move(p_org uuid, p_party uuid, p_date date, p_amount bigint, p_cash_account uuid, p_kind text, p_memo text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare je uuid; k text;
begin
  perform require_perm(p_org, 'expenses', 'post');
  if p_amount <= 0 or p_kind not in ('issue','return') then raise exception 'not allowed'; end if;
  if not exists (select 1 from parties where id = p_party and org_id = p_org) then raise exception 'customer not found'; end if;
  select system_key into k from accounts where id = p_cash_account and org_id = p_org and is_postable;
  if k is null or k not in ('cash','bank') then raise exception 'PAID_FROM: choose the cash, bank, custody or supplier account'; end if;
  je := new_entry(p_org, p_date, coalesce(nullif(trim(p_memo),''), case p_kind when 'issue' then 'صرف عهدة' else 'إرجاع عهدة' end), 'manual', null);
  if p_kind = 'issue' then
    perform jl(je, p_org, acct(p_org,'custody'), p_amount, 0, p_party); perform jl(je, p_org, p_cash_account, 0, p_amount);
  else
    perform jl(je, p_org, p_cash_account, p_amount, 0); perform jl(je, p_org, acct(p_org,'custody'), 0, p_amount, p_party);
  end if;
  update journal_entries set status = 'posted', source_type = 'custody' where id = je;
  return je;
end $$;
alter table journal_entries drop constraint if exists journal_entries_source_type_check;
alter table journal_entries add constraint journal_entries_source_type_check check (source_type in
  ('manual','document','payment','expense','payroll','stock','opening','reversal','depreciation','custody','card_settlement'));

create or replace function custody_balances(p_org uuid) returns table (party_id uuid, name text, balance bigint)
language sql stable security invoker set search_path = public as $$
  select p.id, p.name, sum(l.debit - l.credit)::bigint
  from journal_lines l join journal_entries e on e.id = l.entry_id and e.status = 'posted'
  join accounts a on a.id = l.account_id and a.system_key = 'custody'
  join parties p on p.id = l.party_id
  where l.org_id = p_org group by p.id, p.name having sum(l.debit - l.credit) <> 0 order by 3 desc
$$;

-- ---------- card network settlement ----------
create or replace function settle_cards(p_org uuid, p_date date, p_gross bigint, p_fee bigint, p_bank uuid, p_ref text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare je uuid;
begin
  if not (has_perm(p_org, 'sales', 'post') or has_perm(p_org, 'accounting', 'post')) then raise exception 'not allowed'; end if;
  if p_gross <= 0 or p_fee < 0 or p_fee >= p_gross then raise exception 'CARD_AMOUNTS: check the settled amount and the fee'; end if;
  if (select system_key from accounts where id = p_bank and org_id = p_org) is distinct from 'bank' then raise exception 'PAID_FROM: choose the cash, bank, custody or supplier account'; end if;
  je := new_entry(p_org, p_date, 'تسوية مدفوعات الشبكة' || coalesce(' — ' || nullif(trim(p_ref),''), ''), 'manual', null);
  perform jl(je, p_org, p_bank, p_gross - p_fee, 0);
  perform jl(je, p_org, acct(p_org, 'bank_fees'), p_fee, 0);
  perform jl(je, p_org, acct(p_org, 'card_clearing'), 0, p_gross);
  update journal_entries set status = 'posted', source_type = 'card_settlement' where id = je;
  return je;
end $$;

-- ---------- budgets ----------
create table budgets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  year int not null check (year between 2000 and 2100),
  account_id uuid not null references accounts(id) on delete cascade,
  amounts bigint[] not null check (array_length(amounts, 1) = 12),
  unique (org_id, year, account_id)
);
alter table budgets enable row level security;
create policy budgets_read on budgets for select using (has_perm(org_id, 'accounting', 'view') or has_perm(org_id, 'reports', 'view'));
create policy budgets_write on budgets for all using (has_perm(org_id, 'accounting', 'create')) with check (has_perm(org_id, 'accounting', 'create')
  and exists (select 1 from accounts a where a.id = account_id and a.org_id = budgets.org_id));
grant select, insert, update, delete on budgets to authenticated;

-- ---------- CRM: leads ----------
create table leads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  company text, phone text, email text, source text,
  status text not null default 'new' check (status in ('new','contacted','qualified','proposal','won','lost')),
  expected_value bigint check (expected_value is null or expected_value >= 0),
  next_followup date, notes text,
  party_id uuid references parties(id) on delete set null,
  created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table leads enable row level security;
create policy leads_read on leads for select using (has_perm(org_id, 'sales', 'view'));
create policy leads_write on leads for all using (has_perm(org_id, 'sales', 'create')) with check (has_perm(org_id, 'sales', 'create')
  and (party_id is null or exists (select 1 from parties p where p.id = party_id and p.org_id = leads.org_id)));
grant select, insert, update, delete on leads to authenticated;

-- ---------- tasks ----------
create table tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  cost_center_id uuid references cost_centers(id) on delete cascade,
  title text not null check (length(trim(title)) > 0),
  notes text,
  assignee uuid,
  due_date date,
  priority text not null default 'normal' check (priority in ('low','normal','high')),
  status text not null default 'todo' check (status in ('todo','doing','done')),
  created_by uuid, created_at timestamptz not null default now(), done_at timestamptz
);
create index on tasks (org_id, status);
alter table tasks enable row level security;
create policy tasks_read on tasks for select using (is_member(org_id));
create policy tasks_ins on tasks for insert with check (can_write(org_id)
  and (cost_center_id is null or exists (select 1 from cost_centers c where c.id = cost_center_id and c.org_id = tasks.org_id))
  and (assignee is null or exists (select 1 from members m where m.org_id = tasks.org_id and m.user_id = assignee)));
create policy tasks_upd on tasks for update using (can_write(org_id) or assignee = auth.uid())
  with check ((can_write(org_id) or assignee = auth.uid())
  and (cost_center_id is null or exists (select 1 from cost_centers c where c.id = cost_center_id and c.org_id = tasks.org_id))
  and (assignee is null or exists (select 1 from members m where m.org_id = tasks.org_id and m.user_id = assignee)));
create policy tasks_del on tasks for delete using (can_write(org_id));
grant select, insert, update, delete on tasks to authenticated;
create or replace function guard_client_task() returns trigger language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  if tg_op = 'UPDATE' then
    if new.org_id <> old.org_id then raise exception 'not allowed'; end if;
    new.created_by := old.created_by;
    -- an assignee without write rights may only move the status
    if not can_write(new.org_id) and (new.title, new.notes, new.assignee, new.due_date, new.priority, new.cost_center_id)
         is distinct from (old.title, old.notes, old.assignee, old.due_date, old.priority, old.cost_center_id) then raise exception 'not allowed'; end if;
  else new.created_by := auth.uid(); end if;
  new.done_at := case when new.status = 'done' then coalesce(old.done_at, now()) else null end;
  return new;
end $$;
create trigger tasks_client_guard before insert or update on tasks for each row execute function guard_client_task();

-- ---------- commitments & renewals (licences, CR, iqama, insurance, rent…) ----------
create table commitments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  title text not null check (length(trim(title)) > 0),
  kind text not null default 'other' check (kind in ('cr','license','iqama','passport','insurance','rent','subscription','vehicle','contract','other')),
  employee_id uuid references employees(id) on delete cascade,
  ref_number text,
  expiry_date date not null,
  remind_days int not null default 30 check (remind_days between 0 and 365),
  amount bigint check (amount is null or amount >= 0),
  notes text,
  created_at timestamptz not null default now()
);
alter table commitments enable row level security;
create policy commitments_read on commitments for select using (case when employee_id is null then is_member(org_id) else has_perm(org_id, 'hr', 'view') end);
create policy commitments_write on commitments for all
  using (case when employee_id is null then has_perm(org_id, 'settings', 'create') else has_perm(org_id, 'hr', 'create') end)
  with check (case when employee_id is null then has_perm(org_id, 'settings', 'create')
              else has_perm(org_id, 'hr', 'create') and exists (select 1 from employees x where x.id = employee_id and x.org_id = commitments.org_id) end);
grant select, insert, update, delete on commitments to authenticated;

-- ---------- calendar notes ----------
create table calendar_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  user_id uuid not null default auth.uid(),
  note_date date not null,
  title text not null check (length(trim(title)) > 0),
  shared boolean not null default false,
  done boolean not null default false,
  created_at timestamptz not null default now()
);
alter table calendar_notes enable row level security;
create policy notes_read on calendar_notes for select using (is_member(org_id) and (user_id = auth.uid() or shared));
create policy notes_write on calendar_notes for all using (user_id = auth.uid() and is_member(org_id)) with check (user_id = auth.uid() and is_member(org_id));
grant select, insert, update, delete on calendar_notes to authenticated;

-- ---------- HR: leaves with approvals ----------
alter table leaves drop constraint if exists leaves_kind_check;
alter table leaves add constraint leaves_kind_check check (kind in ('annual','sick','unpaid','emergency','hajj','maternity','other'));
alter table leaves add column status text not null default 'pending' check (status in ('pending','approved','rejected')),
  add column days numeric(6,1), add column note text, add column requested_by uuid, add column decided_by uuid,
  add column decided_at timestamptz, add column created_at timestamptz not null default now();
alter table employees add column annual_leave_days int not null default 21 check (annual_leave_days between 0 and 60);
drop policy if exists leaves_all on leaves;
create policy leaves_read on leaves for select using (has_perm(org_id, 'hr', 'view'));
create policy leaves_ins on leaves for insert with check (has_perm(org_id, 'hr', 'create') and exists (select 1 from employees x where x.id = employee_id and x.org_id = leaves.org_id));
create policy leaves_upd on leaves for update using (has_perm(org_id, 'hr', 'create') and status = 'pending')
  with check (has_perm(org_id, 'hr', 'create') and exists (select 1 from employees x where x.id = employee_id and x.org_id = leaves.org_id));
create policy leaves_del on leaves for delete using (has_perm(org_id, 'hr', 'create') and status = 'pending');
grant select, insert, update, delete on leaves to authenticated;
create or replace function guard_client_leave() returns trigger language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  if tg_op = 'UPDATE' and new.org_id <> old.org_id then raise exception 'not allowed'; end if;
  new.status := 'pending'; new.decided_by := null; new.decided_at := null;
  new.requested_by := coalesce(old.requested_by, auth.uid());
  new.days := (new.end_date - new.start_date) + 1;
  return new;
end $$;
create trigger leaves_client_guard before insert or update on leaves for each row execute function guard_client_leave();
create or replace function decide_leave(p_id uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public as $$
declare l leaves;
begin
  select * into l from leaves where id = p_id for update;
  if l.id is null then raise exception 'not allowed'; end if;
  perform require_perm(l.org_id, 'hr', 'post');
  if l.status <> 'pending' then raise exception 'LEAVE_DECIDED: this request was already decided'; end if;
  update leaves set status = case when p_approve then 'approved' else 'rejected' end, decided_by = auth.uid(), decided_at = now() where id = p_id;
end $$;
-- annual balance: entitlement (21 days, 30 after 5 years — Saudi labour law art. 109) minus approved annual days this year
create or replace function leave_balances(p_org uuid, p_year int) returns table (employee_id uuid, full_name text, entitlement int, used numeric, remaining numeric)
language sql stable security invoker set search_path = public as $$
  select e.id, e.full_name,
    case when make_date(p_year, 12, 31) - e.hire_date >= 365 * 5 then greatest(e.annual_leave_days, 30) else e.annual_leave_days end,
    coalesce((select sum(days) from leaves l where l.employee_id = e.id and l.kind = 'annual' and l.status = 'approved' and extract(year from l.start_date) = p_year), 0),
    (case when make_date(p_year, 12, 31) - e.hire_date >= 365 * 5 then greatest(e.annual_leave_days, 30) else e.annual_leave_days end)
      - coalesce((select sum(days) from leaves l where l.employee_id = e.id and l.kind = 'annual' and l.status = 'approved' and extract(year from l.start_date) = p_year), 0)
  from employees e where e.org_id = p_org and e.status <> 'terminated' order by e.full_name
$$;

-- ---------- HR: attendance ----------
create table attendance (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  day date not null,
  check_in time, check_out time,
  status text not null default 'present' check (status in ('present','absent','late','leave','holiday')),
  note text,
  unique (employee_id, day),
  check (check_out is null or check_in is null or check_out >= check_in)
);
alter table attendance enable row level security;
create policy attendance_read on attendance for select using (has_perm(org_id, 'hr', 'view'));
create policy attendance_write on attendance for all using (has_perm(org_id, 'hr', 'create'))
  with check (has_perm(org_id, 'hr', 'create') and exists (select 1 from employees x where x.id = employee_id and x.org_id = attendance.org_id));
grant select, insert, update, delete on attendance to authenticated;

-- ---------- HR: performance evaluations ----------
create table evaluations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  eval_date date not null default current_date,
  kind text not null default 'annual' check (kind in ('annual','probation','quarterly')),
  scores int[] not null check (array_length(scores, 1) = 10 and 0 <= all(scores) and 10 >= all(scores)),
  strengths text, improvements text,
  decision text check (decision in ('continue','promote','raise','extend_probation','warning','terminate')),
  evaluator uuid default auth.uid(),
  created_at timestamptz not null default now()
);
alter table evaluations enable row level security;
create policy evaluations_read on evaluations for select using (has_perm(org_id, 'hr', 'view'));
create policy evaluations_write on evaluations for all using (has_perm(org_id, 'hr', 'create'))
  with check (has_perm(org_id, 'hr', 'create') and exists (select 1 from employees x where x.id = employee_id and x.org_id = evaluations.org_id));
grant select, insert, update, delete on evaluations to authenticated;

-- ---------- grants ----------
revoke execute on function account_statement(uuid,uuid,date,date,uuid), guard_client_asset(), asset_book_value(fixed_assets), run_depreciation(uuid,date),
  dispose_asset(uuid,date,bigint,uuid), employee_party(uuid), custody_move(uuid,uuid,date,bigint,uuid,text,text), custody_balances(uuid),
  settle_cards(uuid,date,bigint,bigint,uuid,text), guard_client_task(), guard_client_leave(), decide_leave(uuid,boolean), leave_balances(uuid,int)
  from public, anon, authenticated;
grant execute on function account_statement(uuid,uuid,date,date,uuid), run_depreciation(uuid,date), dispose_asset(uuid,date,bigint,uuid),
  employee_party(uuid), custody_move(uuid,uuid,date,bigint,uuid,text,text), custody_balances(uuid), settle_cards(uuid,date,bigint,bigint,uuid,text),
  decide_leave(uuid,boolean), leave_balances(uuid,int) to authenticated;

-- ---------- chart of accounts: client-added accounts ----------
create or replace function guard_client_account() returns trigger language plpgsql set search_path = public as $$
begin
  if not is_client() then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then
    if old.system_key is not null then raise exception 'ACCOUNT_SYSTEM: system accounts cannot be deleted'; end if;
    if exists (select 1 from journal_lines where account_id = old.id) then raise exception 'ACCOUNT_USED: the account has entries'; end if;
    if exists (select 1 from accounts where parent_id = old.id) then raise exception 'ACCOUNT_USED: the account has sub-accounts'; end if;
    return old; end if;
  if tg_op = 'UPDATE' then
    if new.org_id <> old.org_id then raise exception 'not allowed'; end if;
    new.system_key := old.system_key; new.type := old.type;
    if old.system_key is not null then new.is_postable := old.is_postable; new.parent_id := old.parent_id; end if;
    if new.is_postable <> old.is_postable and exists (select 1 from journal_lines where account_id = old.id) then raise exception 'ACCOUNT_USED: the account has entries'; end if;
  else
    new.system_key := null;
  end if;
  if new.parent_id is not null then
    if not exists (select 1 from accounts p where p.id = new.parent_id and p.org_id = new.org_id and not p.is_postable) then raise exception 'ACCOUNT_PARENT: choose a group account as parent'; end if;
    if tg_op = 'INSERT' then new.type := (select type from accounts where id = new.parent_id); end if;
  end if;
  return new;
end $$;
drop trigger if exists accounts_client_guard on accounts;
create trigger accounts_client_guard before insert or update or delete on accounts for each row execute function guard_client_account();
revoke execute on function guard_client_account() from public, anon, authenticated;


-- =====================================================================
-- Migration 10 — customer portal links & van sales trips
--  Portal: an unguessable link per customer that opens their invoices,
--   receipts and running balance without signing in (read-only, revocable).
--  Van trips: a van is a warehouse of kind 'van'. A trip loads stock into
--   it (transfer), sells from it (invoices / POS with the van warehouse),
--   returns what is left, and is closed with the cash the driver handed in.
-- =====================================================================

-- ---------- customer portal ----------
create table portal_links (
  token text primary key,
  org_id uuid not null references orgs(id) on delete cascade,
  party_id uuid not null references parties(id) on delete cascade,
  created_by uuid, created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_opened_at timestamptz
);
create unique index portal_links_active on portal_links (party_id) where revoked_at is null;
alter table portal_links enable row level security;
create policy portal_links_read on portal_links for select using (has_perm(org_id, 'sales', 'view'));
revoke all on portal_links from anon, authenticated;
grant select on portal_links to authenticated;

create or replace function create_portal_link(p_party uuid) returns text
language plpgsql security definer set search_path = public as $$
declare p parties; t text;
begin
  select * into p from parties where id = p_party;
  if p.id is null then raise exception 'not allowed'; end if;
  perform require_perm(p.org_id, 'sales', 'create');
  if p.kind not in ('customer','both') then raise exception 'not allowed'; end if;
  select token into t from portal_links where party_id = p_party and revoked_at is null;
  if t is not null then return t; end if;
  t := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into portal_links (token, org_id, party_id, created_by) values (t, p.org_id, p_party, auth.uid());
  return t;
end $$;

create or replace function revoke_portal_link(p_party uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o uuid;
begin
  select org_id into o from parties where id = p_party;
  if o is null then raise exception 'not allowed'; end if;
  perform require_perm(o, 'sales', 'create');
  update portal_links set revoked_at = now() where party_id = p_party and revoked_at is null;
end $$;

-- public read: everything the customer may see, in one call
create or replace function portal_view(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l portal_links; r jsonb;
begin
  if p_token is null or length(p_token) <> 64 then raise exception 'PORTAL_INVALID: this link is invalid or was cancelled'; end if;
  select * into l from portal_links where token = p_token and revoked_at is null;
  if l.token is null then raise exception 'PORTAL_INVALID: this link is invalid or was cancelled'; end if;
  update portal_links set last_opened_at = now() where token = p_token;
  select jsonb_build_object(
    'org', (select jsonb_build_object('name_ar', o.name_ar, 'name_en', o.name_en, 'vat_number', o.vat_number, 'cr_number', o.cr_number, 'city', o.city, 'street', o.street,
              'building_no', o.building_no, 'district', o.district, 'postal_code', o.postal_code, 'logo_path', o.logo_path, 'invoice_footer', o.invoice_footer) from orgs o where o.id = l.org_id),
    'party', (select jsonb_build_object('name', p.name, 'vat_number', p.vat_number, 'city', p.city) from parties p where p.id = l.party_id),
    'documents', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'kind', d.kind, 'number', d.number, 'issue_date', d.issue_date, 'due_date', d.due_date,
              'subtotal', d.subtotal, 'vat_total', d.vat_total, 'total', d.total, 'amount_paid', d.amount_paid, 'payment_status', d.payment_status) order by d.issue_date desc, d.number desc)
              from documents d where d.party_id = l.party_id and d.org_id = l.org_id and d.status = 'posted' and d.kind in ('tax_invoice','simplified_invoice','credit_note','quote','delivery_note')), '[]'),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('number', y.number, 'pay_date', y.pay_date, 'amount', y.amount, 'method', y.method) order by y.pay_date desc)
              from payments y where y.party_id = l.party_id and y.org_id = l.org_id and y.status = 'posted' and y.kind = 'receipt'), '[]'),
    'balance', (select coalesce(sum(jl.debit - jl.credit), 0) from journal_lines jl join journal_entries e on e.id = jl.entry_id and e.status = 'posted'
              join accounts a on a.id = jl.account_id and a.system_key = 'ar' where jl.party_id = l.party_id and jl.org_id = l.org_id)
  ) into r;
  return r;
end $$;

create or replace function portal_document(p_token text, p_doc uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l portal_links; d documents;
begin
  select * into l from portal_links where token = p_token and revoked_at is null;
  if l.token is null then raise exception 'PORTAL_INVALID: this link is invalid or was cancelled'; end if;
  select * into d from documents where id = p_doc and party_id = l.party_id and org_id = l.org_id and status = 'posted'
    and kind in ('tax_invoice','simplified_invoice','credit_note','quote','delivery_note');
  if d.id is null then raise exception 'not allowed'; end if;
  return jsonb_build_object('id', d.id, 'kind', d.kind, 'number', d.number, 'issue_date', d.issue_date, 'issue_time', d.issue_time, 'due_date', d.due_date, 'note', d.note,
    'subtotal', d.subtotal, 'vat_total', d.vat_total, 'total', d.total, 'amount_paid', d.amount_paid, 'zatca_qr', d.zatca_qr,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('description', x.description, 'qty', x.qty, 'unit_price', x.unit_price, 'discount', x.discount,
                'vat_rate', x.vat_rate, 'line_net', x.line_net, 'line_vat', x.line_vat) order by x.line_no) from document_lines x where x.document_id = d.id), '[]'));
end $$;

-- ---------- van sales trips ----------
alter table warehouses drop constraint if exists warehouses_kind_check;
alter table warehouses add constraint warehouses_kind_check check (kind in ('general','raw','finished','site','van'));

create table van_trips (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  number text not null,
  van_warehouse_id uuid not null references warehouses(id) on delete restrict,
  source_warehouse_id uuid not null references warehouses(id) on delete restrict,
  employee_id uuid references employees(id) on delete set null,
  driver_name text,
  trip_date date not null default current_date,
  route text,
  status text not null default 'open' check (status in ('open','closed')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  cash_handed bigint check (cash_handed is null or cash_handed >= 0),
  notes text,
  created_by uuid,
  check (van_warehouse_id <> source_warehouse_id)
);
create unique index van_trips_one_open on van_trips (van_warehouse_id) where status = 'open';
alter table van_trips enable row level security;
create policy van_trips_read on van_trips for select using (has_perm(org_id, 'inventory', 'view') or has_perm(org_id, 'sales', 'view'));
revoke all on van_trips from anon, authenticated;
grant select on van_trips to authenticated;

create or replace function open_trip(p_org uuid, p_van uuid, p_source uuid, p_employee uuid, p_driver text, p_date date, p_route text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare nid uuid;
begin
  perform require_perm(p_org, 'inventory', 'create');
  if not exists (select 1 from warehouses w where w.id = p_van and w.org_id = p_org and w.kind = 'van') then raise exception 'TRIP_VAN: choose a van (vehicle warehouse)'; end if;
  if p_source = p_van or not exists (select 1 from warehouses w where w.id = p_source and org_id = p_org) then raise exception 'warehouse not found'; end if;
  if p_employee is not null and not exists (select 1 from employees x where x.id = p_employee and x.org_id = p_org) then raise exception 'not allowed'; end if;
  if exists (select 1 from van_trips where van_warehouse_id = p_van and status = 'open') then raise exception 'TRIP_OPEN: this van already has an open trip — close it first'; end if;
  insert into van_trips (org_id, number, van_warehouse_id, source_warehouse_id, employee_id, driver_name, trip_date, route, created_by)
  values (p_org, fmt_no('TRP-', next_number(p_org, 'van_trip')), p_van, p_source, p_employee,
          coalesce(nullif(trim(p_driver), ''), (select full_name from employees where id = p_employee)), coalesce(p_date, current_date), nullif(trim(p_route), ''), auth.uid())
  returning van_trips.id into nid;
  return nid;
end $$;

create or replace function close_trip(p_trip uuid, p_cash bigint, p_notes text default null) returns void
language plpgsql security definer set search_path = public as $$
declare t van_trips;
begin
  select * into t from van_trips where id = p_trip for update;
  if t.id is null then raise exception 'not allowed'; end if;
  perform require_perm(t.org_id, 'inventory', 'post');
  if t.status <> 'open' then raise exception 'TRIP_CLOSED: this trip is already closed'; end if;
  if p_cash is not null and p_cash < 0 then raise exception 'not allowed'; end if;
  update van_trips set status = 'closed', closed_at = now(), cash_handed = p_cash, notes = coalesce(nullif(trim(p_notes), ''), notes) where id = p_trip;
end $$;

revoke execute on function create_portal_link(uuid), revoke_portal_link(uuid), portal_view(text), portal_document(text, uuid),
  open_trip(uuid,uuid,uuid,uuid,text,date,text), close_trip(uuid,bigint,text) from public, anon, authenticated;
grant execute on function create_portal_link(uuid), revoke_portal_link(uuid), open_trip(uuid,uuid,uuid,uuid,text,date,text), close_trip(uuid,bigint,text) to authenticated;
grant execute on function portal_view(text), portal_document(text, uuid) to anon, authenticated;


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


-- =====================================================================
-- Migration 13 — printed-invoice design and dashboards per role
--  • orgs.invoice_settings (template, colors, what to show, bank details,
--    terms), plus the company stamp and the signature images
--  • roles.dashboard: the default dashboard for everyone in that role
--    (a user's own customization still wins)
-- =====================================================================
alter table orgs add column invoice_settings jsonb not null default '{}'::jsonb check (jsonb_typeof(invoice_settings) = 'object'),
  add column stamp_path text check (stamp_path is null or length(stamp_path) < 600000),
  add column signature_path text check (signature_path is null or length(signature_path) < 600000);
grant update (invoice_settings, stamp_path, signature_path) on orgs to authenticated;

alter table roles add column dashboard jsonb check (dashboard is null or jsonb_typeof(dashboard) = 'object');

create or replace function set_role_dashboard(p_role uuid, p_dash jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare o uuid;
begin
  select org_id into o from roles where id = p_role;
  if o is null or not has_perm(o, 'users', 'create') then raise exception 'not allowed'; end if;
  if p_dash is not null and (jsonb_typeof(p_dash) <> 'object' or length(p_dash::text) > 4000) then raise exception 'not allowed'; end if;
  update roles set dashboard = p_dash where id = p_role;
end $$;

-- the caller's role default dashboard (null for the owner or when none is set)
create or replace function my_role_dashboard(p_org uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select r.dashboard from members m join roles r on r.id = m.role_id where m.org_id = p_org and m.user_id = auth.uid()
$$;

revoke execute on function set_role_dashboard(uuid, jsonb), my_role_dashboard(uuid) from public, anon;
grant execute on function set_role_dashboard(uuid, jsonb), my_role_dashboard(uuid) to authenticated;


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


-- =====================================================================
-- Migration 15 — full backup & restore, and the custom report builder
--  • permission module "backup" (owner has it automatically)
--  • export_org: one JSON document with every row of the company
--  • import_org: restore a backup as a NEW company, or in place of the
--    current one (the old data is kept as an archive company, owner only)
--  • backup_log: every export / restore, so the app can show when the
--    dedicated backup computer last made a copy
--  • saved_reports + report_dataset: report definitions and the flat
--    datasets they are built from (read with the caller's permissions)
-- =====================================================================
create or replace function all_modules() returns text[] language sql immutable set search_path = public as $$
  select array['sales','purchases','expenses','inventory','manufacturing','accounting','reports','hr','settings','users','feasibility','backup']
$$;

create table backup_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  at timestamptz not null default now(),
  user_id uuid,
  source text not null check (source in ('app','script','restore')),
  tables int not null default 0,
  rows int not null default 0,
  note text
);
create index on backup_log (org_id, at desc);
alter table backup_log enable row level security;
create policy backup_log_read on backup_log for select using (has_perm(org_id, 'backup', 'view'));
revoke all on backup_log from public, anon, authenticated;
grant select on backup_log to authenticated;

-- tables copied company-wide (they all carry org_id); children without org_id come through their parent
create or replace function backup_tables() returns text[] language sql stable set search_path = public as $$
  select coalesce(array_agg(c.relname::text order by c.relname), '{}') from pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
    and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped)
    and c.relname not in ('members','invitations','portal_links','backup_log','orgs')
$$;

create or replace function export_org(p_org uuid, p_source text default 'app') returns jsonb
language plpgsql volatile security definer set search_path = public set statement_timeout = '120s' as $$
declare t text; rows jsonb; out jsonb := '{}'::jsonb; n int := 0; nt int := 0;
begin
  if not has_perm(p_org, 'backup', 'view') then raise exception 'not allowed'; end if;
  if p_source not in ('app','script') then raise exception 'not allowed'; end if;
  foreach t in array backup_tables() loop
    execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]'') from %I x where org_id = $1', t) into rows using p_org;
    out := out || jsonb_build_object(t, rows); n := n + jsonb_array_length(rows); nt := nt + 1;
  end loop;
  out := out || jsonb_build_object(
    'stock_doc_lines', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from stock_doc_lines x join stock_docs d on d.id = x.stock_doc_id where d.org_id = p_org),
    'payment_allocations', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from payment_allocations x join payments d on d.id = x.payment_id where d.org_id = p_org),
    'price_list_items', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from price_list_items x join price_lists d on d.id = x.price_list_id where d.org_id = p_org));
  n := n + jsonb_array_length(out->'stock_doc_lines') + jsonb_array_length(out->'payment_allocations') + jsonb_array_length(out->'price_list_items'); nt := nt + 3;
  insert into backup_log (org_id, user_id, source, tables, rows) values (p_org, auth.uid(), p_source, nt, n);
  return jsonb_build_object('format', 'craftland-backup', 'version', 1, 'exported_at', now(), 'org_id', p_org,
    'org', (select to_jsonb(o) from orgs o where o.id = p_org), 'tables', out, 'counts', (select jsonb_object_agg(k, jsonb_array_length(v)) from jsonb_each(out) e(k, v)));
end $$;

-- insert a table's rows from JSON, using only the columns that exist now (older backups keep working)
create or replace function restore_rows(t text, rows jsonb) returns int language plpgsql set search_path = public as $$
declare cols text;
begin
  if rows is null or jsonb_array_length(rows) = 0 then return 0; end if;
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into cols from pg_attribute a
  where a.attrelid = t::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' and a.attidentity = ''
    and rows->0 ? a.attname;
  execute format('insert into %I (%s) select %s from jsonb_populate_recordset(null::%I, $1)', t, cols, cols, t) using rows;
  return jsonb_array_length(rows);
end $$;

create or replace function import_org(p_data jsonb, p_mode text, p_target uuid default null) returns uuid
language plpgsql volatile security definer set search_path = public set statement_timeout = '300s' as $$
declare o uuid; t text; rows jsonb; n int := 0; fk record; bad boolean; me uuid := auth.uid(); stamp text := to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD HH24:MI');
begin
  if me is null then raise exception 'sign in first'; end if;
  if p_data->>'format' is distinct from 'craftland-backup' or (p_data->>'version')::int is distinct from 1 then raise exception 'BACKUP_INVALID'; end if;
  if p_mode = 'new' then
    if not is_platform_admin() and not (select open_signup from platform_settings) then raise exception 'NOT_ALLOWED_CREATE_ORG: only the owner can create a company'; end if;
  elsif p_mode = 'replace' then
    if p_target is null or not is_owner(p_target) then raise exception 'not allowed'; end if;
  else raise exception 'not allowed'; end if;
  o := (p_data->'org'->>'id')::uuid;
  if o is null or exists (select 1 from orgs where id = o) then raise exception 'BACKUP_IDS_TAKEN'; end if;
  -- every company row must belong to the restored company
  for t in select k from jsonb_object_keys(p_data->'tables') k loop
    if not (t = any(backup_tables()) or t in ('stock_doc_lines','payment_allocations','price_list_items')) then raise exception 'BACKUP_INVALID: %', t; end if;
    if t = any(backup_tables()) and exists (select 1 from jsonb_array_elements(p_data->'tables'->t) r where r->>'org_id' is distinct from o::text) then raise exception 'BACKUP_INVALID: % belongs to another company', t; end if;
  end loop;

  set local session_replication_role = replica;      -- raw copy: no posting triggers, numbering or guards
  perform restore_rows('orgs', jsonb_build_array(p_data->'org'));
  foreach t in array backup_tables() loop n := n + restore_rows(t, p_data->'tables'->t); end loop;
  -- children: their parent must be one of the rows just restored
  if exists (select 1 from jsonb_array_elements(coalesce(p_data->'tables'->'stock_doc_lines', '[]')) r where not exists (select 1 from stock_docs d where d.id = (r->>'stock_doc_id')::uuid and d.org_id = o))
     or exists (select 1 from jsonb_array_elements(coalesce(p_data->'tables'->'payment_allocations', '[]')) r where not exists (select 1 from payments d where d.id = (r->>'payment_id')::uuid and d.org_id = o))
     or exists (select 1 from jsonb_array_elements(coalesce(p_data->'tables'->'price_list_items', '[]')) r where not exists (select 1 from price_lists d where d.id = (r->>'price_list_id')::uuid and d.org_id = o))
  then raise exception 'BACKUP_INVALID: lines without their document'; end if;
  n := n + restore_rows('stock_doc_lines', p_data->'tables'->'stock_doc_lines') + restore_rows('payment_allocations', p_data->'tables'->'payment_allocations') + restore_rows('price_list_items', p_data->'tables'->'price_list_items');
  insert into members (org_id, user_id, role) values (o, me, 'owner');
  set local session_replication_role = origin;

  -- integrity: every reference resolves, and only to rows of this company
  for fk in select c.conrelid::regclass::text ch, c.confrelid::regclass::text par, a.attname col, b.attname pcol,
      exists (select 1 from pg_attribute x where x.attrelid = c.confrelid and x.attname = 'org_id') par_org,
      exists (select 1 from pg_attribute x where x.attrelid = c.conrelid and x.attname = 'org_id') ch_org
    from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1] join pg_attribute b on b.attrelid = c.confrelid and b.attnum = c.confkey[1]
    where c.contype = 'f' and c.connamespace = 'public'::regnamespace and array_length(c.conkey, 1) = 1
      and c.conrelid::regclass::text in (select unnest(backup_tables() || array['stock_doc_lines','payment_allocations','price_list_items']))
  loop
    if fk.ch_org then
      execute format('select exists (select 1 from %I c left join %I p on p.%I = c.%I where c.org_id = $1 and c.%I is not null and (p.%I is null %s))',
        fk.ch, fk.par, fk.pcol, fk.col, fk.col, fk.pcol, case when fk.par_org then 'or p.org_id <> $1' when fk.par = 'orgs' then 'or p.id <> $1' else '' end) into bad using o;
    else
      execute format('select exists (select 1 from %I c where c.%I is not null and c.%I = any($2) and %s)', fk.ch, fk.col, fk.col,
        case when fk.par_org then format('not exists (select 1 from %I p where p.%I = c.%I and p.org_id = $1)', fk.par, fk.pcol, fk.col) else 'false' end)
        into bad using o, (select array_agg((r->>fk.col)::uuid) from jsonb_array_elements(coalesce(p_data->'tables'->fk.ch, '[]')) r);
    end if;
    if bad then raise exception 'BACKUP_INVALID: broken reference %.%', fk.ch, fk.col; end if;
  end loop;
  if exists (select 1 from journal_lines where org_id = o group by entry_id having sum(debit) <> sum(credit)) then raise exception 'BACKUP_INVALID: unbalanced journal entry'; end if;

  if p_mode = 'replace' then
    -- everyone moves to the restored company with the same role (copied over if the backup lacks it)
    insert into roles (org_id, name, permissions)
      select o, r.name, r.permissions from roles r where r.org_id = p_target and not exists (select 1 from roles x where x.org_id = o and x.name = r.name);
    insert into members (org_id, user_id, role, role_id, branch_ids)
      select o, m.user_id, m.role, (select x.id from roles x join roles r on r.id = m.role_id where x.org_id = o and x.name = r.name limit 1),
        case when m.branch_ids is null then null else array(select nb.id from branches ob join branches nb on nb.org_id = o and nb.name = ob.name where ob.id = any(m.branch_ids)) end
      from members m where m.org_id = p_target and m.user_id <> me;
    delete from invitations where org_id = p_target;
    delete from members where org_id = p_target and user_id <> me;
    update orgs set name_ar = left(name_ar, 150) || ' — أرشيف ' || stamp where id = p_target;
  end if;
  insert into backup_log (org_id, user_id, source, tables, rows, note)
    values (o, me, 'restore', (select count(*) from jsonb_object_keys(p_data->'tables')), n, 'من نسخة ' || coalesce(left(p_data->>'exported_at', 16), '') || case when p_mode = 'replace' then ' — بدلاً من الشركة السابقة' else '' end);
  return o;
end $$;

revoke execute on function export_org(uuid, text), import_org(jsonb, text, uuid), restore_rows(text, jsonb), backup_tables() from public, anon;
revoke execute on function restore_rows(text, jsonb) from authenticated;
grant execute on function export_org(uuid, text), import_org(jsonb, text, uuid) to authenticated;

-- ---------- custom reports ----------
create table saved_reports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null check (length(name) between 1 and 200),
  definition jsonb not null check (jsonb_typeof(definition) = 'object' and length(definition::text) < 20000),
  pinned boolean not null default false,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on saved_reports (org_id, name);
alter table saved_reports enable row level security;
create policy saved_reports_read on saved_reports for select using (has_perm(org_id, 'reports', 'view'));
create policy saved_reports_ins on saved_reports for insert with check (has_perm(org_id, 'reports', 'create'));
create policy saved_reports_upd on saved_reports for update using (has_perm(org_id, 'reports', 'create')) with check (has_perm(org_id, 'reports', 'create'));
create policy saved_reports_del on saved_reports for delete using (has_perm(org_id, 'reports', 'create'));
revoke all on saved_reports from public, anon, authenticated;
grant select, insert, update, delete on saved_reports to authenticated;
create or replace function guard_client_saved_report() returns trigger language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  if tg_op = 'UPDATE' then
    if new.org_id <> old.org_id then raise exception 'not allowed'; end if;
    new.created_by := old.created_by; new.created_at := old.created_at;
  else new.created_by := auth.uid(); new.created_at := now(); end if;
  new.updated_at := now(); return new;
end $$;
create trigger saved_reports_client_guard before insert or update on saved_reports for each row execute function guard_client_saved_report();

-- flat rows for the report builder; runs with the caller's permissions (row-level security applies)
create or replace function report_dataset(p_org uuid, p_ds text, p_from date, p_to date) returns jsonb
language plpgsql stable security invoker set search_path = public set statement_timeout = '60s' as $$
declare r jsonb;
begin
  if not is_member(p_org) then raise exception 'not allowed'; end if;
  if p_ds = 'sales_lines' then
    select coalesce(jsonb_agg(x), '[]') into r from (
      select d.issue_date as date, to_char(d.issue_date, 'YYYY-MM') as month, d.number, case d.kind when 'credit_note' then 'إشعار دائن' when 'simplified_invoice' then 'فاتورة مبسطة' else 'فاتورة ضريبية' end doc_kind,
        p.name party, p.city party_city, coalesce(i.name_ar, l.description) item, i.sku, case i.kind when 'product' then 'منتج' when 'service' then 'خدمة' when 'raw_material' then 'مادة خام' end item_kind,
        l.qty * s.sg qty, l.line_net * s.sg net, l.line_vat * s.sg vat, (l.line_net + l.line_vat) * s.sg total,
        round(coalesce(l.unit_cost, 0) * l.qty) * s.sg cost, (l.line_net - round(coalesce(l.unit_cost, 0) * l.qty)) * s.sg profit,
        b.name branch, cc.name cost_center, d.payment_status
      from document_lines l join documents d on d.id = l.document_id cross join lateral (select case when d.kind = 'credit_note' then -1 else 1 end sg) s
      left join parties p on p.id = d.party_id left join items i on i.id = l.item_id left join branches b on b.id = d.branch_id left join cost_centers cc on cc.id = d.cost_center_id
      where d.org_id = p_org and d.status = 'posted' and d.kind in ('tax_invoice','simplified_invoice','credit_note') and d.issue_date between p_from and p_to order by d.issue_date) x;
  elsif p_ds = 'sales_docs' then
    select coalesce(jsonb_agg(x), '[]') into r from (
      select d.issue_date as date, to_char(d.issue_date, 'YYYY-MM') as month, d.number, case d.kind when 'credit_note' then 'إشعار دائن' when 'simplified_invoice' then 'فاتورة مبسطة' when 'quote' then 'عرض سعر' when 'sales_order' then 'أمر بيع' else 'فاتورة ضريبية' end doc_kind,
        p.name party, p.city party_city, d.subtotal * s.sg net, d.vat_total * s.sg vat, d.total * s.sg total, d.amount_paid * s.sg paid, (d.total - d.amount_paid) * s.sg open, d.due_date,
        case when d.due_date < current_date and d.total > d.amount_paid then (current_date - d.due_date) end days_late,
        case d.payment_status when 'paid' then 'مدفوعة' when 'partial' then 'جزئي' else 'غير مدفوعة' end payment_status, b.name branch, cc.name cost_center
      from documents d cross join lateral (select case when d.kind = 'credit_note' then -1 else 1 end sg) s left join parties p on p.id = d.party_id left join branches b on b.id = d.branch_id left join cost_centers cc on cc.id = d.cost_center_id
      where d.org_id = p_org and d.status = 'posted' and d.kind in ('tax_invoice','simplified_invoice','credit_note','progress_bill') and d.issue_date between p_from and p_to order by d.issue_date) x;
  elsif p_ds = 'purchase_lines' then
    select coalesce(jsonb_agg(x), '[]') into r from (
      select d.issue_date as date, to_char(d.issue_date, 'YYYY-MM') as month, d.number, case d.kind when 'purchase_return' then 'مرتجع مشتريات' else 'فاتورة مشتريات' end doc_kind,
        p.name party, coalesce(i.name_ar, l.description) item, i.sku, l.qty * s.sg qty, l.line_net * s.sg net, l.line_vat * s.sg vat, (l.line_net + l.line_vat) * s.sg total, cc.name cost_center, b.name branch
      from document_lines l join documents d on d.id = l.document_id cross join lateral (select case when d.kind = 'purchase_return' then -1 else 1 end sg) s
      left join parties p on p.id = d.party_id left join items i on i.id = l.item_id left join branches b on b.id = d.branch_id left join cost_centers cc on cc.id = d.cost_center_id
      where d.org_id = p_org and d.status = 'posted' and d.kind in ('purchase_bill','purchase_return') and d.issue_date between p_from and p_to order by d.issue_date) x;
  elsif p_ds = 'expenses' then
    select coalesce(jsonb_agg(x), '[]') into r from (
      select e.expense_date as date, to_char(e.expense_date, 'YYYY-MM') as month, e.number, a.name_ar account, e.description, p.name party, em.full_name employee, cc.name cost_center, b.name branch,
        e.amount, e.vat_amount vat, e.amount + e.vat_amount total
      from expenses e left join accounts a on a.id = e.account_id left join parties p on p.id = e.supplier_id left join employees em on em.id = e.employee_id
      left join cost_centers cc on cc.id = e.cost_center_id left join branches b on b.id = e.branch_id
      where e.org_id = p_org and e.status = 'posted' and e.expense_date between p_from and p_to order by e.expense_date) x;
  elsif p_ds = 'journal' then
    select coalesce(jsonb_agg(x), '[]') into r from (
      select e.entry_date as date, to_char(e.entry_date, 'YYYY-MM') as month, e.number entry_no, a.code account_code, a.name_ar account,
        case a.type when 'asset' then 'أصول' when 'liability' then 'خصوم' when 'equity' then 'حقوق ملكية' when 'revenue' then 'إيرادات' else 'مصروفات' end account_type,
        cc.name cost_center, p.name party, l.debit, l.credit, l.debit - l.credit net, coalesce(l.memo, e.memo) memo
      from journal_lines l join journal_entries e on e.id = l.entry_id and e.status = 'posted' join accounts a on a.id = l.account_id
      left join cost_centers cc on cc.id = l.cost_center_id left join parties p on p.id = l.party_id
      where l.org_id = p_org and e.entry_date between p_from and p_to order by e.entry_date, e.number) x;
  elsif p_ds = 'stock_moves' then
    select coalesce(jsonb_agg(x), '[]') into r from (
      select m.move_date as date, to_char(m.move_date, 'YYYY-MM') as month, i.name_ar item, i.sku, w.name warehouse,
        case m.source_type when 'sale' then 'بيع' when 'purchase' then 'شراء' when 'return' then 'مرتجع' when 'transfer' then 'تحويل' when 'count' then 'جرد' when 'waste' then 'هالك'
          when 'opening' then 'افتتاحي' when 'production' then 'تصنيع' when 'issue' then 'صرف لمشروع' when 'issue_return' then 'إرجاع من مشروع' else m.source_type end move_type,
        case when m.qty > 0 then m.qty else 0 end qty_in, case when m.qty < 0 then -m.qty else 0 end qty_out, m.qty, round(m.qty * coalesce(m.unit_cost, 0)) value
      from stock_moves m join items i on i.id = m.item_id left join warehouses w on w.id = m.warehouse_id
      where m.org_id = p_org and m.move_date between p_from and p_to order by m.move_date) x;
  elsif p_ds = 'items' then
    select coalesce(jsonb_agg(x), '[]') into r from (
      select i.name_ar item, i.sku, case i.kind when 'product' then 'منتج' when 'service' then 'خدمة' else 'مادة خام' end item_kind, i.unit, i.sale_price,
        round(i.avg_cost) avg_cost, coalesce(q.qty, 0) on_hand, round(coalesce(q.qty, 0) * i.avg_cost) stock_value, case when i.is_active then 'نشط' else 'موقوف' end active
      from items i left join (select item_id, sum(qty) qty from stock_moves where org_id = p_org and move_date <= p_to group by item_id) q on q.item_id = i.id
      where i.org_id = p_org order by i.name_ar) x;
  elsif p_ds = 'parties' then
    select coalesce(jsonb_agg(x), '[]') into r from (
      select p.name party, case p.kind when 'customer' then 'عميل' when 'supplier' then 'مورد' else 'عميل ومورد' end party_kind, p.city party_city, p.phone, p.vat_number,
        coalesce(sum(l.debit - l.credit) filter (where a.system_key = 'ar'), 0) receivable, coalesce(sum(l.credit - l.debit) filter (where a.system_key = 'ap'), 0) payable
      from parties p left join journal_lines l on l.party_id = p.id left join journal_entries e on e.id = l.entry_id and e.status = 'posted' and e.entry_date <= p_to
      left join accounts a on a.id = l.account_id and e.id is not null
      where p.org_id = p_org group by p.id order by p.name) x;
  elsif p_ds = 'projects' then
    select coalesce(jsonb_agg(x), '[]') into r from (
      select c.code, c.name project, case c.project_type when 'customer' then 'لعميل' when 'production' then 'تصنيع إنتاجي' else 'داخلي' end project_type,
        case c.status when 'active' then 'نشط' else 'منتهي' end status, p.name party, c.start_date, c.due_date, c.contract_value,
        coalesce(pl.revenue, 0) revenue, coalesce(pl.cogs, 0) materials, coalesce(pl.expenses, 0) expenses, coalesce(pl.revenue, 0) - coalesce(pl.cogs, 0) - coalesce(pl.expenses, 0) profit
      from cost_centers c left join parties p on p.id = c.party_id left join project_pl(p_org, p_from, p_to) pl on pl.cost_center_id = c.id
      where c.org_id = p_org and not c.is_template order by c.code) x;
  elsif p_ds = 'timesheets' then
    select coalesce(jsonb_agg(x), '[]') into r from (
      select t.work_date as date, to_char(t.work_date, 'YYYY-MM') as month, c.name project, em.full_name employee, em.job_title, tk.title task, t.hours, t.rate, t.amount,
        case when t.entry_id is not null then 'مرحّلة' else 'غير مرحّلة' end posted
      from timesheets t join cost_centers c on c.id = t.cost_center_id join employees em on em.id = t.employee_id left join tasks tk on tk.id = t.task_id
      where t.org_id = p_org and t.work_date between p_from and p_to order by t.work_date) x;
  elsif p_ds = 'payslips' then
    select coalesce(jsonb_agg(x), '[]') into r from (
      select to_char(pr.period_month, 'YYYY-MM') as month, em.full_name employee, em.job_title, s.gross, s.additions, s.deductions, s.gosi_employee, s.gosi_employer, s.net
      from payslips s join payroll_runs pr on pr.id = s.run_id join employees em on em.id = s.employee_id
      where s.org_id = p_org and pr.status <> 'draft' and pr.period_month between date_trunc('month', p_from)::date and p_to order by pr.period_month) x;
  elsif p_ds = 'tasks' then
    select coalesce(jsonb_agg(x), '[]') into r from (
      select t.title task, c.name project, t.phase, case t.status when 'done' then 'منجزة' when 'doing' then 'قيد التنفيذ' else 'جديدة' end status,
        case t.priority when 'high' then 'عالية' when 'low' then 'منخفضة' else 'عادية' end priority, t.start_date, t.due_date, t.done_at::date done_date,
        case when t.status <> 'done' and t.due_date < current_date then 'متأخرة' else '' end late, t.est_hours, cardinality(coalesce(t.employee_ids, '{}')) workers
      from tasks t left join cost_centers c on c.id = t.cost_center_id
      where t.org_id = p_org and (t.due_date is null or t.due_date between p_from and p_to or t.status <> 'done') order by t.due_date nulls last) x;
  else raise exception 'not allowed'; end if;
  return r;
end $$;
revoke execute on function report_dataset(uuid, text, date, date), guard_client_saved_report() from public, anon;
grant execute on function report_dataset(uuid, text, date, date) to authenticated;


-- =====================================================================
-- Migration 16 — tighten table privileges
--  Supabase grants every new table to anon and authenticated by default.
--  Row-level security already blocked every row, but the grants themselves
--  should not exist:
--   • anon (visitors without an account) gets no table or view at all —
--     the customer portal works through its own functions
--   • signed-in users keep read/write (still filtered by RLS), but lose
--     TRUNCATE / TRIGGER / REFERENCES, which they never need
--   • future tables are no longer granted to anon automatically
-- =====================================================================
revoke all on all tables in schema public from anon;
revoke truncate, trigger, references on all tables in schema public from authenticated;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke truncate, trigger, references on tables from authenticated;


-- 17: company reset (owner only) — clear trial data before going live.
--   p_mode 'ops' : wipe operations (invoices, entries, vouchers, stock, projects, payroll, HR records, tasks…),
--                  numbering restarts at 1; keeps settings, logo, chart of accounts, items, customers/suppliers,
--                  employees, branches, warehouses, price lists, BOMs, commitments, budgets, studies, saved reports.
--   p_mode 'all' : wipe every company record; keeps the company profile (name, VAT, logo, invoice design),
--                  users and roles; a fresh chart of accounts, main branch and main warehouse are created.
-- The caller must type the company name exactly. Everything runs in one transaction: any broken
-- reference afterwards aborts the whole reset and nothing is lost.

alter table backup_log drop constraint if exists backup_log_source_check;
alter table backup_log add constraint backup_log_source_check check (source in ('app','script','restore','reset'));

create or replace function reset_org(p_org uuid, p_mode text, p_confirm text) returns jsonb
language plpgsql volatile security definer set search_path = public set statement_timeout = '300s' as $$
declare me uuid := auth.uid(); org orgs; t text; k int; counts jsonb := '{}'::jsonb; fk record; bad boolean; b uuid;
  ops text[] := array['asset_depreciation','attendance','calendar_notes','document_lines','documents','evaluations','expenses',
    'fixed_assets','journal_entries','journal_lines','landed_costs','leads','leaves','mfg_order_costs','mfg_order_lines','mfg_orders',
    'payments','payroll_runs','payslips','pos_shifts','project_materials','reminders','stock_docs','stock_moves','tasks','timesheets',
    'van_trips','counters'];
  wipe text[];
begin
  if me is null then raise exception 'sign in first'; end if;
  if p_org is null or not is_owner(p_org) then raise exception 'not allowed'; end if;
  if p_mode not in ('ops','all') then raise exception 'not allowed'; end if;
  select * into org from orgs where id = p_org for update;
  if btrim(coalesce(p_confirm, '')) is distinct from btrim(org.name_ar) then raise exception 'RESET_CONFIRM: type the company name exactly'; end if;
  wipe := case when p_mode = 'all' then array(select x from unnest(backup_tables()) x where x not in ('roles','audit_log')) else ops end;

  set local session_replication_role = replica;      -- posted entries are immutable by trigger; this is the deliberate exception
  -- child tables without org_id first
  delete from stock_doc_lines x using stock_docs d where d.id = x.stock_doc_id and d.org_id = p_org;
  get diagnostics k = row_count; counts := counts || jsonb_build_object('stock_doc_lines', k);
  delete from payment_allocations x using payments d where d.id = x.payment_id and d.org_id = p_org;
  get diagnostics k = row_count; counts := counts || jsonb_build_object('payment_allocations', k);
  if p_mode = 'all' then
    delete from price_list_items x using price_lists d where d.id = x.price_list_id and d.org_id = p_org;
    get diagnostics k = row_count; counts := counts || jsonb_build_object('price_list_items', k);
    delete from portal_links where org_id = p_org;
    update members set branch_ids = null where org_id = p_org;
  end if;
  foreach t in array wipe loop
    execute format('delete from %I where org_id = $1', t) using p_org;
    get diagnostics k = row_count; if k > 0 then counts := counts || jsonb_build_object(t, k); end if;
  end loop;
  if p_mode = 'ops' then
    -- projects are cost centres flagged is_project (templates stay)
    update cost_centers set source_project_id = null where org_id = p_org and source_project_id in (select id from cost_centers where org_id = p_org and is_project and not is_template);
    update employees set cost_center_id = null where org_id = p_org and cost_center_id in (select id from cost_centers where org_id = p_org and is_project and not is_template);
    delete from cost_centers where org_id = p_org and is_project and not is_template;
    get diagnostics k = row_count; if k > 0 then counts := counts || jsonb_build_object('projects', k); end if;
    update items set avg_cost = 0 where org_id = p_org;
  end if;
  update zatca_devices set last_icv = 0, last_hash = 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==' where org_id = p_org;
  update orgs set locked_until = null where id = p_org;
  set local session_replication_role = origin;

  if p_mode = 'all' then        -- back to day one
    insert into branches (org_id, name, city, street, building_no, postal_code)
      values (p_org, 'الفرع الرئيسي', org.city, org.street, org.building_no, org.postal_code) returning id into b;
    insert into warehouses (org_id, branch_id, name) values (p_org, b, 'المستودع الرئيسي');
    perform seed_chart(p_org);
    perform ensure_extra_accounts(p_org);
  end if;

  -- integrity: every remaining reference of this company still resolves
  for fk in select c.conrelid::regclass::text ch, c.confrelid::regclass::text par, a.attname col, b2.attname pcol
    from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1] join pg_attribute b2 on b2.attrelid = c.confrelid and b2.attnum = c.confkey[1]
    where c.contype = 'f' and c.connamespace = 'public'::regnamespace and array_length(c.conkey, 1) = 1
      and (select relnamespace from pg_class where oid = c.confrelid) = 'public'::regnamespace
      and exists (select 1 from pg_attribute x where x.attrelid = c.conrelid and x.attname = 'org_id' and not x.attisdropped)
  loop
    execute format('select exists (select 1 from %I c left join %I p on p.%I = c.%I where c.org_id = $1 and c.%I is not null and p.%I is null)',
      fk.ch, fk.par, fk.pcol, fk.col, fk.col, fk.pcol) into bad using p_org;
    if bad then raise exception 'RESET_BROKEN: %.% still points to deleted rows', fk.ch, fk.col; end if;
  end loop;
  if exists (select 1 from stock_doc_lines x left join stock_docs d on d.id = x.stock_doc_id where d.id is null)
     or exists (select 1 from payment_allocations x left join payments d on d.id = x.payment_id where d.id is null) then
    raise exception 'RESET_BROKEN: lines without their document'; end if;

  insert into audit_log (org_id, user_id, action, table_name, row_id, diff)
    values (p_org, me, 'reset_' || p_mode, 'orgs', p_org, counts);
  insert into backup_log (org_id, user_id, source, tables, rows, note)
    values (p_org, me, 'reset', (select count(*) from jsonb_object_keys(counts)), coalesce((select sum(value::int) from jsonb_each_text(counts)), 0),
      case when p_mode = 'all' then 'تصفير كامل — رجع النظام مثل أول يوم' else 'تصفير العمليات — بقيت الأصناف والعملاء والموظفون والإعدادات' end);
  return jsonb_build_object('mode', p_mode, 'deleted', counts);
end $$;

revoke execute on function reset_org(uuid, text, text) from public, anon;
grant execute on function reset_org(uuid, text, text) to authenticated;


-- 18: VAT on a document is rounded once per VAT rate (ZATCA BR-S-09 / BR-CO-14), not as the sum of rounded lines.
-- Lines keep their own rounded VAT (BR-KSA-50). Only the document total can move, by at most a halala or two on
-- long invoices, and only for documents posted from now on.
create or replace function compute_lines(doc uuid, fx numeric default 1) returns void
language sql security definer set search_path = public as $$
  update document_lines set
    line_net = round(qty * unit_price * fx) - discount,
    line_vat = round((round(qty * unit_price * fx) - discount) * vat_rate / 100)
  where document_id = doc;
  update documents set
    subtotal = (select coalesce(sum(line_net),0) from document_lines where document_id = doc),
    vat_total = (select coalesce(sum(v), 0) from (select round(sum(line_net) * vat_rate / 100) v
                   from document_lines where document_id = doc group by vat_rate) x)
  where id = doc;
  update documents set total = subtotal + vat_total where id = doc;
$$;
revoke execute on function compute_lines(uuid, numeric) from public, anon, authenticated;
