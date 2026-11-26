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
