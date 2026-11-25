-- Invite-only access (migration 04). Run by tests/run_supabase_tests.sh on a fresh database.
\set ON_ERROR_STOP on
create schema t;
create table t.results (n serial, name text, ok boolean, info text);
grant usage on schema t to anon, authenticated; grant all on t.results to anon, authenticated; grant usage on sequence t.results_n_seq to anon, authenticated;
create function t.ok(name text, cond boolean, info text default '') returns void language sql as $$ insert into t.results (name, ok, info) values (name, coalesce(cond,false), info) $$;
create function t.fails(name text, q text, pattern text) returns void language plpgsql as $$
begin
  begin execute q; insert into t.results (name, ok, info) values (name, false, 'no error');
  exception when others then insert into t.results (name, ok, info) values (name, sqlerrm ~* pattern, sqlerrm); end;
end $$;
grant execute on all functions in schema t to anon, authenticated;

insert into platform_admins values ('sa.craft.land@gmail.com');
-- sign-up gate (the auth service inserts into auth.users)
select t.fails('stranger cannot sign up', $q$insert into auth.users values ('00000000-0000-0000-0000-00000000dead','random@gmail.com')$q$, 'NOT_INVITED');
insert into auth.users values ('00000000-0000-0000-0000-0000000000aa','SA.Craft.Land@gmail.com');
select t.ok('owner email can sign up (any letter case)', exists (select 1 from auth.users where id = '00000000-0000-0000-0000-0000000000aa'));

-- owner creates Craft Land
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa"}', false);
select t.ok('whoami: owner is platform admin', (whoami()->>'is_platform_admin')::boolean);
select create_org('كرافت لاند') as org \gset
select invite_member(:'org', ' Accountant@Example.com ', (select id from roles where org_id = :'org' and name = 'محاسب')) as inv1 \gset
select invite_member(:'org', 'sales@example.com', (select id from roles where org_id = :'org' and name = 'مندوب مبيعات')) as inv2 \gset
select invite_member(:'org', 'drop@example.com', (select id from roles where org_id = :'org' and name = 'مندوب مبيعات')) as inv3 \gset
select t.ok('invitation stored lower-case', (select email from invitations where id = :'inv1') = 'accountant@example.com');
select invite_member(:'org', 'sales@example.com', (select id from roles where org_id = :'org' and name = 'أمين مستودع'));
select t.ok('re-inviting updates the role, no duplicate', (select count(*) = 1 and min(r.name) = 'أمين مستودع' from invitations i join roles r on r.id = i.role_id where i.email = 'sales@example.com'));
select revoke_invitation(:'inv3');
select t.ok('owner revokes invitation', not exists (select 1 from invitations where id = :'inv3'));
select t.fails('cannot invite with another company''s role', format($q$select invite_member(%L, 'x@example.com', gen_random_uuid())$q$, :'org'), 'role not found');
select t.fails('cannot insert invitations directly', format($q$insert into invitations (org_id, email, role) values (%L, 'y@example.com', 'admin')$q$, :'org'), 'permission denied');
reset role;

-- invited people can sign up; the revoked one can't
insert into auth.users values ('00000000-0000-0000-0000-0000000000cc','accountant@example.com');
select t.ok('invited email can sign up', exists (select 1 from auth.users where id = '00000000-0000-0000-0000-0000000000cc'));
select t.fails('revoked email cannot sign up', $q$insert into auth.users values ('00000000-0000-0000-0000-0000000000dd','drop@example.com')$q$, 'NOT_INVITED');
insert into auth.users values ('00000000-0000-0000-0000-0000000000ee','sales@example.com');

-- accountant signs in → joins automatically
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000cc"}', false);
select t.ok('before accepting: sees no company', (select count(*) from orgs) = 0);
select t.ok('accept_invitations joins 1 company', accept_invitations() = 1);
select t.ok('accountant sees Craft Land', (select name_ar from orgs) = 'كرافت لاند');
select t.ok('second accept does nothing', accept_invitations() = 0);
select t.ok('role is accountant', (select r.name from members m join roles r on r.id = m.role_id where m.user_id = auth.uid()) = 'محاسب');
select t.fails('accountant cannot create another company', $q$select create_org('شركتي')$q$, 'NOT_ALLOWED_CREATE_ORG');
select t.fails('accountant cannot invite', format($q$select invite_member(%L, 'z@example.com', (select id from roles where org_id = %L limit 1))$q$, :'org', :'org'), 'not allowed');
select t.fails('accountant cannot list members', format($q$select * from list_members(%L)$q$, :'org'), 'not allowed');
select t.ok('accountant sees no invitations', (select count(*) from invitations) = 0);
insert into parties (org_id, kind, name) values (:'org', 'customer', 'عميل');
select t.ok('accountant can still work (add customer)', (select count(*) from parties) = 1);

-- storekeeper joins, then owner manages roles
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000ee"}', false);
select accept_invitations();
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa"}', false);
select t.ok('owner lists 3 members, owner first', (select count(*) = 3 from list_members(:'org')) and (select role from list_members(:'org') limit 1) = 'owner');
select t.ok('list shows emails and role names', exists (select 1 from list_members(:'org') where email = 'accountant@example.com' and role_name = 'محاسب'));
select set_member_role(:'org', '00000000-0000-0000-0000-0000000000cc', (select id from roles where org_id = :'org' and name = 'مدير عام'));
select t.ok('owner promotes accountant to general manager', (select r.name from members m join roles r on r.id = m.role_id where m.user_id = '00000000-0000-0000-0000-0000000000cc') = 'مدير عام');
select t.fails('owner role cannot be changed', format($q$select set_member_role(%L, '00000000-0000-0000-0000-0000000000aa', (select id from roles where org_id = %L limit 1))$q$, :'org', :'org'), 'OWNER_PROTECTED');

-- admin can invite non-admins, cannot touch owner or make admins
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000cc"}', false);
select t.ok('manager can invite a worker', invite_member(:'org', 'cashier@example.com', (select id from roles where org_id = :'org' and name = 'عامل ورشة')) is not null);
select t.fails('admin cannot remove the owner', format($q$select remove_member(%L, '00000000-0000-0000-0000-0000000000aa')$q$, :'org'), 'OWNER_PROTECTED');
select t.ok('admin sees invitations', (select count(*) from invitations where accepted_at is null) = 1);

-- owner removes storekeeper → loses access
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa"}', false);
select remove_member(:'org', '00000000-0000-0000-0000-0000000000ee');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000ee"}', false);
select t.ok('removed member sees nothing', (select count(*) from orgs) = 0 and (select count(*) from parties) = 0);
select t.fails('removed member cannot rejoin by accepting', $q$select 1/(accept_invitations()) $q$, 'division by zero');

-- not signed in
reset role; set role anon;
select set_config('request.jwt.claims', '', false);
select t.fails('anon cannot call invite', format($q$select invite_member(%L, 'a@b.co', null::uuid)$q$, :'org'), 'permission denied');
reset role;

select (case when ok then 'PASS ' else 'FAIL ' end) || name || case when not ok then '  [' || info || ']' else '' end as result from t.results order by n;
select count(*) filter (where ok) || ' / ' || count(*) || ' passed (invites)' as summary from t.results;
