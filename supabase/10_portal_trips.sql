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
