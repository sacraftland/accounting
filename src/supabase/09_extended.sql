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
