"""End-to-end test: full backup download, Excel export, the backup script download, restore as a new
company and in place of the current one, Excel import, and the report builder (templates, grouping,
pivot, filters, save, Excel export, AI definition). Run: python3 tests/e2e_backup.py"""
import http.server, threading, functools, pathlib, subprocess, re, time, sys, json, gzip, zipfile, io, py_compile, tempfile
from playwright.sync_api import sync_playwright
import openpyxl

ROOT = pathlib.Path(__file__).resolve().parent.parent
DB, PORT = 'e2edb', 8790
def sh(cmd, **kw): return subprocess.run(cmd, shell=True, check=True, capture_output=True, text=True, **kw)
def sql(q): return sh(f"runuser -u postgres -- psql -X -q -t -A -v ON_ERROR_STOP=1 -d {DB}", input=q).stdout.strip()

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
TMP = pathlib.Path(tempfile.mkdtemp())
results = []
def check(name, cond, extra=''):
    results.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + name + (f'  [{extra}]' if extra and not cond else ''), flush=True)
one = sql

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 1360, 'height': 900}, locale='ar-SA', accept_downloads=True)
    ctx.route(re.compile(r'.*supabase-js.*'), lambda r: r.fulfill(status=200, content_type='application/javascript', body=FAKE))
    ctx.route(re.compile(r'https://fonts\..*'), lambda r: r.fulfill(status=200, body=''))
    ctx.route(re.compile(r'.*/auth/v1/settings'), lambda r: r.fulfill(status=200, content_type='application/json', body='{"external":{"google":true}}'))
    ctx.add_init_script(CFG); pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: m.type == 'error' and errs.append(m.text))
    def settle():
        try: pg.wait_for_function("!document.querySelector('.loading-screen')", timeout=10000)
        except Exception: pass
    def go(h, wait=900): pg.goto(URL + h); pg.wait_for_timeout(wait); settle()
    def submit(wait=1200):
        pg.click('.drawer [type=submit]'); pg.wait_for_timeout(wait)
        try: pg.wait_for_function("!document.querySelector('.drawer') || document.querySelector('.drawer [data-err]')?.textContent", timeout=6000)
        except Exception: pass
        settle()
    def main(): return pg.inner_text('#main')
    def shot(n): pg.screenshot(path=str(SHOTS / f'bk-{n}.png'), full_page=True)
    def download(sel):
        with pg.expect_download(timeout=20000) as d: pg.click(sel)
        path = TMP / d.value.suggested_filename; d.value.save_as(path); return path

    go('#/signup'); pg.fill('#f-email', 'sa.craft.land@gmail.com'); pg.fill('#f-pw', 'goodpass1'); pg.click('#authf [type=submit]'); pg.wait_for_timeout(1200)
    pg.fill('#f-name_ar', 'كرافت لاند'); pg.fill('#f-vat_number', '300000000000003'); pg.fill('#f-city', 'الرياض'); pg.click('#orgf [type=submit]'); pg.wait_for_timeout(2500)
    org = one("select id from orgs"); owner = one("select user_id from members limit 1")
    # real posted data: a purchase, two sales to two customers, a payment
    sql(f"""select set_config('request.jwt.claims', json_build_object('sub', '{owner}')::text, false);
      insert into parties (org_id, kind, name, vat_number, city, street, building_no, postal_code) values ('{org}', 'customer', 'مؤسسة البر', '311111111111113', 'الرياض', 'ش', '1', '12345'), ('{org}', 'customer', 'شركة الرحلات', '311111111111123', 'جدة', 'ش', '2', '22345');
      insert into parties (org_id, kind, name, vat_number) values ('{org}', 'supplier', 'مصنع الحديد', '322222222222223');
      insert into items (org_id, kind, name_ar, sku, sale_price) values ('{org}', 'product', 'كرفان 6 متر', 'CV6', 4500000), ('{org}', 'product', 'كرفان 8 متر', 'CV8', 6000000);
      do $$ declare o uuid := '{org}'; w uuid; br uuid; d uuid; begin
        select id, branch_id into w, br from warehouses where org_id = o limit 1;
        insert into documents (org_id, branch_id, warehouse_id, kind, party_id, issue_date) values (o, br, w, 'purchase_bill', (select id from parties where name = 'مصنع الحديد'), current_date - 6) returning id into d;
        insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate) values
          (d, o, 1, (select id from items where sku = 'CV6'), 'x', 4, 3000000, 'S', 15), (d, o, 2, (select id from items where sku = 'CV8'), 'x', 2, 4000000, 'S', 15);
        perform post_purchase_bill(d);
        insert into documents (org_id, branch_id, warehouse_id, kind, party_id, issue_date) values (o, br, w, 'tax_invoice', (select id from parties where name = 'مؤسسة البر'), current_date - 3) returning id into d;
        insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate) values (d, o, 1, (select id from items where sku = 'CV6'), 'x', 2, 4500000, 'S', 15);
        perform post_sales_invoice(d);
        insert into documents (org_id, branch_id, warehouse_id, kind, party_id, issue_date) values (o, br, w, 'tax_invoice', (select id from parties where name = 'شركة الرحلات'), current_date - 1) returning id into d;
        insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate) values
          (d, o, 1, (select id from items where sku = 'CV6'), 'x', 1, 4500000, 'S', 15), (d, o, 2, (select id from items where sku = 'CV8'), 'x', 1, 6000000, 'S', 15);
        perform post_sales_invoice(d);
      end $$;""")
    jl = int(one(f"select count(*) from journal_lines where org_id='{org}'"))

    # ---------- backup page ----------
    go('#/backup', 1200)
    check('nav has backup; page shows status', 'النسخ الاحتياطي' in pg.inner_text('.nav') and 'لم يُعدّ بعد' in main(), main()[:200])
    f = download('#bknow'); pg.wait_for_timeout(500)
    bk = json.loads(gzip.decompress(f.read_bytes()))
    check('full backup downloads as .json.gz with every table', f.name.endswith('.json.gz') and bk['format'] == 'craftland-backup' and len(bk['tables']['journal_lines']) == jl and len(bk['tables']) >= 40, (f.name, len(bk.get('tables', {}))))
    check('download is logged', one(f"select count(*) from backup_log where org_id='{org}' and source='app'") == '1')
    x = download('#bkxl'); pg.wait_for_timeout(300)
    wb = openpyxl.load_workbook(x)
    check('Excel export opens with one sheet per table', 'اقرأني' in wb.sheetnames and 'شجرة الحسابات' in wb.sheetnames and 'أسطر القيود' in wb.sheetnames and wb['شجرة الحسابات'].sheet_view.rightToLeft, wb.sheetnames[:6])
    check('Excel keeps numbers as numbers', any(isinstance(c.value, (int, float)) for row in wb['أسطر القيود'].iter_rows(min_row=2) for c in row))
    py = download('#bkpy'); src = py.read_text(encoding='utf-8')
    check('backup program carries this company', "URL = \"https://abcd.supabase.co\"" in src and f'ORG = "{org}"' in src and 'كرافت لاند' in src and 'service_role' not in src.replace('never put a secret / service key here', ''), src[:400])
    py_compile.compile(str(py), doraise=True); check('backup program is valid Python', True)
    pg.click('#bkrole'); pg.wait_for_timeout(1200); settle()
    check('backup-only role created', one(f"select permissions::text from roles where org_id='{org}' and name='النسخ الاحتياطي'") == '{"backup": ["view"]}' and 'موجود ✓' in main())
    shot('page')

    # ---------- restore as a new company ----------
    pg.set_input_files('#rsf', str(f)); pg.wait_for_timeout(1200)
    pv = pg.inner_text('#rsprev')
    check('restore preview: company, date and counts', 'كرافت لاند' in pv and 'القيود' in pv and 'سجل' in pv, pv[:300])
    pg.fill('#f-rsname', 'كرافت لاند — نسخة اختبار'); pg.click('#rsgo'); pg.wait_for_timeout(3000); settle()
    org2 = one("select id from orgs where name_ar = 'كرافت لاند — نسخة اختبار'")
    check('restored as a separate company and switched to it', bool(org2) and pg.evaluate("document.querySelector('#orgsel')?.selectedOptions[0]?.text") == 'كرافت لاند — نسخة اختبار')
    check('restored company has the same data', int(one(f"select count(*) from journal_lines where org_id='{org2}'")) == jl and one(f"select count(*) from documents where org_id='{org2}' and status='posted'") == '3')
    check('original untouched', one(f"select name_ar from orgs where id='{org}'") == 'كرافت لاند' and int(one(f"select count(*) from journal_lines where org_id='{org}'")) == jl)

    # ---------- restore in place of the current company ----------
    pg.evaluate(f"localStorage.setItem('daftar-org', '{org}'); location.hash = '#/backup'"); pg.reload(); pg.wait_for_timeout(1500); settle()
    check('switched back to the original company', pg.evaluate("document.querySelector('#orgsel')?.selectedOptions[0]?.text") == 'كرافت لاند')
    pg.set_input_files('#rsf', str(f)); pg.wait_for_timeout(1200)
    pg.check('[name=rsm][value=replace]'); pg.wait_for_timeout(200)
    pg.fill('#f-rsok', 'اسم غلط'); pg.click('#rsgo'); pg.wait_for_timeout(500)
    check('replace needs the current company name typed', 'اكتب اسم الشركة الحالية' in pg.inner_text('#rserr'))
    pg.fill('#f-rsok', 'كرافت لاند'); pg.click('#rsgo'); pg.wait_for_timeout(3000); settle()
    rserr = pg.inner_text('#rserr') if pg.locator('#rserr').count() else ''
    org3 = one(f"select id from orgs where id not in ('{org}', '{org2}')")
    check('replace: restored company active, old one archived', bool(org3) and one(f"select name_ar from orgs where id='{org}'").startswith('كرافت لاند — أرشيف') and one(f"select name_ar from orgs where id='{org3}'") == 'كرافت لاند', rserr)
    check('restore logged', one(f"select count(*) from backup_log where org_id='{org3}' and source='restore'") == '1')

    # ---------- Excel import (deflate-compressed .xlsx made by Excel-like tools) ----------
    w = openpyxl.Workbook(); s = w.active; s.append(['الاسم', 'الجوال', 'المدينة']); s.append(['مؤسسة الواحة', '0500000001', 'الدمام']); s.append(['شركة النخبة', '0500000002', 'أبها']); w.save(TMP / 'customers.xlsx')
    go('#/import?t=customers', 1000); pg.set_input_files('#csvf', str(TMP / 'customers.xlsx')); pg.wait_for_timeout(1200)
    check('import page reads .xlsx directly', 'مؤسسة الواحة' in pg.inner_text('#prev') and 'شركة النخبة' in pg.inner_text('#prev'), pg.inner_text('#prev')[:300])

    # ---------- report builder: the engine ----------
    eng = pg.evaluate("""() => { const { rbCompute, rbClean } = window.__rb;
      const rows = [{party:'أ', month:'2026-01', net: 1000, profit: 300, item:'x'}, {party:'أ', month:'2026-02', net: 500, profit: 100, item:'y'}, {party:'ب', month:'2026-01', net: 2000, profit: -50, item:'x'}];
      const g = rbCompute(rbClean({ds:'sales_lines', group:['party'], measures:[{f:'net',agg:'sum'},{f:'profit',agg:'avg'},{f:'*',agg:'count'}], sort:{f:'net',dir:'desc'}}), rows);
      const pv = rbCompute(rbClean({ds:'sales_lines', group:['party'], pivot:'month', measures:[{f:'net',agg:'sum'}]}), rows);
      const fl = rbCompute(rbClean({ds:'sales_lines', columns:['party','net'], filters:[{f:'net', op:'gt', v:'9'}]}), rows);
      const bad = rbClean({ds:'nope', group:['secret'], measures:[{f:'party', agg:'sum'}], filters:[{f:'x', op:'drop'}]});
      return { g: g.rows, gt: g.total, pv: pv.rows, pvc: pv.cols.map(c => c.k), fl: fl.rows, bad }; }""")
    check('group: sum, average, count, sorted', eng['g'] == [['ب', 2000, -50, 1], ['أ', 1500, 200, 2]], eng['g'])
    check('totals skip averages', eng['gt'][1] == 3500 and eng['gt'][2] is None and eng['gt'][3] == 3, eng['gt'])
    check('pivot by month', eng['pvc'] == ['party', 'pv:2026-01', 'pv:2026-02', 'sum:net'] and ['أ', 1000, 500, 1500] in eng['pv'], eng)
    check('money filters are typed in riyals', eng['fl'] == [['أ', 1000], ['ب', 2000]], eng['fl'])
    check('unknown source / fields are cleaned away', eng['bad']['ds'] == 'sales_lines' and eng['bad']['group'] == [] and eng['bad']['filters'] == [] and eng['bad']['measures'] == [], eng['bad'])

    # ---------- report builder: the page ----------
    go('#/report-builder', 1000)
    check('nav has the report builder; templates listed', 'منشئ التقارير' in pg.inner_text('.nav') and 'ربحية الأصناف' in main() and 'الفواتير المتأخرة' in main())
    pg.click('text=ربحية الأصناف'); pg.wait_for_timeout(1500); settle()
    out = pg.inner_text('#rbout')
    check('template runs on real data: profit per item', 'كرفان 6 متر' in out and 'كرفان 8 متر' in out and 'الإجمالي' in out, out[:500])
    # CV6: sold 3 × 45,000 = 135,000, cost 3 × 30,000 = 90,000 → profit 45,000 ; CV8: 60,000 − 40,000 = 20,000
    check('figures are right (net, cost, profit)', '135,000.00' in out and '90,000.00' in out and '45,000.00' in out and '20,000.00' in out, out[:600])
    check('bar chart drawn for the grouped result, by amount', pg.locator('#rbout .rb-bar').count() == 2 and 'الصافي' in pg.inner_text('#rbout figcaption'))
    pg.select_option('#rbg0', 'party'); pg.wait_for_timeout(500)
    out = pg.inner_text('#rbout')
    check('regroup by customer', 'مؤسسة البر' in out and 'شركة الرحلات' in out, out[:300])
    pg.click('#rbfadd'); pg.wait_for_timeout(200); pg.select_option('[data-ff="0"]', 'party_city'); pg.wait_for_timeout(200); pg.fill('[data-fv="0"]', 'جدة'); pg.wait_for_timeout(600)
    out = pg.inner_text('#rbout')
    check('filter narrows the rows', 'شركة الرحلات' in out and 'مؤسسة البر' not in out, out[:300])
    pg.fill('#f-rbname', 'مبيعات جدة'); pg.click('#rbsave'); pg.wait_for_timeout(1500); settle()
    rid = one(f"select id from saved_reports where name='مبيعات جدة'")
    check('report saved and reopened by its link', bool(rid) and f'#/report-builder/{rid}' in pg.url)
    d = json.loads(one(f"select definition from saved_reports where id='{rid}'"))
    check('saved definition holds grouping and the filter', d['group'] == ['party'] and d['filters'][0] == {'f': 'party_city', 'op': 'eq', 'v': 'جدة'}, d)
    x = download('#rbxl')
    ws = openpyxl.load_workbook(x).active; vals = [[c.value for c in r] for r in ws.iter_rows()]
    check('Excel export: riyals as numbers with a totals row', vals[0][0] == 'العميل' and vals[1][0] == 'شركة الرحلات' and 105000 in vals[1] and vals[-1][0] == 'الإجمالي', vals)
    pg.check('#rbpin'); pg.wait_for_timeout(800)
    check('pin saved', one(f"select pinned from saved_reports where id='{rid}'") == 't')
    shot('builder')

    # pivot by month through the page
    go('#/report-builder/new?t=2', 1500)
    check('pivot template: a column per month plus total', pg.locator('#rbtbl thead th').count() >= 3 and 'الإجمالي' in pg.inner_text('#rbtbl thead'), pg.inner_text('#rbtbl thead') if pg.locator('#rbtbl').count() else 'no table')

    # AI writes the definition
    pg.click('#rbai'); pg.wait_for_timeout(300); pg.fill('.drawer #rbq', 'أبي إجمالي المشتريات لكل مورد'); pg.wait_for_timeout(200)
    pr = pg.input_value('.drawer #rbqp')
    check('AI prompt has the request and the field catalogue, no company data', 'لكل مورد' in pr and 'purchase_lines' in pr and '```json' in pr and 'مصنع الحديد' not in pr and 'كرافت لاند' not in pr)
    pg.click('.drawer [data-close]'); pg.wait_for_timeout(200)
    pg.click('#rbaiin'); pg.wait_for_timeout(300)
    pg.fill('.drawer #rbpaste', 'تفضل:\n```json\n{"name":"المشتريات حسب المورد","ds":"purchase_lines","period":"this-y","group":["party"],"measures":[{"f":"total","agg":"sum"},{"f":"hack","agg":"sum"}],"sort":{"f":"sum:total","dir":"desc"}}\n```'); submit(1500)
    out = pg.inner_text('#rbout')
    check('pasted definition builds the report (unknown fields dropped)', 'مصنع الحديد' in out and '230,000.00' in out and pg.input_value('#f-rbname') == 'المشتريات حسب المورد', out[:400])
    pg.click('#rbaiin'); pg.wait_for_timeout(300); pg.fill('.drawer #rbpaste', 'ما عندي'); pg.click('.drawer [type=submit]'); pg.wait_for_timeout(500)
    check('a reply without JSON is explained', 'ما قدرت أقرأ JSON' in pg.inner_text('.drawer [data-err]'))
    pg.click('.drawer [data-close]')

    go('#/report-builder', 1000)
    check('saved & pinned report listed', '★ مبيعات جدة' in main())
    check('no page errors', not errs, errs[:3])
    b.close()
shim.terminate()
print(f'{sum(results)}/{len(results)} passed')
sys.exit(0 if all(results) else 1)
