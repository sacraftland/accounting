-- Feasibility studies (migration 14), as the browser roles.
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
insert into items (org_id, kind, name_ar, sale_price) values (:'org', 'product', 'كرفان 6 متر', 4500000) returning id as item \gset
insert into cost_centers (org_id, code, name, project_type, product_item_id, production_qty) values (:'org', 'P-001', 'دفعة كرفانات', 'production', :'item', 2) returning id as cc \gset
insert into feasibility_studies (org_id, name, kind, inputs, created_by) values (:'org', 'كرفان 8 متر', 'product', '{"price":{"v":5000000,"src":"manual"}}', '00000000-0000-0000-0000-0000000000bb') returning id as fs \gset
select t.ok('owner creates a study; created_by is forced to the caller', (select created_by from feasibility_studies where id = :'fs') = '00000000-0000-0000-0000-0000000000aa');
update feasibility_studies set ai_notes = 'تحليل السوق', inputs = inputs || '{"volume":{"v":3,"src":"ai"}}' where id = :'fs';
select t.ok('owner saves inputs & AI notes', (select inputs->'volume'->>'src' from feasibility_studies where id = :'fs') = 'ai' and (select ai_notes from feasibility_studies where id = :'fs') = 'تحليل السوق');
select t.fails('inputs must be an object', format($q$update feasibility_studies set inputs = '[]' where id = %L$q$, :'fs'), 'check');
select t.fails('kind is checked', format($q$insert into feasibility_studies (org_id, name, kind) values (%L, 'x', 'magic')$q$, :'org'), 'check');
select t.ok('project history returns the project', (select name from project_cost_history(:'org', :'cc')) = 'دفعة كرفانات' and (select qty from project_cost_history(:'org', :'cc')) = 2);
select t.ok('item history returns list price', (select list_price from item_history(:'org', :'item')) = 4500000);
select t.ok('overheads list runs', (select count(*) from overhead_history(:'org')) >= 0);
select save_role(:'org', null, 'مشاهد الجدوى', '{"feasibility":["view"]}') as r1 \gset
select save_role(:'org', null, 'المبيعات', '{"sales":["view","create"]}') as r2 \gset
select invite_member(:'org', 'viewer@example.com', :'r1');
select invite_member(:'org', 'sales@example.com', :'r2');
reset role; insert into auth.users values ('00000000-0000-0000-0000-0000000000c1','viewer@example.com'), ('00000000-0000-0000-0000-0000000000c2','sales@example.com'); set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1"}', false); select accept_invitations();
select t.ok('viewer sees the study', (select count(*) from feasibility_studies where org_id = :'org') = 1);
update feasibility_studies set name = 'مخترق' where id = :'fs';
select t.ok('viewer cannot edit', (select name from feasibility_studies where id = :'fs') = 'كرفان 8 متر');
select t.fails('viewer cannot create', format($q$insert into feasibility_studies (org_id, name) values (%L, 'x')$q$, :'org'), 'row-level|policy');
select t.ok('viewer can read history', (select qty from project_cost_history(:'org', :'cc')) = 2);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c2"}', false); select accept_invitations();
select t.ok('member without the permission sees nothing', (select count(*) from feasibility_studies where org_id = :'org') = 0);
select t.fails('member without the permission cannot read project costs', format($q$select * from project_cost_history(%L, %L)$q$, :'org', :'cc'), 'not allowed');
select t.fails('member without the permission cannot read overheads', format($q$select * from overhead_history(%L)$q$, :'org'), 'not allowed');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000bb"}', false);
select create_org('شركة أخرى', null) as org2 \gset
select t.ok('other company sees nothing', (select count(*) from feasibility_studies) = 0);
select t.fails('other company cannot read our item', format($q$select * from item_history(%L, %L)$q$, :'org', :'item'), 'not allowed');
select t.fails('other company cannot pass our cost center through its own org', format($q$select * from project_cost_history(%L, %L)$q$, :'org2', :'cc'), 'not allowed');
delete from feasibility_studies where id = :'fs';
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa"}', false);
select t.ok('other company cannot delete our study', (select count(*) from feasibility_studies where id = :'fs') = 1);
delete from feasibility_studies where id = :'fs';
select t.ok('owner deletes the study', (select count(*) from feasibility_studies where id = :'fs') = 0);
reset role;
set role anon;
select t.fails('anon has no access', 'select * from feasibility_studies', 'permission denied');
reset role;
select (case when ok then 'PASS ' else 'FAIL ' end) || name || case when not ok then '  [' || info || ']' else '' end as result from t.results order by n;
select count(*) filter (where ok) || ' / ' || count(*) || ' passed (feasibility)' as summary from t.results;
