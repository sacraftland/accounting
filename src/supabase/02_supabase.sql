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
