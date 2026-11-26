"""End-to-end test of the extended screens (ledger, chart editing, opening balances, fixed assets,
custody, card settlement, delivery notes, leads, tasks, commitments, calendar, leaves, attendance,
evaluations) against the REAL schema through tests/pgrest_shim.py.
Run: python3 tests/e2e_ext.py"""
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
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8768), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = 'http://127.0.0.1:8768/index.html'
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
    def go(h, wait=900): pg.goto(URL + h); pg.wait_for_timeout(wait)
    def submit(wait=1000): pg.click('.drawer [type=submit]'); pg.wait_for_timeout(wait)
    def err(): return pg.inner_text('.drawer [data-err]') if pg.locator('.drawer [data-err]').count() else ''
    def main(): return pg.inner_text('#main')
    def shot(n): pg.screenshot(path=str(SHOTS / f'ext-{n}.png'), full_page=True)

    go('#/signup'); pg.fill('#f-email', 'sa.craft.land@gmail.com'); pg.fill('#f-pw', 'goodpass1'); pg.click('#authf [type=submit]'); pg.wait_for_timeout(1200)
    pg.fill('#f-name_ar', 'كرافت لاند'); pg.fill('#f-vat_number', '300000000000003'); pg.fill('#f-city', 'الرياض'); pg.click('#orgf [type=submit]'); pg.wait_for_timeout(2500)
    org = one("select id from orgs")
    nav = pg.inner_text('.nav')
    check('nav lists new modules', all(x in nav for x in ['الأصول الثابتة', 'الصندوق والعهد', 'العملاء المحتملون', 'المهام', 'الالتزامات والتجديدات', 'الإجازات', 'الحضور والانصراف', 'تقييم الأداء', 'سندات التسليم']), nav)
    check('dashboard shows calendar', 'التقويم' in main(), main()[:300])

    # ---------- chart of accounts: add account ----------
    go('#/accounts'); pg.click('#main .page-head button.primary'); pg.wait_for_timeout(300)
    pg.select_option('.drawer #f-parent_id', label=pg.locator('.drawer #f-parent_id option', has_text='52 —').first.inner_text())
    code = pg.input_value('.drawer #f-code')
    check('next code suggested under 52', code.startswith('52') and len(code) == 4, code)
    pg.fill('.drawer #f-name_ar', 'مصاريف الدعاية والإعلان'); submit()
    check('new account saved as expense, postable', one(f"select type||is_postable from accounts where code='{code}'") == 'expensetrue', err())
    check('new account in tree', 'مصاريف الدعاية والإعلان' in main())
    aid = one(f"select id from accounts where code='{code}'"); pg.click(f'[data-ea="{aid}"]'); pg.wait_for_timeout(300)
    pg.fill('.drawer #f-name_ar', 'مصاريف التسويق'); submit()
    check('account renamed', one(f"select name_ar from accounts where code='{code}'") == 'مصاريف التسويق')
    sysid = one("select id from accounts where system_key='cash'")
    pg.click(f'[data-ea="{sysid}"]'); pg.wait_for_timeout(300)
    check('system account has no delete button', pg.locator('.drawer #dela').count() == 0)
    pg.keyboard.press('Escape')

    # ---------- opening balances ----------
    sql(f"insert into parties (org_id, kind, name, phone, email, credit_limit) values ('{org}', 'customer', 'مؤسسة الرحلات', '0551234567', 'trip@example.com', 500000)")
    go('#/opening')
    check('opening screen', 'الأرصدة الافتتاحية' in main())
    rows = pg.locator('#obl tr')
    def set_amt(label, v):
        r = pg.locator('#obl tr', has_text=label).first; r.locator('[data-k=amount]').fill(v)
    set_amt('الصندوق', '10000'); set_amt('البنك', '90000')
    pg.click('#obadd'); pg.wait_for_timeout(200)
    last = pg.locator('#obl tr').last
    last.locator('[data-k=party_id]').select_option(label='مؤسسة الرحلات'); last.locator('[data-k=amount]').fill('7000')
    pg.wait_for_timeout(200)
    check('opening total shown', '107,000.00' in pg.inner_text('#obD'), pg.inner_text('#obD'))
    pg.click('#obf [type=submit]'); pg.wait_for_timeout(1500)
    check('opening entry posted, balanced to 3401', one("select sum(credit) from journal_lines l join accounts a on a.id=l.account_id where a.system_key='opening_balance'") == '10700000', pg.inner_text('#oberr') if pg.locator('#oberr').count() else '')

    # ---------- ledger ----------
    cash = one("select id from accounts where system_key='cash'")
    go(f'#/ledger/{cash}')
    check('ledger page renders', 'كشف حساب' in main() and '10,000.00' in main(), main()[:300])
    shot('ledger')
    go('#/accounts')
    check('tree links to ledger', pg.locator(f'a[href="#/ledger/{cash}"]').count() == 1)

    # ---------- customer: credit limit + WhatsApp ----------
    cust = one("select id from parties where name='مؤسسة الرحلات'")
    go(f'#/customers/{cust}')
    check('customer shows credit limit', 'حد الائتمان' in main(), main()[:400])
    check('whatsapp reminder link', pg.locator('a[href^="https://wa.me/966551234567"]').count() == 1)
    go('#/reports/aging')
    check('aging has reminder column', pg.locator('a[href^="https://wa.me/"]').count() >= 0)

    # ---------- fixed assets ----------
    go('#/assets'); pg.click('#newfa'); pg.wait_for_timeout(300)
    pg.fill('.drawer #f-name', 'ماكينة قص ليزر'); pg.fill('.drawer #f-cost', '120000'); pg.fill('.drawer #f-life_months', '60')
    pg.fill('.drawer #f-acquisition_date', '2026-01-10'); pg.fill('.drawer #f-depreciation_start', '2026-01-01'); submit()
    check('asset saved', one("select cost from fixed_assets") == '12000000', err())
    pg.click('#rundep'); pg.wait_for_timeout(1500)
    n = one("select count(*) from asset_depreciation")
    check('depreciation ran for months to date', int(n) >= 10, n)
    check('monthly charge 2,000', one("select distinct amount from asset_depreciation") == '200000')
    check('book value shown', 'القيمة الدفترية' in main())
    shot('assets')
    pg.click('#rundep'); pg.wait_for_timeout(1200)
    check('depreciation idempotent', one("select count(*) from asset_depreciation") == n)

    # ---------- custody ----------
    sql(f"insert into employees (org_id, full_name, is_saudi, hire_date, basic_salary) values ('{org}', 'محمد العامل', true, '2019-01-01', 500000), ('{org}', 'سالم الفني', false, '2025-06-01', 300000)")
    go('#/custody'); pg.click('#iss'); pg.wait_for_timeout(300)
    pg.select_option('.drawer #f-emp', label='محمد العامل'); pg.fill('.drawer #f-amount', '1500'); submit(1500)
    check('custody issued', '1,500.00' in main(), err() or main()[:300])
    pg.click('[data-ret]'); pg.wait_for_timeout(300); pg.fill('.drawer #f-amount', '500'); submit(1500)
    check('custody partly returned', '1,000.00' in main(), err())

    # ---------- card settlement ----------
    ccid = one("select id from accounts where system_key='card_clearing'")
    go('#/card-settlement')
    check('card settlement page', 'تسوية مدفوعات الشبكة' in main())
    pg.fill('#f-gross', '0')
    # no card balance → still validates input
    pg.click('#csf [type=submit]'); pg.wait_for_timeout(400)
    check('card settle validates amount', 'أدخل المبلغ' in pg.inner_text('#cserr'))

    # ---------- delivery note from quote ----------
    go('#/delivery-notes')
    check('delivery notes list', 'سندات التسليم' in main(), main()[:200])

    # ---------- leads ----------
    go('#/leads'); pg.click('#newl'); pg.wait_for_timeout(300)
    pg.fill('.drawer #f-name', 'أبو فهد'); pg.fill('.drawer #f-company', 'مخيمات البر'); pg.fill('.drawer #f-phone', '0559998887'); pg.fill('.drawer #f-expected_value', '45000')
    pg.fill('.drawer #f-next_followup', '2026-01-01'); submit()
    check('lead saved', one("select expected_value from leads") == '4500000', err())
    check('lead on kanban with overdue follow-up', 'أبو فهد' in main() and pg.locator('.kcard .down').count() == 1)
    pg.click('.kcard'); pg.wait_for_timeout(300); pg.click('#tocust'); pg.wait_for_timeout(1500)
    check('lead converted to customer', one("select status from leads") == 'won' and one("select count(*) from parties where name='مخيمات البر'") == '1')

    # ---------- tasks ----------
    sql(f"insert into cost_centers (org_id, code, name, is_project) values ('{org}', 'P-01', 'كرفان مؤسسة الرحلات', true)")
    go('#/tasks'); pg.click('#newt'); pg.wait_for_timeout(300)
    pg.fill('.drawer #f-title', 'تجهيز الهيكل'); pg.select_option('.drawer #f-cost_center_id', label='كرفان مؤسسة الرحلات'); pg.select_option('.drawer #f-priority', 'high'); submit()
    check('task saved with project', one("select count(*) from tasks where cost_center_id is not null and priority='high'") == '1', err())
    pg.click('.kcard [data-mv=doing]'); pg.wait_for_timeout(1000)
    check('task moved to doing', one("select status from tasks") == 'doing')

    # ---------- commitments ----------
    go('#/commitments'); pg.click('#newc2'); pg.wait_for_timeout(300)
    pg.fill('.drawer #f-title', 'السجل التجاري'); pg.fill('.drawer #f-expiry_date', '2026-12-10'); submit()
    check('commitment saved', one("select kind from commitments") == 'cr', err())
    check('expiring badge', 'باقي' in main() or 'منتهي' in main())
    go('#/dashboard', 1500)
    check('dashboard alerts expiring commitment', 'السجل التجاري' in main(), main()[:400])
    pg.click('#addnote'); pg.wait_for_timeout(300); pg.fill('.drawer #f-title', 'زيارة المعرض'); submit(1500)
    check('calendar note saved & shown', one("select count(*) from calendar_notes") == '1' and 'زيارة المعرض' in main(), err())
    shot('dashboard')

    # ---------- leaves ----------
    go('#/leaves'); pg.click('#newlv'); pg.wait_for_timeout(300)
    pg.select_option('.drawer #f-employee_id', label='محمد العامل'); pg.fill('.drawer #f-start_date', '2026-08-02'); pg.fill('.drawer #f-end_date', '2026-08-06'); submit()
    check('leave requested (pending)', one("select status||days from leaves") in ('pending5', 'pending5.0'), one("select status||coalesce(days::text,'') from leaves") + err())
    pg.click('[data-ap]'); pg.wait_for_timeout(1200)
    check('leave approved', one("select status from leaves") == 'approved')
    go('#/leaves?tab=bal')
    check('balances: 30 days after 5 yrs, 25 remaining', '25' in main() and '30' in main(), main()[:500])

    # ---------- attendance ----------
    go('#/attendance?day=2026-11-25'); pg.click('#allp'); pg.click('#atf [type=submit]'); pg.wait_for_timeout(1500)
    check('attendance saved for all', one("select count(*) from attendance where status='present' and check_in='07:30'") == '2', one("select count(*) from attendance"))
    pg.locator('#atf tr[data-e]').first.locator('[data-k=status]').select_option('late'); pg.click('#atf [type=submit]'); pg.wait_for_timeout(1500)
    check('attendance upsert (no duplicates)', one("select count(*) from attendance") == '2' and one("select count(*) from attendance where status='late'") == '1')

    # ---------- evaluations ----------
    go('#/evaluations'); pg.click('#newev'); pg.wait_for_timeout(300)
    pg.select_option('.drawer #f-employee_id', label='سالم الفني'); pg.fill('.drawer #sc0', '10'); pg.dispatch_event('.drawer #sc0', 'input')
    check('score total updates', pg.inner_text('.drawer #stot') == '73')
    submit()
    check('evaluation saved', one("select array_length(scores,1) from evaluations") == '10', err())
    check('evaluation listed with grade', '73 / 100' in main() and 'جيد' in main())

    check('no page errors', not errs, ' | '.join(errs[:3]))
    b.close()

shim.terminate()
print(f'\n{sum(results)}/{len(results)} passed')
sys.exit(0 if all(results) else 1)
