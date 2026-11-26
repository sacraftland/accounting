"""End-to-end test of the operations screens against the REAL schema.
Fresh database e2edb → tests/supabase_sim.sql + supabase/setup.sql, then the app
talks to it through tests/pgrest_shim.py (RLS, triggers and RPCs are the real ones).
Run: python3 tests/e2e_ops.py"""
import http.server, threading, functools, pathlib, subprocess, re, time, json, sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
DB, PORT = 'e2edb', 8790
def sh(cmd, **kw): return subprocess.run(cmd, shell=True, check=True, capture_output=True, text=True, **kw)
def sql(q): return sh(f"runuser -u postgres -- psql -X -q -t -A -d {DB}", input=q).stdout.strip()

# ---- fresh database + shim ----
subprocess.run('pg_ctlcluster 16 main start', shell=True, capture_output=True)
subprocess.run("pkill -f 'pgrest_shim.py'", shell=True); time.sleep(0.3)
sh(f"runuser -u postgres -- dropdb --if-exists {DB}"); sh(f"runuser -u postgres -- createdb {DB}")
sh(f"runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d {DB} -f {ROOT}/tests/supabase_sim.sql -f {ROOT}/supabase/setup.sql")
sql("insert into platform_admins values ('sa.craft.land@gmail.com');")
shim = subprocess.Popen([sys.executable, str(ROOT / 'tests' / 'pgrest_shim.py'), str(PORT), DB], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)

H = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / 'app'))
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8767), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = 'http://127.0.0.1:8767/index.html'
FAKE = (ROOT / 'tests' / 'fake_supabase.js').read_text()
CFG = "localStorage.setItem('daftar-backend', JSON.stringify({url:'https://abcd.supabase.co', key:'anon-key-anon-key-anon-key-anon-key-1234'}));"
SHOTS = ROOT / 'clone-screens'; SHOTS.mkdir(exist_ok=True)
results = []
def check(name, cond, extra=''):
    results.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + name + (f'  [{extra}]' if extra and not cond else ''), flush=True)
def one(q): r = sql(q); return r
def txt(pg, sel): return pg.inner_text(sel) if pg.locator(sel).count() else ''

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    def ctx_new():
        ctx = b.new_context(viewport={'width': 1360, 'height': 900}, locale='ar-SA')
        ctx.route(re.compile(r'.*supabase-js.*'), lambda r: r.fulfill(status=200, content_type='application/javascript', body=FAKE))
        ctx.route(re.compile(r'https://fonts\..*'), lambda r: r.fulfill(status=200, body=''))
        ctx.route(re.compile(r'.*/auth/v1/settings'), lambda r: r.fulfill(status=200, content_type='application/json', body='{"external":{"google":true}}'))
        ctx.add_init_script(CFG); pg = ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('console', lambda m: m.type == 'error' and errs.append(m.text))
        return ctx, pg, errs
    def settle(pg):
        try: pg.wait_for_function("!document.querySelector('.loading-screen') && !!document.querySelector('#main, #app form')", timeout=8000)
        except Exception: pass
    def go(pg, h, wait=700): pg.goto(URL + h); pg.wait_for_timeout(wait); settle(pg)
    def toast_bad(pg): return [t for t in pg.locator('.toast.bad').all_inner_texts()]
    def signup(pg, email):
        go(pg, '#/signup'); pg.fill('#f-email', email); pg.fill('#f-pw', 'goodpass1'); pg.click('#authf [type=submit]'); pg.wait_for_timeout(1200)
    def drawer_submit(pg):
        pg.click('.drawer [type=submit]'); pg.wait_for_timeout(900)
        try: pg.wait_for_function("!document.querySelector('.drawer') || document.querySelector('.drawer [data-err]')?.textContent", timeout=6000)
        except Exception: pass
        settle(pg)

    # ================= owner =================
    ctx, pg, errs = ctx_new()
    signup(pg, 'stranger@example.com')
    check('invite-only: stranger cannot sign up', 'غير' in pg.inner_text('#app') or 'دعوة' in pg.inner_text('#app'), pg.inner_text('#app')[:120])
    signup(pg, 'sa.craft.land@gmail.com')
    check('owner → company onboarding', pg.locator('#orgf').count() == 1, pg.inner_text('#app')[:120])
    pg.fill('#f-name_ar', 'كرافت لاند'); pg.fill('#f-vat_number', '300000000000003'); pg.fill('#f-city', 'الرياض'); pg.click('#orgf [type=submit]'); pg.wait_for_timeout(2500)
    check('company created → dashboard', 'لوحة التحكم' in pg.inner_text('#main'))
    nav = pg.inner_text('.nav')
    check('owner nav has purchases, manufacturing, users', all(x in nav for x in ['فواتير المشتريات', 'أوامر التصنيع', 'المستخدمون والصلاحيات']))
    check('no "coming soon" on built modules', nav.count('قريباً') <= 2, nav)

    # items: raw material, product, service
    def item(kind, name, sku, price, cost=''):
        go(pg, '#/items'); pg.click('#newi'); pg.select_option('.drawer #f-kind', kind); pg.fill('.drawer #f-name_ar', name); pg.fill('.drawer #f-sku', sku)
        pg.fill('.drawer #f-sale_price', price)
        if cost and kind != 'service': pg.fill('.drawer #f-avg_cost', cost)
        drawer_submit(pg)
    item('raw_material', 'لوح ساندوتش بانل', 'RAW-SP', '0')
    item('raw_material', 'حديد مربع 40×40', 'RAW-ST', '0')
    item('product', 'درج مطبخ خارجي', 'KIT-DR', '2500')
    item('service', 'تركيب', 'SRV-I', '300')
    check('4 items saved (incl. raw materials)', one("select count(*) from items") == '4')
    check('raw material tracks stock', one("select bool_and(track_stock) from items where kind='raw_material'") == 't')

    # suppliers
    go(pg, '#/suppliers'); pg.click('#newp2'); pg.fill('.drawer #f-name', 'مصنع الخليج للحديد'); pg.fill('.drawer #f-vat_number', '311111111111113'); drawer_submit(pg)
    check('supplier saved as supplier', one("select kind from parties") == 'supplier')

    # second warehouse
    go(pg, '#/warehouses'); pg.click('#neww'); pg.fill('.drawer #f-name', 'الورشة'); drawer_submit(pg)
    check('second warehouse added', one("select count(*) from warehouses") == '2')

    # purchase bill: 20 panels @ 150, 50 steel @ 40, landed 300, pay now
    go(pg, '#/bills/new', 1000)
    pg.select_option('#f-party', label='مصنع الخليج للحديد')
    pg.select_option('#lines tr:nth-child(1) [data-k=item_id]', label='لوح ساندوتش بانل · RAW-SP')
    pg.fill('#lines tr:nth-child(1) [data-k=qty]', '20'); pg.fill('#lines tr:nth-child(1) [data-k=unit_price]', '150')
    pg.click('#addl'); pg.select_option('#lines tr:nth-child(2) [data-k=item_id]', label='حديد مربع 40×40 · RAW-ST')
    pg.fill('#lines tr:nth-child(2) [data-k=qty]', '50'); pg.fill('#lines tr:nth-child(2) [data-k=unit_price]', '40')
    pg.click('#addlc'); pg.fill('#lcs [data-ck=description]', 'شحن'); pg.fill('#lcs [data-ck=amount]', '500')
    pg.check('#paynow'); pg.wait_for_timeout(200)
    check('bill total 5,000 + VAT = 5,750', '5,750.00' in pg.inner_text('#tTot'), pg.inner_text('#tTot'))
    pg.screenshot(path=str(SHOTS / 'S50-bill-edit.png'), full_page=True)
    pg.click('#docf [type=submit]'); pg.wait_for_timeout(2500)
    check('bill posted with number PUR-', one("select number from documents where kind='purchase_bill'").startswith('PUR-'), toast_bad(pg))
    check('bill paid by voucher', one("select payment_status from documents where kind='purchase_bill'") == 'paid')
    check('landed cost spread into avg cost (panel 150 + 500×3000/5000/20 = 165.00)', float(one("select avg_cost from items where sku='RAW-SP'")) == 16500, one("select avg_cost from items where sku='RAW-SP'"))
    pg.screenshot(path=str(SHOTS / 'S51-bill-view.png'), full_page=True)

    # BOM: drawer = 2 panels (10% waste) + 3 steel
    go(pg, '#/boms/new', 1000)
    pg.select_option('#f-item', label='درج مطبخ خارجي')
    pg.select_option('#bl tr:nth-child(1) [data-k=item_id]', label='لوح ساندوتش بانل (خام)'); pg.fill('#bl tr:nth-child(1) [data-k=qty]', '2'); pg.fill('#bl tr:nth-child(1) [data-k=waste_pct]', '10')
    pg.click('#addb'); pg.select_option('#bl tr:nth-child(2) [data-k=item_id]', label='حديد مربع 40×40 (خام)'); pg.fill('#bl tr:nth-child(2) [data-k=qty]', '3')
    pg.click('#bf2 [type=submit]'); pg.wait_for_timeout(1200)
    check('BOM saved with 2 lines', one("select count(*) from bom_lines") == '2', toast_bad(pg) or txt(pg, '#berr'))

    # manufacturing order: 4 drawers, labour 400 → salaries payable
    go(pg, '#/mfg/new', 1200); pg.select_option('#f-item', label='درج مطبخ خارجي'); pg.wait_for_timeout(300)
    pg.fill('#f-qty', '4'); pg.dispatch_event('#f-qty', 'change'); pg.wait_for_timeout(300)
    planned = pg.input_value('#ml tr:nth-child(1) [data-k=planned_qty]')
    check('components auto-filled from BOM, scaled with waste (2×4×1.1 = 8.8)', planned == '8.8', planned)
    pg.click('#addc'); pg.fill('#mc [data-ck=description]', 'أجور الورشة'); pg.fill('#mc [data-ck=amount]', '400')
    pg.screenshot(path=str(SHOTS / 'S52-mfg-edit.png'), full_page=True)
    pg.click('#mf [type=submit]'); pg.wait_for_timeout(2500)
    check('mfg order posted MO-', (one("select number from mfg_orders") or '').startswith('MO-'), toast_bad(pg) or txt(pg, '#merr'))
    check('4 drawers now in stock', one("select sum(qty) from stock_moves s join items i on i.id=s.item_id where i.sku='KIT-DR'") == '4.0000')
    tc = one("select total_cost from mfg_orders")
    check('total cost = materials + waste + labour (8.8×165 + 12×44 + 400 = 2380)', tc == '238000', tc)
    pg.screenshot(path=str(SHOTS / 'S53-mfg-view.png'), full_page=True)

    # stock transfer: 2 drawers to الورشة
    go(pg, '#/stock/new', 1000); pg.select_option('#f-to', label='الورشة')
    pg.select_option('#sl tr:nth-child(1) [data-k=item_id]', label='درج مطبخ خارجي'); pg.fill('#sl tr:nth-child(1) [data-k=qty]', '2')
    pg.click('#sdf [type=submit]'); pg.wait_for_timeout(1500)
    check('transfer posted TRF-', (one("select number from stock_docs where kind='transfer'") or '').startswith('TRF-'), toast_bad(pg) or txt(pg, '#serr2'))
    go(pg, '#/warehouses', 1000); t = pg.inner_text('#main')
    check('warehouse matrix shows 2 + 2 drawers', 'الورشة' in t and one("select string_agg(qty::numeric::text, ',' order by qty) from stock_by_warehouse w join items i on i.id=w.item_id where i.sku='KIT-DR'") == '2.0000,2.0000')
    pg.screenshot(path=str(SHOTS / 'S54-warehouses.png'), full_page=True)

    # customer + quote → invoice
    go(pg, '#/customers'); pg.click('#newp2'); pg.fill('.drawer #f-name', 'مؤسسة البر للرحلات'); pg.fill('.drawer #f-vat_number', '322222222222223')
    for k, v in [('city', 'الرياض'), ('district', 'السلي'), ('street', 'طريق الخرج'), ('building_no', '7788'), ('postal_code', '14322')]: pg.fill(f'.drawer #f-{k}', v)
    drawer_submit(pg)
    check('customer saved', one("select count(*) from parties where kind='customer'") == '1', [toast_bad(pg), pg.locator('.drawer').all_inner_texts()[:1], errs[:2]])
    go(pg, '#/quotes/new', 1000); pg.wait_for_selector('#f-party option:has-text("مؤسسة البر")', state='attached', timeout=15000); pg.select_option('#f-party', label='مؤسسة البر للرحلات')
    pg.select_option('#lines tr:nth-child(1) [data-k=item_id]', label='درج مطبخ خارجي · KIT-DR'); pg.fill('#lines tr:nth-child(1) [data-k=qty]', '2')
    pg.click('#docf [type=submit]'); pg.wait_for_timeout(1500)
    check('quote issued QUO-', (one("select number from documents where kind='quote'") or '').startswith('QUO-'), toast_bad(pg))
    pg.click('[data-conv=tax_invoice]'); pg.wait_for_timeout(1500)
    check('convert → invoice draft opens in editor', '/edit' in pg.url and pg.locator('#invf').count() == 1, pg.url)
    pg.click('#invf [type=submit]'); pg.wait_for_timeout(1800)
    check('invoice posted from quote', one("select count(*) from documents where kind='tax_invoice' and status='posted' and related_document_id is not null") == '1', [toast_bad(pg), txt(pg, '#ierr'), txt(pg, '#kindwarn')])
    check('COGS at avg cost of drawers', one("select sum(debit) from journal_lines l join accounts a on a.id=l.account_id where a.system_key='cogs'") == str(2 * 59500), one("select sum(debit) from journal_lines l join accounts a on a.id=l.account_id where a.system_key='cogs'"))

    # credit note from invoice (return 1)
    inv = one("select id from documents where kind='tax_invoice'")
    go(pg, f'#/invoices/{inv}', 1000); pg.click('#mkcn'); pg.wait_for_timeout(1500)
    check('credit-note draft opened', '/credit-notes/' in pg.url and pg.locator('#docf').count() == 1, pg.url)
    pg.fill('#lines tr:nth-child(1) [data-k=qty]', '1'); pg.click('#docf [type=submit]'); pg.wait_for_timeout(1500)
    check('credit note posted CN-', (one("select number from documents where kind='credit_note'") or '').startswith('CN-'), toast_bad(pg) or txt(pg, '#ierr'))

    # expense with VAT
    go(pg, '#/expenses', 1000); pg.click('#newx2'); pg.select_option('.drawer #f-account_id', index=1); pg.fill('.drawer #f-description', 'كهرباء الورشة')
    pg.fill('.drawer #f-amount', '1150'); pg.check('.drawer [name=has_vat]'); pg.fill('.drawer #f-supplier_vat_number', '311111111111113'); drawer_submit(pg)
    check('expense posted EXP- net 1000 + VAT 150', one("select number||':'||amount||':'||vat_amount from expenses").startswith('EXP-') and one("select amount||':'||vat_amount from expenses") == '100000:15000', toast_bad(pg) or pg.locator('.drawer [data-err]').all_inner_texts())

    # manual entry
    go(pg, '#/journal/new', 1000); pg.fill('#f-memo', 'إثبات رأس المال')
    pg.select_option('#jl tr:nth-child(1) [data-k=account_id]', index=3); pg.fill('#jl tr:nth-child(1) [data-k=debit]', '1000')
    cap = one("select id from accounts where system_key='capital'")
    pg.select_option('#jl tr:nth-child(2) [data-k=account_id]', cap); pg.fill('#jl tr:nth-child(2) [data-k=credit]', '999')
    pg.click('#jf [type=submit]'); pg.wait_for_timeout(400)
    check('unbalanced entry blocked', 'غير متوازن' in txt(pg, '#jerr'))
    pg.fill('#jl tr:nth-child(2) [data-k=credit]', '1000'); pg.click('#jf [type=submit]'); pg.wait_for_timeout(1500)
    check('manual entry posted', one("select count(*) from journal_entries where source_type='manual'") == '1', toast_bad(pg) or txt(pg, '#jerr'))
    pg.click('#rev'); pg.click('#rev'); pg.wait_for_timeout(1500)
    check('manual entry reversed', one("select count(*) from journal_entries where source_type='reversal'") == '1', toast_bad(pg))

    # roles: invite a workshop worker
    go(pg, '#/users', 1200)
    check('7 default roles', pg.locator('[data-t=r]').inner_text().count('7') == 1, pg.locator('[data-t=r]').inner_text())
    pg.click('#newu'); pg.fill('.drawer #f-email', ' Worker@Example.com '); pg.select_option('.drawer #f-role_id', label='عامل ورشة'); drawer_submit(pg)
    check('invitation saved with role', one("select email||':'||r.name from invitations i join roles r on r.id=i.role_id") == 'worker@example.com:عامل ورشة')
    pg.click('[data-t=r]'); pg.click('[data-er]:nth-of-type(1)') if False else None
    # custom role: storekeeper-lite, view inventory only
    pg.click('#newr'); pg.fill('.drawer #f-name', 'مراقب مخزون'); pg.check('.drawer [name="p:inventory:view"]'); drawer_submit(pg)
    check('custom role saved', one("select permissions::text from roles where name='مراقب مخزون'") == '{"inventory": ["view"]}', one("select permissions::text from roles where name='مراقب مخزون'"))
    pg.screenshot(path=str(SHOTS / 'S55-users.png'), full_page=True)
    tb = one("select sum(debit) = sum(credit) from journal_lines")
    check('ledger balanced after everything', tb == 't')
    check('owner: no page errors', not errs, errs[:3])
    pg.click('[data-act=signout]'); pg.wait_for_timeout(500); ctx.close()

    # ================= worker =================
    ctx, pg, errs = ctx_new()
    signup(pg, 'worker@example.com')
    check('invited worker signs up and joins the company', 'كرافت لاند' in pg.inner_text('#app'), pg.inner_text('#app')[:120])
    nav = pg.inner_text('.nav')
    check('worker nav: manufacturing only, no sales/purchases/users', 'أوامر التصنيع' in nav and 'الفواتير' not in nav and 'فواتير المشتريات' not in nav and 'المستخدمون' not in nav, nav)
    go(pg, '#/bills', 1800)
    check('worker opening bills URL → no permission', 'ليست لديك صلاحية' in pg.inner_text('#main'), pg.inner_text('#main')[:300] + ' URL=' + pg.url)
    go(pg, '#/mfg/new', 1200); pg.select_option('#f-item', label='درج مطبخ خارجي'); pg.wait_for_timeout(300)
    check('worker: no post button, only "send for approval"', pg.locator('#mf [type=submit]').count() == 0 and pg.locator('#subm').count() == 1)
    pg.click('#subm'); pg.wait_for_timeout(1500)
    check('worker submitted order for approval', one("select count(*) from mfg_orders where status='draft' and submitted_at is not null") == '1', toast_bad(pg) or txt(pg, '#merr'))
    mo = one("select id from mfg_orders where status='draft'")
    import urllib.request
    uid = one("select id from auth.users where email='worker@example.com'")
    r = json.loads(urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{PORT}/rest', data=json.dumps({'rpc': 'post_mfg_order', 'args': {'mo': mo}, 'sub': uid}).encode(), headers={'Content-Type': 'application/json'})).read())
    check('worker cannot post even by calling the server directly', r.get('error') and one("select status from mfg_orders where id='%s'" % mo) == 'draft', r)
    check('worker: no page errors', not errs, errs[:3])
    pg.click('[data-act=signout]'); pg.wait_for_timeout(500); ctx.close()

    # ================= owner approves =================
    ctx, pg, errs = ctx_new()
    go(pg, '#/login'); pg.fill('#f-email', 'sa.craft.land@gmail.com'); pg.fill('#f-pw', 'goodpass1'); pg.click('#authf [type=submit]'); pg.wait_for_timeout(2000)
    try: pg.wait_for_function("document.querySelector('#main')?.innerText.includes('بانتظار اعتمادك')", timeout=8000)
    except Exception: pass
    check('owner dashboard lists pending approval', 'بانتظار اعتمادك' in pg.inner_text('#main') and 'أمر تصنيع' in pg.inner_text('#main'))
    pg.screenshot(path=str(SHOTS / 'S56-dashboard-approvals.png'), full_page=True)
    go(pg, f'#/mfg/{mo}', 1200); pg.click('#mf [type=submit]'); pg.wait_for_timeout(2000)
    check('owner approves → posted', one(f"select status from mfg_orders where id='{mo}'") == 'posted', toast_bad(pg))
    go(pg, '#/trial-balance', 1000)
    check('trial balance balanced', 'متوازن ✓' in pg.inner_text('#main'))
    # ---------- dashboard insights & reports ----------
    go(pg, '#/dashboard', 1500)
    check('dashboard: 6-month chart with legend', pg.locator('svg.chart').count() == 1 and 'الإيرادات' in pg.inner_text('.legend'))
    pg.screenshot(path=str(SHOTS / 'S60-dashboard.png'), full_page=True)
    go(pg, '#/reports/pl?p=this-y', 1500); t = pg.inner_text('#rep')
    rev = int(one("select sum(credit-debit) from journal_lines l join accounts a on a.id=l.account_id where a.type='revenue'"))
    exp = int(one("select sum(debit-credit) from journal_lines l join accounts a on a.id=l.account_id where a.type='expense'"))
    m = lambda v: f"{v/100:,.2f}"
    check('income statement: revenue & net profit match the ledger', m(rev) in t and m(rev - exp).lstrip('-') in t, (m(rev), m(rev-exp)))
    pg.screenshot(path=str(SHOTS / 'S61-income-statement.png'), full_page=True)
    go(pg, '#/reports/bs?p=this-y', 1500)
    check('balance sheet balances', 'متوازنة ✓' in pg.inner_text('#rep'))
    pg.screenshot(path=str(SHOTS / 'S62-balance-sheet.png'), full_page=True)
    go(pg, '#/reports/vat?p=this-y', 1500); t = pg.inner_text('#rep')
    due = -int(one("select sum(debit-credit) from journal_lines l join accounts a on a.id=l.account_id where a.system_key in ('vat_out','vat_in')"))
    check('VAT return: net due equals the VAT accounts', m(abs(due)) in t, (m(due), t[-300:]))
    pg.screenshot(path=str(SHOTS / 'S63-vat-return.png'), full_page=True)
    go(pg, '#/reports/aging', 1200); check('aging report renders AR', 'المستحق من العملاء' in pg.inner_text('#rep'))
    go(pg, '#/reports/stock', 1200); check('inventory valuation renders', 'إجمالي قيمة المخزون' in pg.inner_text('#rep'))
    go(pg, '#/reports/mfg?p=this-y', 1200); check('production report shows 2 orders', 'درج مطبخ خارجي' in pg.inner_text('#rep'))
    with pg.expect_download() as dl: pg.click('#csv')
    check('report exports to CSV', dl.value.suggested_filename.endswith('.csv'))

    # ---------- employees & payroll ----------
    go(pg, '#/employees', 1000); pg.click('#newe2')
    pg.fill('.drawer #f-full_name', 'خالد العتيبي'); pg.fill('.drawer #f-job_title', 'مشرف ورشة'); pg.fill('.drawer #f-hire_date', '2018-03-01')
    pg.fill('.drawer #f-basic_salary', '8000'); pg.fill('.drawer #f-housing_allowance', '2000'); pg.fill('.drawer #f-transport_allowance', '500')
    pg.fill('.drawer #f-iban', 'SA0380000000608010167519'); drawer_submit(pg)
    pg.click('#newe'); pg.fill('.drawer #f-full_name', 'Ramesh Kumar'); pg.select_option('.drawer #f-is_saudi', '0'); pg.fill('.drawer #f-hire_date', '2025-01-10')
    pg.fill('.drawer #f-basic_salary', '3000'); pg.fill('.drawer #f-housing_allowance', '750'); drawer_submit(pg)
    check('2 employees saved', one("select count(*) from employees") == '2', toast_bad(pg) or pg.locator('.drawer').all_inner_texts()[:1])
    go(pg, '#/payroll', 1000); pg.click('#newrun [type=submit]'); pg.wait_for_timeout(1800)
    check('payroll prepared with 2 payslips', pg.locator('#pst tr[data-p]').count() == 2, toast_bad(pg))
    row = pg.locator('#pst tr[data-p]').filter(has_text='Ramesh'); row.locator('[data-k=additions]').fill('250'); row.locator('[data-k=additions]').press('Tab'); pg.wait_for_timeout(1500)
    check('overtime added to the net', one("select net from payslips p join employees e on e.id=p.employee_id where e.full_name like 'Ramesh%'") == str(375000 + 25000))
    pg.screenshot(path=str(SHOTS / 'S64-payroll.png'), full_page=True)
    pg.click('#postp'); pg.wait_for_timeout(1800)
    check('payroll posted', one("select status from payroll_runs") == 'posted', toast_bad(pg))
    pg.click('#payp'); pg.click('#payok'); pg.wait_for_timeout(1800)
    check('salaries paid', one("select status from payroll_runs") == 'paid', toast_bad(pg))
    check('ledger still balanced after payroll', one("select sum(debit) = sum(credit) from journal_lines") == 't')
    # ---------- projects ----------
    go(pg, '#/projects', 1000); pg.click('#newp2'); pg.wait_for_timeout(400); pg.fill('.drawer #f-name', 'كرفان 8 متر — مؤسسة البر'); pg.fill('.drawer #f-contract_value', '40000'); drawer_submit(pg); pg.wait_for_timeout(800)
    check('project saved', one("select code||':'||contract_value from cost_centers") == 'P-001:4000000', toast_bad(pg))
    go(pg, '#/expenses', 1000); pg.click('#newx'); pg.select_option('.drawer #f-account_id', index=2); pg.fill('.drawer #f-description', 'نقل الكرفان')
    pg.fill('.drawer #f-amount', '500'); pg.select_option('.drawer #f-cost_center_id', index=1); drawer_submit(pg); pg.wait_for_timeout(1500)
    check('expense tagged with project', one("select count(*) from journal_lines where cost_center_id is not null") != '0', toast_bad(pg))
    cc = one("select id from cost_centers")
    go(pg, f'#/projects/{cc}?tab=docs', 1500); t = pg.inner_text('#main')
    check('project page shows its cost', '500.00' in t and 'نقل الكرفان' in t, t[:1500])
    pg.screenshot(path=str(SHOTS / 'S65-project.png'), full_page=True)

    # ---------- POS ----------
    go(pg, '#/pos', 1500)
    pg.click('.pos-tile:has-text("درج مطبخ خارجي")'); pg.click('.pos-tile:has-text("درج مطبخ خارجي")')
    check('POS: 2 drawers in the cart = 5,750', '5,750.00' in pg.inner_text('#pT'), pg.inner_text('#pT'))
    pg.fill('#f-paid', '6000'); pg.wait_for_timeout(200)
    check('POS: change shown', '250.00' in pg.inner_text('#change'))
    pg.screenshot(path=str(SHOTS / 'S66-pos.png'), full_page=True)
    pg.click('#paycash'); pg.wait_for_timeout(2500)
    check('POS: receipt shown with QR', pg.locator('.receipt80 svg').count() == 1 and 'فاتورة ضريبية مبسطة' in pg.inner_text('.receipt80'), toast_bad(pg) or txt(pg, '#poserr'))
    pg.screenshot(path=str(SHOTS / 'S67-pos-receipt.png'))
    check('POS: simplified invoice posted & paid in cash', one("select payment_status from documents where kind='simplified_invoice' and note='نقطة البيع'") == 'paid'
          and one("select method from payments where reference like 'INV-%' order by created_at desc limit 1") == 'cash')
    pg.click('#rnew'); pg.fill('#posq', 'SRV-I'); pg.press('#posq', 'Enter'); pg.wait_for_timeout(200)
    check('POS: code + Enter adds the item (barcode scanner)', pg.locator('.pos-line').count() == 1)
    pg.click('#paycard'); pg.wait_for_timeout(2500)
    check('POS: card sale goes to card clearing', one("select method from payments order by created_at desc limit 1") == 'card', toast_bad(pg) or txt(pg, '#poserr'))
    # paper size: 80 mm default, 58 mm remembered on this device, print page sized to the receipt
    pg.evaluate("window.__pages = []; window.print = () => { window.__pages.push(document.getElementById('rc-page')?.textContent || '') }; 0")
    check('POS: receipt defaults to 80 mm', pg.locator('#rcpt.rc58').count() == 0 and pg.locator('[data-paper="80"][aria-pressed="true"]').count() == 1)
    pg.click('#rprint'); pg.wait_for_timeout(200)
    check('POS: 80 mm print page', 'size: 80mm' in (pg.evaluate('window.__pages[0]') or ''), pg.evaluate('window.__pages[0]'))
    pg.click('[data-paper="58"]'); pg.wait_for_timeout(200)
    check('POS: 58 mm switches the receipt', pg.locator('#rcpt.rc58').count() == 1 and round(pg.evaluate("document.getElementById('rcpt').getBoundingClientRect().width")) in range(215, 225))
    pg.screenshot(path=str(SHOTS / 'S67b-pos-receipt-58.png'))
    pg.click('#rprint'); pg.wait_for_timeout(200)
    m = re.search(r'size: (\d+)mm (\d+)mm', pg.evaluate('window.__pages[1]') or '')
    check('POS: 58 mm print page sized to the receipt', m and m.group(1) == '58' and 60 <= int(m.group(2)) <= 400, pg.evaluate('window.__pages[1]'))
    check('POS: page style removed after printing', pg.wait_for_function("!document.getElementById('rc-page')", timeout=3000) is not None)
    check('POS: paper choice remembered', pg.evaluate("localStorage.getItem('daftar-pos-paper')") == '58')
    # real print layout (as the printer driver gets it): one page, 58 mm wide
    pg.evaluate("document.body.classList.add('print-receipt'); const el = document.getElementById('rcpt'); const st = document.createElement('style'); st.id = 'rc-test'; st.textContent = `@page { size: 58mm ${Math.ceil(el.scrollHeight * 25.4 / 96) + 12}mm; margin: 0 }`; document.head.append(st)")
    pdf = pg.pdf(prefer_css_page_size=True, print_background=True); open(SHOTS / 'S67c-receipt-58.pdf', 'wb').write(pdf)
    pg.evaluate("document.body.classList.remove('print-receipt'); document.getElementById('rc-test').remove()")
    pages = pdf.count(b'/Type /Page') - pdf.count(b'/Type /Pages')
    wpt = re.search(rb'/MediaBox \[0 0 ([\d.]+) ', pdf)
    check('POS: 58 mm receipt prints on one page 58 mm wide', pages == 1 and wpt and abs(float(wpt.group(1)) - 58 / 25.4 * 72) < 2, f'{pages} pages, {wpt and wpt.group(1)}')
    pg.click('[data-paper="80"]')
    pg.click('#rnew')
    # reprint any invoice as a thermal receipt
    inv_id = one("select id from documents where kind='simplified_invoice' and note='نقطة البيع' order by created_at limit 1")
    go(pg, f'#/invoices/{inv_id}', 1500); pg.click('#thermal'); pg.wait_for_timeout(600)
    check('invoice page: thermal receipt reprint', pg.locator('#rcpt').count() == 1 and '(نسخة)' in pg.inner_text('#rcpt') and 'إغلاق' in pg.inner_text('#rnew')
          and pg.locator('#rcpt svg').count() == 1, pg.inner_text('body')[:200])
    check('invoice page: reprint keeps the 58 mm choice off by default here', pg.locator('#rcpt.rc58').count() == 0)
    pg.click('[data-paper="58"]'); pg.wait_for_timeout(150)
    import base64
    png = base64.b64decode(pg.evaluate('window.__lastReceipt()').split(',')[1]); (SHOTS / 'S67d-receipt-picture-58.png').write_bytes(png)
    import cv2, numpy as np
    img = cv2.imdecode(np.frombuffer(png, np.uint8), 1)
    check('RawBT picture: 384 dots wide, QR readable', img.shape[1] == 384 and img.shape[0] > 400 and cv2.QRCodeDetector().detectAndDecode(img)[0] != '', str(img.shape))
    pg.click('[data-paper="80"]'); pg.wait_for_timeout(150)
    pg.click('#rnew'); pg.wait_for_timeout(200)
    check('invoice page: closing the receipt returns to the invoice', pg.locator('#rcpt').count() == 0 and '/invoices/' in pg.url)
    go(pg, '#/pos', 1200)
    # mobile check on new screens
    pg.set_viewport_size({'width': 390, 'height': 800})
    for h in ['#/bills', '#/mfg', '#/warehouses', '#/expenses', '#/users', '#/reports/pl', '#/reports/vat', '#/payroll', '#/dashboard', '#/pos', '#/projects']:
        go(pg, h, 900); w = pg.evaluate('document.documentElement.scrollWidth')
        check(f'mobile {h} fits 390px', w <= 392, w)
    check('owner: no page errors', not errs, errs[:3])
    ctx.close(); b.close()

shim.terminate()
print(f'\n{sum(results)}/{len(results)} passed')
