-- Invoice design & role dashboards (migration 13), as the browser roles.
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
insert into platform_admins values ('owner@example.com'), ('other@example.com');
insert into auth.users values ('00000000-0000-0000-0000-0000000000aa','owner@example.com'), ('00000000-0000-0000-0000-0000000000bb','other@example.com');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa"}', false);
select create_org('كرافت لاند', '300000000000003') as org \gset
update orgs set invoice_settings = '{"template":"modern","iban":"SA0380000000608010167519"}', stamp_path = 'data:image/png;base64,AAAA' where id = :'org';
select t.ok('owner saves invoice design & stamp', (select invoice_settings->>'template' from orgs where id = :'org') = 'modern' and (select stamp_path from orgs where id = :'org') is not null);
select t.fails('invoice settings must be an object', format($q$update orgs set invoice_settings = '[]' where id = %L$q$, :'org'), 'check');
select save_role(:'org', null, 'مشرف الورشة', '{"manufacturing":["view","create"]}') as r1 \gset
select set_role_dashboard(:'r1', '{"order":["quick","projects"],"hidden":["invoices"],"kpis":["tasks_late"]}');
select t.ok('role dashboard saved', (select dashboard->'kpis'->>0 from roles where id = :'r1') = 'tasks_late');
select invite_member(:'org', 'sup@example.com', :'r1');
reset role; insert into auth.users values ('00000000-0000-0000-0000-0000000000c1','sup@example.com'); set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1"}', false); select accept_invitations();
select t.ok('member gets the role dashboard', (my_role_dashboard(:'org')->'order'->>0) = 'quick');
update orgs set invoice_settings = '{"template":"minimal"}' where id = :'org';
select t.ok('member without settings permission cannot change the design', (select invoice_settings->>'template' from orgs where id = :'org') = 'modern');
select t.fails('member cannot set role dashboards', format($q$select set_role_dashboard(%L, '{}')$q$, :'r1'), 'not allowed');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000bb"}', false);
select create_org('شركة أخرى', null) as org2 \gset
select t.fails('other company cannot set our role dashboard', format($q$select set_role_dashboard(%L, '{}')$q$, :'r1'), 'not allowed');
select t.ok('other company sees no role dashboard of ours', my_role_dashboard(:'org') is null);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa"}', false);
select set_role_dashboard(:'r1', null);
select t.ok('owner clears the role dashboard', (select dashboard from roles where id = :'r1') is null and my_role_dashboard(:'org') is null);
reset role;
select (case when ok then 'PASS ' else 'FAIL ' end) || name || case when not ok then '  [' || info || ']' else '' end as result from t.results order by n;
select count(*) filter (where ok) || ' / ' || count(*) || ' passed (design & dashboards)' as summary from t.results;
