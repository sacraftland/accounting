"""End-to-end test of the projects module (types, templates & copies, materials plan / issue / return,
tasks with workers & timeline, timesheets & labor posting, planned-vs-actual) against the REAL schema.
Run: python3 tests/e2e_projects.py"""
import http.server, threading, functools, pathlib, subprocess, re, time, sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
DB, PORT = 'e2edb', 8790
def sh(cmd, **kw): return subprocess.run(cmd, shell=True, check=True, capture_output=True, text=True, **kw)
def sql(q): return sh(f"runuser -u postgres -- psql -X -q -t -A -d {DB}", input=q).stdout.strip()

subprocess.run('pg_ctlcluster 16 main start', shell=True, capture_output=True)
subprocess.run("pkill -f 'pgrest_shim.py'", shell=True); time.sleep(0.3)
sh(f"runuser -u postgres -- dropdb --if-exists {DB}"); sh(f"runuser -u postgres -- createdb {DB}")
sh(f"runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d {DB} -f {ROOT}/tests/supabase_sim.sql -f {ROOT}/supabase/setup.sql")
sql("insert into platform_admins values ('sa.craft.land@gmail.com');")
shim = subprocess.Popen([sys.executable, str(ROOT / 'tests' / 'pgrest_shim.py'), str(PORT), DB], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
H = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / 'app'))
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8766), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = 'http://127.0.0.1:8766/index.html'
FAKE = (ROOT / 'tests' / 'fake_supabase.js').read_text()
CFG = "localStorage.setItem('daftar-backend', JSON.stringify({url:'https://abcd.supabase.co', key:'anon-key-anon-key-anon-key-anon-key-1234'}));"
SHOTS = ROOT / 'clone-screens'; SHOTS.mkdir(exist_ok=True)
results = []
def check(name, cond, extra=''):
    results.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + name + (f'  [{extra}]' if extra and not cond else ''), flush=True)
one = sql

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 1360, 'height': 900}, locale='ar-SA')
    ctx.route(re.compile(r'.*supabase-js.*'), lambda r: r.fulfill(status=200, content_type='application/javascript', body=FAKE))
    ctx.route(re.compile(r'https://fonts\..*'), lambda r: r.fulfill(status=200, body=''))
    ctx.route(re.compile(r'.*/auth/v1/settings'), lambda r: r.fulfill(status=200, content_type='application/json', body='{"external":{"google":true}}'))
    ctx.add_init_script(CFG); pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: m.type == 'error' and errs.append(m.text))
    def settle():
        try: pg.wait_for_function("!document.querySelector('.loading-screen')", timeout=8000)
        except Exception: pass
    def go(h, wait=900): pg.goto(URL + h); pg.wait_for_timeout(wait); settle()
    def submit(wait=1200):
        pg.click('.drawer [type=submit]'); pg.wait_for_timeout(wait)
        try: pg.wait_for_function("!document.querySelector('.drawer') || document.querySelector('.drawer [data-err]')?.textContent", timeout=6000)
        except Exception: pass
        settle()
    def err(): return pg.inner_text('.drawer [data-err]') if pg.locator('.drawer [data-err]').count() else ''
    def main(): return pg.inner_text('#main')
    def shot(n): pg.screenshot(path=str(SHOTS / f'proj-{n}.png'), full_page=True)

    go('#/signup'); pg.fill('#f-email', 'sa.craft.land@gmail.com'); pg.fill('#f-pw', 'goodpass1'); pg.click('#authf [type=submit]'); pg.wait_for_timeout(1200)
    pg.fill('#f-name_ar', 'كرافت لاند'); pg.fill('#f-vat_number', '300000000000003'); pg.fill('#f-city', 'الرياض'); pg.click('#orgf [type=submit]'); pg.wait_for_timeout(2500)
    org = one("select id from orgs"); owner = one("select user_id from members limit 1"); w1 = one("select id from warehouses limit 1")
    sql(f"""select set_config('request.jwt.claims', json_build_object('sub', '{owner}')::text, false);
      insert into parties (org_id, kind, name, vat_number) values ('{org}', 'customer', 'مؤسسة البر', '311111111111113');
      insert into items (org_id, kind, name_ar, sku, unit) values ('{org}', 'raw_material', 'حديد مربع', 'ST', 'متر'), ('{org}', 'raw_material', 'لوح ساندوتش', 'SP', 'لوح');
      insert into items (org_id, kind, name_ar, sku, sale_price) values ('{org}', 'product', 'كرفان 6 متر', 'CV6', 4500000);
      with d as (insert into stock_docs (org_id, kind, to_warehouse_id) values ('{org}', 'opening', '{w1}') returning id)
      insert into stock_doc_lines (stock_doc_id, line_no, item_id, qty, unit_cost) select d.id, row_number() over (), i.id, case i.sku when 'ST' then 100 else 50 end, case i.sku when 'ST' then 4000 else 15000 end from d, items i where i.kind = 'raw_material';
      select post_stock_doc(id) from stock_docs where status = 'draft';
      insert into employees (org_id, full_name, job_title, is_saudi, hire_date, basic_salary) values ('{org}', 'محمد اللحام', 'فني لحام', false, '2024-01-01', 360000);
      insert into employees (org_id, full_name, job_title, is_saudi, hire_date, basic_salary, hourly_rate) values ('{org}', 'سالم الدهان', 'دهان', false, '2024-01-01', 300000, 2500);
      with b as (insert into boms (org_id, item_id, output_qty) select '{org}', id, 1 from items where sku = 'CV6' returning id)
      insert into bom_lines (bom_id, org_id, line_no, item_id, qty, waste_pct) select b.id, '{org}', row_number() over (), i.id, case i.sku when 'ST' then 20 else 8 end, case i.sku when 'ST' then 10 else 0 end from b, items i where i.kind = 'raw_material';""")
    cust = one("select id from parties where name='مؤسسة البر'"); st = one("select id from items where sku='ST'"); spn = one("select id from items where sku='SP'")
    e1 = one("select id from employees where full_name='محمد اللحام'"); e2 = one("select id from employees where full_name='سالم الدهان'")

    # ---------- employee hourly-cost option ----------
    go('#/employees', 1200); pg.click(f'[data-edit="{e1}"]'); pg.wait_for_timeout(500)
    check('employee form: automatic hourly cost shown', '15.00' in pg.inner_text('.drawer #ratehint'), pg.inner_text('.drawer #ratehint') if pg.locator('.drawer #ratehint').count() else 'no hint')
    pg.select_option('.drawer #f-rate_mode', 'manual'); pg.fill('.drawer #f-hourly_rate', '18'); submit()
    check('manual hourly cost saved on employee', one(f"select hourly_rate from employees where id='{e1}'") == '1800', err())

    # ---------- new customer project ----------
    go('#/projects'); pg.click('#newp'); pg.wait_for_timeout(400)
    check('project types to choose from', pg.locator('.drawer .ptype').count() == 4)
    pg.fill('.drawer #f-name', 'كرفان 8 متر — مؤسسة البر'); pg.select_option('.drawer #f-party_id', cust); pg.fill('.drawer #f-contract_value', '60000')
    pg.fill('.drawer #f-start_date', '2026-11-01'); pg.fill('.drawer #f-due_date', '2026-11-30'); submit(1800)
    p1 = one("select id from cost_centers where code='P-001'")
    check('customer project created with type, customer, dates', one(f"select project_type||':'||(party_id is not null)||':'||due_date from cost_centers where id='{p1}'") == 'customer:true:2026-11-30' and f'#/projects/{p1}' in pg.url, err() or pg.url)
    check('project page tabs', all(t in main() for t in ['نظرة عامة', 'المهام', 'المواد', 'العمالة والساعات', 'المستندات']))

    # ---------- tasks: standard phases, assign workers ----------
    go(f'#/projects/{p1}?tab=tasks'); pg.click('#tstd'); pg.wait_for_timeout(3500); settle()
    check('standard caravan phases added (8 tasks, dated)', one(f"select count(*) from tasks where cost_center_id='{p1}' and start_date is not null") == '8', one(f"select count(*) from tasks where cost_center_id='{p1}'"))
    check('timeline bars drawn', pg.locator('#ptab .gantt i').count() == 8)
    pg.locator('#ptab tr[data-t]', has_text='لحام الشاسيه').click(); pg.wait_for_timeout(400)
    pg.check(f'.drawer [name="w_{e1}"]'); pg.fill('.drawer #f-est_hours', '40'); submit()
    pg.locator('#ptab tr[data-t]', has_text='الدهان').first.click(); pg.wait_for_timeout(400)
    pg.check(f'.drawer [name="w_{e2}"]'); pg.check(f'.drawer [name="w_{e1}"]'); submit()
    check('workers assigned to tasks', one(f"select array_length(employee_ids,1) from tasks where cost_center_id='{p1}' and title='الدهان'") == '2' and 'محمد اللحام' in main(), err())
    pg.locator('#ptab tr[data-t]', has_text='تمديدات الكهرباء').click(); pg.wait_for_timeout(400)
    pg.click('.drawer #wnewb'); pg.fill('.drawer #f-wn_name', 'عبدالله الكهربائي'); pg.fill('.drawer #f-wn_job', 'كهربائي'); pg.fill('.drawer #f-wn_sal', '4800'); pg.click('.drawer #wnadd'); pg.wait_for_timeout(1500)
    e3 = one("select id from employees where full_name='عبدالله الكهربائي'")
    check('worker added from inside the task (auto rate 20.00/h) and pre-ticked', e3 != '' and pg.is_checked(f'.drawer [name="w_{e3}"]') and one(f"select basic_salary from employees where id='{e3}'") == '480000', pg.inner_text('.drawer #wnerr'))
    submit()
    check('task saved with the new worker', one(f"select '{e3}' = any(employee_ids) from tasks where cost_center_id='{p1}' and title like 'تمديدات%'") == 't', err())
    pg.locator('#ptab [data-done]').first.check(); pg.wait_for_timeout(1500)
    check('tick task done', one(f"select count(*) from tasks where cost_center_id='{p1}' and status='done'") == '1')

    # ---------- materials: plan from BOM, issue, return ----------
    go(f'#/projects/{p1}?tab=materials'); pg.click('#mbom'); pg.wait_for_timeout(500); submit(2000)
    check('plan from BOM incl. waste (steel 22, panels 8)', one(f"select string_agg(planned_qty::numeric(10,2)::text, ',' order by planned_qty desc) from project_materials where cost_center_id='{p1}'") == '22.00,8.00')
    pg.click('#miss'); pg.wait_for_timeout(600)
    check('issue drawer prefilled with remaining plan', pg.locator('.drawer #mvl [data-i]').count() == 2)
    pg.locator('.drawer #mvl [data-i]').first.locator('[data-k=qty]').fill('25'); submit(2200)
    check('materials issued & charged to project (25×40 + 8×150 = 2,200)', one(f"select cogs from project_pl('{org}', '2026-01-01', '2026-12-31') where cost_center_id='{p1}'") == '220000', err())
    check('over-plan flagged', '⚠' in main())
    pg.click('#mret'); pg.wait_for_timeout(600)
    pg.locator('.drawer #mvl [data-i]').nth(1).locator('[data-x]').click(); pg.locator('.drawer #mvl [data-i]').first.locator('[data-k=qty]').fill('3'); submit(2200)
    check('surplus returned (cost 2,080, steel stock 78)', one(f"select cogs from project_pl('{org}', '2026-01-01', '2026-12-31') where cost_center_id='{p1}'") == '208000'
      and one(f"select sum(qty)::int from stock_moves where item_id='{st}'") == '78', err())
    shot('materials')

    # ---------- labor: team hours, manual override, post ----------
    go(f'#/projects/{p1}?tab=labor')
    tr1 = pg.locator(f'#tsf tr[data-w="{e1}"]'); tr2 = pg.locator(f'#tsf tr[data-w="{e2}"]')
    tr1.locator('[data-k=h]').fill('8'); tr2.locator('[data-k=h]').fill('6'); tr2.locator('[data-k=r]').fill('30'); pg.dispatch_event('#tsf [data-k=h]', 'input')
    check('team entry shows live total', '14' in pg.inner_text('#tstot'), pg.inner_text('#tstot'))
    pg.click('#tsf [type=submit]'); pg.wait_for_timeout(1800); settle()
    check('hours saved: 8×18 (employee manual) + 6×30 (entry override) = 324', one(f"select sum(amount) from timesheets where cost_center_id='{p1}'") == '32400', one(f"select string_agg(rate||'x'||hours, ',') from timesheets"))
    pg.click('#tspost'); pg.wait_for_timeout(1800); settle()
    check('labor posted to project', one(f"select expenses from project_pl('{org}', '2026-01-01', '2026-12-31') where cost_center_id='{p1}'") == '32400' and one("select count(*) from timesheets where status='posted'") == '2')
    check('company salaries net zero after allocation', one(f"select coalesce(sum(debit-credit),0) from journal_lines l join accounts a on a.id=l.account_id where a.system_key='salaries'") == '0')
    shot('labor')

    # ---------- overview: planned vs actual ----------
    go(f'#/projects/{p1}', 1500)
    t = main()
    check('overview: planned vs actual (materials 2,080, labor 324)', 'المخطط مقابل الفعلي' in t and '2,080.00' in t and '324.00' in t, t[:800])
    shot('overview')

    # ---------- template & copy ----------
    pg.click('#ptpl'); pg.wait_for_timeout(400); submit(2000)
    tpl = one("select id from cost_centers where is_template")
    check('saved as template (8 tasks, 2 materials, no customer)', one(f"select count(*) from tasks where cost_center_id='{tpl}'") == '8' and one(f"select count(*) from project_materials where cost_center_id='{tpl}'") == '2'
      and one(f"select party_id is null from cost_centers where id='{tpl}'") == 't')
    go('#/projects?f=templates')
    check('templates tab lists it', 'قالب: كرفان 8 متر' in main())
    go('#/projects'); pg.click('#newp'); pg.wait_for_timeout(400); pg.click('.drawer .ptype:has(input[value=copy])'); pg.wait_for_timeout(200)
    pg.select_option('.drawer #f-src', tpl); pg.fill('.drawer #f-name', 'كرفان 8 متر — عميل جديد'); pg.select_option('.drawer #f-party_id', cust); pg.fill('.drawer #f-start_date', '2026-12-01'); submit(2000)
    p2 = one("select id from cost_centers where name='كرفان 8 متر — عميل جديد'")
    check('new project from template: tasks with workers, materials, no costs', one(f"select count(*) from tasks where cost_center_id='{p2}'") == '8'
      and one(f"select array_length(employee_ids,1) from tasks where cost_center_id='{p2}' and title='الدهان'") == '2' and one(f"select count(*) from project_materials where cost_center_id='{p2}'") == '2'
      and one(f"select count(*) from timesheets where cost_center_id='{p2}'") == '0', err() or str(p2))

    # ---------- production project from BOM ----------
    go('#/projects'); pg.click('#newp'); pg.wait_for_timeout(400); pg.click('.drawer .ptype:has(input[value=production])'); pg.wait_for_timeout(200)
    cv6 = one("select id from items where sku='CV6'"); pg.select_option('.drawer #f-product_item_id', cv6); pg.fill('.drawer #f-production_qty', '3'); submit(2200)
    p3 = one("select id from cost_centers where project_type='production'")
    check('production project: materials planned from BOM × 3', one(f"select string_agg(planned_qty::numeric(10,2)::text, ',' order by planned_qty desc) from project_materials where cost_center_id='{p3}'") == '66.00,24.00', err())
    check('production project offers a manufacturing order', pg.locator(f'a[href*="#/mfg/new?cc={p3}"]').count() >= 1)
    pg.locator(f'a[href*="#/mfg/new?cc={p3}"]').first.click(); pg.wait_for_timeout(2000); settle()
    check('mfg order prefilled (product, qty 3, project)', pg.input_value('#f-qty') == '3' and pg.input_value('#f-cost_center_id') == p3, pg.url)

    go('#/projects'); pg.click('#newp'); pg.wait_for_timeout(400); pg.click('.drawer .ptype:has(input[value=production])'); pg.wait_for_timeout(200)
    pg.select_option('.drawer #f-product_item_id', '__new'); pg.wait_for_timeout(200)
    check('new-product fields appear', pg.locator('.drawer #pf-newprod').is_visible())
    pg.fill('.drawer #f-new_product', 'كرفان سحب 2.4 × 5.7'); pg.fill('.drawer #f-new_price', '38000'); pg.fill('.drawer #f-name', 'تصنيع كرفان سحب'); pg.fill('.drawer #f-production_qty', '2'); submit(2200)
    check('production project with a product created on the spot', one("select count(*) from cost_centers c join items i on i.id=c.product_item_id where i.name_ar='كرفان سحب 2.4 × 5.7' and i.kind='product' and i.sale_price=3800000 and c.production_qty=2") == '1', err())

    # ---------- internal cost center ----------
    go('#/projects'); pg.click('#newp'); pg.wait_for_timeout(400); pg.click('.drawer .ptype:has(input[value=internal])'); pg.wait_for_timeout(200)
    check('internal code suggestion', pg.input_value('.drawer #f-code') == 'CC-001')
    pg.fill('.drawer #f-name', 'الورشة'); submit(1500)
    check('internal cost center saved', one("select is_project from cost_centers where code='CC-001'") == 'f')
    go('#/projects?f=internal'); check('internal tab lists it', 'الورشة' in main())

    # ---------- purchase for project & invoice prefill ----------
    go(f'#/projects/{p1}?tab=materials'); pg.click('#mbuy'); pg.wait_for_timeout(2000); settle()
    check('buy-for-project opens a bill tagged with the project', '#/bills/new' in pg.url and pg.input_value('#f-cost_center_id') == p1, pg.url)
    go(f'#/projects/{p1}?tab=docs'); pg.click('[data-go="#/invoices/new"]'); pg.wait_for_timeout(2000); settle()
    check('invoice from project: customer & project prefilled', pg.input_value('#f-party') == cust and pg.input_value('#f-cost_center_id') == p1)
    go('#/projects', 1500); shot('list')
    check('projects list shows types and progress', 'مشروع لعميل' in main() and '1/8' in main(), main()[:600])

    check('books balance', one("select sum(debit) = sum(credit) from journal_lines") == 't')
    check('no page errors', not errs, ' | '.join(errs[:3]))
    b.close()

shim.terminate()
print(f'\n{sum(results)}/{len(results)} passed')
sys.exit(0 if all(results) else 1)
