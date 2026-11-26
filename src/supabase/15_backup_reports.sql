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
