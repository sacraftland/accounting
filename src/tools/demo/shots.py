"""Seeds a demo company and captures every screen for the user guide / brochure.
Run: python3 tools/demo/shots.py [out_dir]"""
import http.server, threading, functools, pathlib, subprocess, re, time, sys, json
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/shots'); OUT.mkdir(parents=True, exist_ok=True)
DB, PORT = 'demodb', 8791
def sh(cmd, **kw): return subprocess.run(cmd, shell=True, check=True, capture_output=True, text=True, **kw)
def sql(q, *a): return sh(f"runuser -u postgres -- psql -X -q -t -A -v ON_ERROR_STOP=1 -d {DB} " + ' '.join(a), input=q).stdout.strip()

subprocess.run('pg_ctlcluster 16 main start', shell=True, capture_output=True)
sh(f"runuser -u postgres -- dropdb --if-exists {DB}"); sh(f"runuser -u postgres -- createdb {DB}")
sh(f"runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d {DB} -f {ROOT}/tests/supabase_sim.sql -f {ROOT}/supabase/setup.sql")
sql("insert into platform_admins values ('sa.craft.land@gmail.com');")
shim = subprocess.Popen([sys.executable, str(ROOT / 'tests' / 'pgrest_shim.py'), str(PORT), DB], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
subprocess.run([sys.executable, str(ROOT / 'app' / 'build.py')], check=True, capture_output=True)
H = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / 'app'))
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8767), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = 'http://127.0.0.1:8767/index.html'
FAKE = (ROOT / 'tests' / 'fake_supabase.js').read_text().replace('8790', str(PORT))
CFG = "localStorage.setItem('daftar-backend', JSON.stringify({url:'https://abcd.supabase.co', key:'anon-key-anon-key-anon-key-anon-key-1234'}));"
done = []

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, device_scale_factor=1.5, locale='ar-SA')
    ctx.route(re.compile(r'.*supabase-js.*'), lambda r: r.fulfill(status=200, content_type='application/javascript', body=FAKE))
    ctx.route(re.compile(r'https://fonts\..*'), lambda r: r.fulfill(status=200, body=''))
    ctx.route(re.compile(r'.*/auth/v1/settings'), lambda r: r.fulfill(status=200, content_type='application/json', body='{"external":{"google":true}}'))
    ctx.add_init_script(CFG); pg = ctx.new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    def settle(ms=900):
        pg.wait_for_timeout(ms)
        try: pg.wait_for_function("!document.querySelector('.loading-screen') && !document.querySelector('#main .loading')", timeout=8000)
        except Exception: pass
        pg.wait_for_timeout(250)
    def go(h, ms=900): pg.evaluate(f"location.hash = {json.dumps(h)}"); settle(ms)
    def shot(name, full=False, sel=None):
        pg.mouse.move(5, 895)
        path = OUT / f'{name}.png'
        if sel: pg.locator(sel).first.screenshot(path=str(path))
        else: pg.screenshot(path=str(path), full_page=full)
        done.append(name)
    def close_drawer():
        if pg.locator('.drawer [data-close]').count(): pg.click('.drawer [data-close]'); pg.wait_for_timeout(300)

    pg.goto(URL + '#/login'); settle(); shot('01-login')
    pg.goto(URL + '#/signup'); settle()
    pg.fill('#f-email', 'sa.craft.land@gmail.com'); pg.fill('#f-pw', 'goodpass1'); pg.click('#authf [type=submit]'); pg.wait_for_timeout(1200)
    pg.fill('#f-name_ar', 'كرافت لاند'); pg.fill('#f-vat_number', '300000000000003'); pg.fill('#f-city', 'الرياض'); pg.click('#orgf [type=submit]'); pg.wait_for_timeout(2500)
    org = sql("select id from orgs"); uid = sql("select user_id from members limit 1")
    sh(f"runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d {DB} -v org={org} -v uid={uid} -f {ROOT}/tools/demo/seed_demo.sql")
    import base64
    sql(f"update orgs set logo_path = 'data:image/png;base64,{base64.b64encode(open('/tmp/demo_logo.png','rb').read()).decode()}'")
    pg.reload(); settle(1500)

    go('#/dashboard', 1800); shot('02-dashboard'); shot('02b-dashboard-full', full=True)
    pg.click('#dcust'); pg.wait_for_timeout(600); shot('03-dashboard-customize'); close_drawer()
    for h, n in [('#/invoices', '10-invoices'), ('#/quotes', '11-quotes'), ('#/receipts', '13-receipts'), ('#/customers', '14-customers'), ('#/leads', '16-leads'),
                 ('#/credit-notes', '17-credit-notes'), ('#/delivery-notes', '17b-delivery'), ('#/card-settlement', '18-card-settle'),
                 ('#/bills', '20-bills'), ('#/purchase-orders', '21-po'), ('#/payments', '22-payments'), ('#/suppliers', '23-suppliers'),
                 ('#/expenses', '25-expenses'), ('#/custody', '26-custody'),
                 ('#/items', '30-items'), ('#/warehouses', '31-warehouses'), ('#/stock', '32-stock'), ('#/trips', '33-trips'), ('#/boms', '34-boms'), ('#/mfg', '35-mfg'),
                 ('#/journal', '40-journal'), ('#/accounts', '41-accounts'), ('#/trial-balance', '42-trial'), ('#/assets', '43-assets'),
                 ('#/reports/pl', '44-report-pl'), ('#/reports/bs', '45-report-bs'), ('#/reports/vat', '46-report-vat'), ('#/reports/aging', '47-report-aging'), ('#/reports/stock', '48-report-stock'),
                 ('#/employees', '50-employees'), ('#/payroll', '51-payroll'), ('#/leaves', '52-leaves'), ('#/attendance', '53-attendance'), ('#/evaluations', '54-evaluations'),
                 ('#/projects', '60-projects'), ('#/tasks', '65-tasks'), ('#/feasibility', '70-feasibility'), ('#/commitments', '75-commitments'),
                 ('#/branches', '80-branches'), ('#/import', '81-import'), ('#/users', '82-users'), ('#/backup', '83-backup'), ('#/appearance', '84-appearance'),
                 ('#/invoice-design', '85-invoice-design'), ('#/settings', '86-settings'), ('#/report-builder', '49-report-builder')]:
        go(h, 1200); shot(n)

    inv = sql("select id from documents where kind='tax_invoice' and status='posted' order by issue_date desc limit 1")
    go(f'#/invoices/{inv}', 1500); shot('12-invoice-view', full=True)
    go('#/invoices/new', 1200)
    try:
        pg.select_option('#f-party', label='منتجع الخيمة الذهبية'); pg.wait_for_timeout(400)
        pg.select_option('[data-k=item_id] >> nth=0', label=pg.evaluate("[...document.querySelector('[data-k=item_id]').options].find(o => o.text.includes('كرفان سحب 8'))?.text")); pg.wait_for_timeout(400)
        if pg.locator('#addl, [data-act=addline], button:has-text("إضافة سطر")').count(): pg.locator('#addl, [data-act=addline], button:has-text("إضافة سطر")').first.click(); pg.wait_for_timeout(300)
        pg.select_option('[data-k=item_id] >> nth=1', label=pg.evaluate("[...document.querySelectorAll('[data-k=item_id]')[1].options].find(o => o.text.includes('تركيب'))?.text")); pg.wait_for_timeout(400)
    except Exception as e: print('invoice form:', e)
    shot('12b-invoice-new')
    go('#/pos', 1500)
    try:
        for t in pg.locator('.pos-item, .pos-grid button').all()[:3]: t.click(); pg.wait_for_timeout(200)
    except Exception: pass
    shot('15-pos')
    c3 = sql("select id from parties where name='منتجع الخيمة الذهبية'")
    go(f'#/customers/{c3}', 1500); shot('14b-customer-statement')
    cc1 = sql("select id from cost_centers where code='P-101'")
    go(f'#/projects/{cc1}', 1500); shot('61-project-overview')
    for tab, n in [('tasks', '62-project-tasks'), ('materials', '63-project-materials'), ('labor', '64-project-labor'), ('docs', '64b-project-docs')]:
        go(f'#/projects/{cc1}?tab={tab}', 1400); shot(n)
    fs = sql("select id from feasibility_studies where kind='product'")
    go(f'#/feasibility/{fs}', 1800); shot('71-feasibility-study'); shot('71b-feasibility-full', full=True)
    pg.click('#aiout'); pg.wait_for_timeout(600); shot('72-feasibility-ai'); close_drawer()
    go(f'#/feasibility/{fs}/print', 1500); shot('73-feasibility-report', full=True)
    rep = sql("select id from saved_reports where name='مبيعات العملاء هذه السنة'")
    go(f'#/report-builder/{rep}', 1800); shot('49b-report-builder-run')
    go('#/report-builder/new?t=1', 1800); shot('49c-report-builder-items')
    pay = sql("select id from payroll_runs order by period_month limit 1")
    go(f'#/payroll/{pay}', 1500); shot('51b-payroll-run')
    go('#/users', 1200)
    if pg.locator('#newr').count(): pg.click('#newr'); pg.wait_for_timeout(500); shot('82b-role-editor'); close_drawer()
    go('#/display', 1800); shot('67-display')
    go('#/reports/pl', 1500); shot('44b-report-pl-full', full=True)
    # dark mode sample
    go('#/appearance', 1200)
    try:
        pg.locator('label:has-text("داكن")').first.click(); pg.wait_for_timeout(800); go('#/dashboard', 1500); shot('87-dark-dashboard')
        go('#/projects/' + cc1 + '?tab=tasks', 1400); shot('87b-dark-tasks')
        go('#/appearance', 1000); pg.locator('label:has-text("فاتح")').first.click(); pg.wait_for_timeout(600)
    except Exception as e: print('dark:', e)
    b.close()
shim.terminate()
print(json.dumps({'shots': len(done), 'errors': errs[:5]}, ensure_ascii=False))
