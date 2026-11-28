-- 19: ZATCA phase 2 — device keys and certificates, and the per-device invoice chain used by the zatca Edge Function.
-- zatca_secrets has no org_id on purpose: it is never part of a backup, an export or a restore, and no browser role can read it.
-- Only the Edge Function (service role) reaches it, through the functions below.

create table zatca_secrets (
  device_id uuid primary key references zatca_devices(id) on delete cascade,
  private_key_pem text not null,
  compliance_cert text, compliance_secret text, compliance_request_id text,
  production_cert text, production_secret text,
  updated_at timestamptz not null default now()
);
alter table zatca_secrets enable row level security;                 -- no policies: browser roles see nothing
revoke all on zatca_secrets from public, anon, authenticated;

alter table zatca_devices add column if not exists busy_until timestamptz;
alter table zatca_devices add column if not exists last_error text;
alter table zatca_devices add column if not exists compliance_report jsonb;
alter table zatca_devices add column if not exists egs_uuid uuid not null default gen_random_uuid();

-- next counter value and previous hash for a device; one invoice at a time per device (the chain must not fork)
create or replace function zatca_reserve(p_device uuid) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare d zatca_devices;
begin
  update zatca_devices set busy_until = now() + interval '60 seconds'
   where id = p_device and (busy_until is null or busy_until < now()) returning * into d;
  if d.id is null then raise exception 'ZATCA_DEVICE_BUSY'; end if;
  return jsonb_build_object('icv', d.last_icv + 1, 'pih', d.last_hash, 'environment', d.environment, 'status', d.status);
end $$;

-- record a signed document and move the chain forward (only if nobody else did)
create or replace function zatca_commit(p_device uuid, p_doc uuid, p_icv bigint, p_pih text, p_hash text, p_status text,
  p_xml text, p_qr text, p_response jsonb) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  if p_status not in ('cleared','reported','warning','rejected') then raise exception 'not allowed'; end if;
  update zatca_devices set last_icv = p_icv, last_hash = p_hash, busy_until = null, last_error = case when p_status = 'rejected' then left(p_response::text, 2000) end
   where id = p_device and last_icv = p_icv - 1 and last_hash = p_pih;
  if not found then raise exception 'ZATCA_CHAIN_MOVED'; end if;
  update documents set zatca_device_id = p_device, zatca_icv = p_icv, zatca_pih = p_pih, zatca_hash = p_hash, zatca_status = p_status,
    zatca_xml = p_xml, zatca_qr = coalesce(p_qr, zatca_qr), zatca_response = p_response where id = p_doc;
end $$;

create or replace function zatca_release(p_device uuid) returns void
language sql volatile security definer set search_path = public as $$ update zatca_devices set busy_until = null where id = p_device $$;

revoke execute on function zatca_reserve(uuid), zatca_commit(uuid, uuid, bigint, text, text, text, text, text, jsonb), zatca_release(uuid) from public, anon, authenticated;
grant execute on function zatca_reserve(uuid), zatca_commit(uuid, uuid, bigint, text, text, text, text, text, jsonb), zatca_release(uuid) to service_role;

-- company reset also removes the keys of devices it deletes
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
  if exists (select 1 from zatca_devices where org_id = p_org and environment = 'production') then
    raise exception 'RESET_ZATCA_LIVE: invoices already reported to ZATCA cannot be wiped'; end if;
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

  delete from zatca_secrets s where not exists (select 1 from zatca_devices d where d.id = s.device_id);   -- keys of devices removed above
  insert into audit_log (org_id, user_id, action, table_name, row_id, diff)
    values (p_org, me, 'reset_' || p_mode, 'orgs', p_org, counts);
  insert into backup_log (org_id, user_id, source, tables, rows, note)
    values (p_org, me, 'reset', (select count(*) from jsonb_object_keys(counts)), coalesce((select sum(value::int) from jsonb_each_text(counts)), 0),
      case when p_mode = 'all' then 'تصفير كامل — رجع النظام مثل أول يوم' else 'تصفير العمليات — بقيت الأصناف والعملاء والموظفون والإعدادات' end);
  return jsonb_build_object('mode', p_mode, 'deleted', counts);
end $$;

revoke execute on function reset_org(uuid, text, text) from public, anon;
grant execute on function reset_org(uuid, text, text) to authenticated;
