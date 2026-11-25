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
