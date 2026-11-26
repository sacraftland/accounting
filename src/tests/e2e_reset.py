"""End-to-end test: company reset (backup first, typed name, double confirm) and the card-settlement menu link.
Run: python3 tests/e2e_reset.py"""
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
    uid = f"select set_config('request.jwt.claims', '{{\"sub\":\"{owner}\"}}', false);"
    sql(uid + f"""set role authenticated;
      insert into parties (org_id, kind, name, vat_number, city, street, building_no, postal_code) values ('{org}', 'customer', 'عميل تجربة', '311111111111113', 'الرياض', 'ش', '1', '12345');
      insert into items (org_id, kind, name_ar, sale_price) values ('{org}', 'service', 'خدمة تجربة', 100000);
      insert into documents (org_id, branch_id, warehouse_id, kind, party_id, issue_date) select '{org}', b.id, w.id, 'tax_invoice', p.id, current_date from branches b, warehouses w, parties p where b.org_id = '{org}' and w.org_id = '{org}' and p.org_id = '{org}';
      insert into document_lines (document_id, org_id, line_no, item_id, description, qty, unit_price, tax_category, vat_rate) select d.id, '{org}', 1, i.id, 'x', 2, 100000, 'S', 15 from documents d, items i where d.org_id = '{org}' and i.org_id = '{org}';
      select post_sales_invoice(id) from documents where org_id = '{org}';""")
    check('seeded: one posted invoice', one(f"select count(*) from documents where org_id = '{org}' and status = 'posted'") == '1')

    # ---------- card settlement link (was sending users to the dashboard) ----------
    go('#/dashboard'); pg.click('a[href="#/card-settle"]'); pg.wait_for_timeout(1200); settle()
    check('menu link opens the card settlement page', 'تسوية مدفوعات الشبكة' in main(), main()[:120])
    go('#/card-settlement'); check('old address still works', 'تسوية مدفوعات الشبكة' in main())

    # ---------- reset ----------
    go('#/backup', 1500)
    check('reset section shown to the owner', pg.is_visible('#rst'))
    check('name field and reset button locked until a backup is downloaded', pg.is_disabled('#f-rstname') and pg.is_disabled('#rstgo'))
    path = download('#rstbk'); pg.wait_for_timeout(500)
    data = json.loads(gzip.decompress(path.read_bytes()) if path.suffix == '.gz' else path.read_text())
    check('backup downloaded before reset holds the invoice', len(data['tables']['documents']) == 1 and 'قبل-التصفير' in path.name, path.name)
    check('after the backup the fields unlock', not pg.is_disabled('#f-rstname') and not pg.is_disabled('#rstgo'))
    pg.fill('#f-rstname', 'كرافت'); pg.click('#rstgo'); pg.wait_for_timeout(300)
    check('wrong name is refused in the page', 'اكتب اسم الشركة' in pg.inner_text('#rsterr'))
    pg.fill('#f-rstname', 'كرافت لاند'); pg.click('#rstgo'); pg.wait_for_timeout(300)
    check('first press only asks to confirm', 'متأكد' in pg.inner_text('#rstgo') and one(f"select count(*) from documents where org_id = '{org}'") == '1')
    shot('reset-confirm')
    pg.click('#rstgo'); pg.wait_for_timeout(2500); settle()
    check('second press wipes the operations', one(f"select count(*) from documents where org_id = '{org}'") == '0' and one(f"select count(*) from journal_entries where org_id = '{org}'") == '0')
    check('customer and item kept', one(f"select count(*) from parties where org_id = '{org}'") == '1' and one(f"select count(*) from items where org_id = '{org}'") == '1')
    check('lands on the dashboard', '#/dashboard' in pg.url)
    go('#/backup', 1500); check('the reset shows in the backup log', 'تصفير' in pg.inner_text('#main'))
    check('no page errors', not errs, '; '.join(errs[:3]))
    b.close()

srv.shutdown(); shim.terminate()
print(f'{sum(results)} / {len(results)} passed (e2e reset)')
sys.exit(0 if all(results) else 1)
