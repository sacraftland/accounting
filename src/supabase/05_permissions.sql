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
