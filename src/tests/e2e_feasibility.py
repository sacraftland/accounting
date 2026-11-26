"""End-to-end test of feasibility studies: start from a past project, sources per number,
company overheads, formulas (break-even, payback, NPV, IRR), AI export / import, printed report.
Run: python3 tests/e2e_feasibility.py"""
import http.server, threading, functools, pathlib, subprocess, re, time, sys, json
from playwright.sync_api import sync_playwright

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
results = []
def check(name, cond, extra=''):
    results.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + name + (f'  [{extra}]' if extra and not cond else ''), flush=True)
one = sql

def irr_monthly(capex, flows):
    f = lambda x: -capex + sum(c / (1 + x) ** (i + 1) for i, c in enumerate(flows))
    lo, hi = -0.99, 1.0
    for _ in range(200):
        mid = (lo + hi) / 2
        if f(lo) * f(mid) <= 0: hi = mid
        else: lo = mid
    return (1 + (lo + hi) / 2) ** 12 - 1

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
    def res(): return pg.inner_text('#fsres')
    def shot(n): pg.screenshot(path=str(SHOTS / f'feas-{n}.png'), full_page=True)
    def saved():
        try: pg.wait_for_function("document.querySelector('#fssave')?.textContent.includes('محفوظ ✓')", timeout=6000)
        except Exception: pass

    go('#/signup'); pg.fill('#f-email', 'sa.craft.land@gmail.com'); pg.fill('#f-pw', 'goodpass1'); pg.click('#authf [type=submit]'); pg.wait_for_timeout(1200)
    pg.fill('#f-name_ar', 'كرافت لاند'); pg.fill('#f-vat_number', '300000000000003'); pg.fill('#f-city', 'الرياض'); pg.click('#orgf [type=submit]'); pg.wait_for_timeout(2500)
    org = one("select id from orgs")
    # a finished production batch of 2 caravans with posted revenue, materials, labor, other — plus company rent (no project)
    sql(f"""update orgs set invoice_settings = '{{"iban":"SA0380000000608010167519","bank_name":"الراجحي","terms":"الدفعة مقدمة"}}' where id = '{org}';
      insert into items (org_id, kind, name_ar, sku, sale_price) values ('{org}', 'product', 'كرفان 6 متر', 'CV6', 4500000);
      insert into cost_centers (org_id, code, name, project_type, product_item_id, production_qty, status)
        select '{org}', 'P-001', 'دفعة كرفانات أكتوبر', 'production', id, 2, 'closed' from items where sku = 'CV6';
      begin;
      with e as (insert into journal_entries (org_id, number, entry_date, memo, source_type) values ('{org}', 900, current_date - 20, 'seed', 'manual') returning id),
        a as (select system_key, code, id from accounts where org_id = '{org}'), c as (select id from cost_centers where code = 'P-001')
      insert into journal_lines (entry_id, org_id, account_id, cost_center_id, debit, credit)
        select e.id, '{org}'::uuid, (select id from a where system_key = 'cogs'), (select id from c), 3000000, 0 from e union all
        select e.id, '{org}'::uuid, (select id from a where system_key = 'salaries'), (select id from c), 800000, 0 from e union all
        select e.id, '{org}'::uuid, (select id from a where code = '5205'), (select id from c), 200000, 0 from e union all
        select e.id, '{org}'::uuid, (select id from a where code = '5203'), null, 1200000, 0 from e union all
        select e.id, '{org}'::uuid, (select id from a where system_key = 'cash'), null, 3800000, 0 from e union all
        select e.id, '{org}'::uuid, (select id from a where system_key = 'sales'), (select id from c), 0, 9000000 from e;
      commit;""")
    cc = one("select id from cost_centers where code='P-001'")

    # ---------- the formulas, checked against an independent calculation ----------
    go('#/feasibility', 1200)
    check('nav has feasibility studies', 'دراسات الجدوى' in pg.inner_text('.nav'))
    check('empty state explains', 'لا توجد دراسات بعد' in main(), main()[:200])
    calc = pg.evaluate("""() => { const { fsDefaults, feasCalc } = window.__fs; const I = fsDefaults('product'); I.my_price.v = 1000; I.volume.v = 1; I.materials.v = 400; I.fixed = [{name:'x', v: 200}]; I.capex = [{name:'c', v: 1000}];
      I.months = 12; I.discount = 0; I.zakat = 0; const r = feasCalc(I, 'product'); return { be: r.be, payback: r.payback, npv: r.npv, irr: r.irr, cm: r.cm }; }""")
    check('break-even = fixed / unit margin', abs(calc['be'] - 200 / 600) < 1e-9, calc)
    check('payback = capex / monthly net', abs(calc['payback'] - 1000 / 400) < 1e-9, calc)
    check('NPV at 0% = total net − capex', abs(calc['npv'] - (400 * 12 - 1000)) < 1e-6, calc)
    check('IRR matches independent bisection', abs(calc['irr'] - irr_monthly(1000, [400] * 12)) < 1e-6, calc)
    check('unit margin %', abs(calc['cm'] - 0.6) < 1e-9, calc)
    neg = pg.evaluate("() => { const { fsDefaults, feasCalc } = window.__fs; const I = fsDefaults('product'); I.my_price.v = 100; I.materials.v = 150; I.fixed=[{name:'x',v:10}]; I.capex=[{name:'c',v:100}]; const r = feasCalc(I,'product'); return {be:r.be, never:r.beNever, payback:r.payback, irr:r.irr}; }")
    check('price below cost → break-even never, no payback, no IRR', neg['be'] is None and neg['never'] and neg['payback'] is None and neg['irr'] is None, neg)

    # ---------- new study from the past project ----------
    pg.click('#newfs'); pg.wait_for_timeout(500)
    check('two study types', pg.locator('.drawer .ptype').count() == 2)
    pg.fill('.drawer #f-name', 'كرفان 6 متر — الدفعة الجديدة'); pg.select_option('.drawer #f-start', 'cc'); pg.wait_for_timeout(200); pg.select_option('.drawer #f-cc', cc); submit(2000)
    sid = one("select id from feasibility_studies")
    check('study created and opened', sid and f'#/feasibility/{sid}' in pg.url, pg.url + ' ' + err())
    vals = {k: pg.input_value(f'#fs-{k}') for k in ['my_price', 'materials', 'labor', 'other_var']}
    check('per-unit numbers pulled from the project (÷ 2 units)', vals == {'my_price': '45000', 'materials': '15000', 'labor': '4000', 'other_var': '1000'}, vals)
    check('their source shows «من السجل» with the project name', pg.input_value('[data-src=materials]') == 'history' and 'دفعة كرفانات أكتوبر' in pg.inner_text('#ref-materials'), pg.inner_text('#ref-materials'))
    pg.fill('#fs-market_price', '50000'); pg.wait_for_timeout(300)
    check('price comparison to market', 'أقل من السوق' in pg.inner_text('#pcmp'), pg.inner_text('#pcmp'))
    check('unit margin = 45,000 − 20,000', '25,000.00' in res(), res()[:300])
    pg.fill('[data-row="capex:0:v"]', '100000'); pg.fill('[data-row="capex:1:v"]', '0'); pg.wait_for_timeout(300)
    check('payback ≈ 100,000 ÷ (25,000 × 97.5%) = 4.1 months', '4.1 شهر' in res(), res()[:500])
    pg.fill('#fs-materials', '16000'); pg.wait_for_timeout(200)
    check('editing a pulled number flips its source to «يدوي»', pg.input_value('[data-src=materials]') == 'manual' and pg.inner_text('#ref-materials') == '')
    saved()
    inp = json.loads(one(f"select inputs from feasibility_studies where id='{sid}'"))
    check('autosaved with sources', inp['materials'] == {'v': 1600000, 'src': 'manual'} and inp['labor']['src'] == 'history' and inp['market_price']['v'] == 5000000, inp.get('materials'))

    # ---------- re-pull one number from the past project via its source picker ----------
    pg.select_option('[data-src=materials]', 'history'); pg.wait_for_timeout(600)
    check('source picker opens the history drawer', pg.locator('.drawer').count() == 1 and 'أرقام من السجل' in pg.inner_text('.drawer'))
    pg.select_option('.drawer #f-hsrc', cc); pg.wait_for_timeout(900)
    check('only the picked number is pre-ticked', pg.locator('.drawer [name=ap_materials]').is_checked() and not pg.locator('.drawer [name=ap_labor]').is_checked())
    submit()
    check('materials back from the project', pg.input_value('#fs-materials') == '15000' and pg.input_value('[data-src=materials]') == 'history')

    # ---------- company overheads ----------
    pg.click('#fsoh'); pg.wait_for_timeout(800)
    dr = pg.inner_text('.drawer')
    check('overheads: rent averaged over 12 months, project costs excluded', 'الإيجار' in dr and '1,000.00' in dr and 'الوقود' not in dr, dr[:400])
    pg.check('.drawer [name=oh_0]'); pg.fill('.drawer [name=sh_0]', '50'); pg.check('.drawer [name=replace]'); submit()
    rows = pg.locator('#rows-fixed .fs-row').count()
    check('overhead share added as a fixed cost; empty rows replaced', rows == 1 and pg.input_value('[data-row="fixed:0:v"]') == '500' and pg.input_value('[data-src="fixed:0"]') == 'history', rows)
    pg.click('[data-add=fixed]'); pg.fill('[data-row="fixed:1:name"]', 'تسويق'); pg.fill('[data-row="fixed:1:v"]', '1500'); pg.wait_for_timeout(300)
    check('break-even shown in units/month', 'وحدة/شهر' in res() and re.search(r'0\.08 وحدة/شهر', res()), re.findall(r'[\d.]+ وحدة/شهر', res()))

    # ---------- AI export ----------
    pg.click('#aiout'); pg.wait_for_timeout(500)
    txt = pg.input_value('.drawer #aitxt')
    check('prompt has the numbers and the JSON format', '45,000' in txt and '```json' in txt and '"market_price"' in txt and '"risks"' in txt, txt[:300])
    check('names hidden by default', 'كرافت لاند' not in txt and 'دفعة كرفانات أكتوبر' not in txt and 'من سجلاتنا الفعلية' in txt)
    pg.uncheck('.drawer [name=anon]'); pg.check('.drawer [name=t_narrative]'); pg.wait_for_timeout(200); txt2 = pg.input_value('.drawer #aitxt')
    check('names shown when you choose; narrative requested', 'كرافت لاند' in txt2 and '"narrative"' in txt2)
    with pg.expect_download() as dl: pg.click('.drawer #aidl')
    check('prompt downloads as a file', dl.value.suggested_filename.endswith('.md'), dl.value.suggested_filename)
    pg.click('.drawer [type=submit]'); pg.wait_for_timeout(500)
    check('copy closes the drawer', pg.locator('.drawer').count() == 0)

    # ---------- AI import ----------
    pg.click('#aiin'); pg.wait_for_timeout(400)
    pg.fill('.drawer #aiin-t', 'تمام، هذه تقديراتي:\n```json\n{"market_price": "52,000", "price_min": 48000, "price_max": 56000, "monthly_volume": 1.5, "growth_pct": 2, "materials_per_unit": null,'
            ' "scenarios": {"optimistic": {"price": 5, "volume": 25, "cost": -5}, "pessimistic": {"price": -12, "volume": -40, "cost": 20}},'
            ' "risks": ["ارتفاع أسعار الحديد"], "recommendations": ["ابدأ بدفعة صغيرة"], "narrative": "الطلب على الكرفانات مرتفع في موسم الشتاء."}\n```\nبالتوفيق')
    pg.click('.drawer #aiin-r'); pg.wait_for_timeout(300)
    pv = pg.inner_text('.drawer #aiin-p')
    check('reply parsed into a review table', 'سعر السوق' in pv and '52,000.00' in pv and 'الكمية الشهرية' in pv and 'النطاق المقترح 48,000 إلى 56,000' in pv, pv[:400])
    check('null keys are skipped; scenarios offered but not pre-ticked', 'المواد للوحدة' not in pv and pg.locator('.drawer [name=a_scen]').count() == 1 and not pg.locator('.drawer [name=a_scen]').is_checked())
    pg.uncheck('.drawer [name=a_growth]'); submit()
    check('AI numbers applied with source «ذكاء اصطناعي»', pg.input_value('#fs-market_price') == '52000' and pg.input_value('[data-src=market_price]') == 'ai' and pg.input_value('#fs-volume') == '1.5', pg.input_value('#fs-market_price'))
    check('unticked suggestion left alone', pg.input_value('#fs-growth') == '0')
    check('written analysis saved with risks & recommendations', 'موسم الشتاء' in main() and 'ارتفاع أسعار الحديد' in main() and 'ابدأ بدفعة صغيرة' in main())
    saved()
    check('AI import autosaved', one(f"select inputs->'market_price'->>'src' from feasibility_studies where id='{sid}'") == 'ai' and 'موسم الشتاء' in one(f"select ai_notes from feasibility_studies where id='{sid}'"))
    pg.click('#aiin'); pg.wait_for_timeout(300); pg.fill('.drawer #aiin-t', 'ما عندي أرقام'); pg.click('.drawer #aiin-r'); pg.wait_for_timeout(200)
    check('a reply without JSON is explained', 'ما قدرت أقرأ JSON' in pg.inner_text('.drawer'))
    pg.click('.drawer [data-close]'); pg.wait_for_timeout(200)

    # ---------- scenarios & verdict ----------
    pg.fill('[data-scen="pess:volume"]', '-95'); pg.wait_for_timeout(300)
    check('verdict badge and three-scenario comparison', re.search('مجدية', res()) and 'متشائم' in res() and 'متفائل' in res(), res()[:200])
    check('cumulative cash chart with three lines', pg.locator('#fsres svg.fs-chart polyline').count() == 3)
    pg.select_option('#fs-status', 'approved'); saved()
    check('status saved', one(f"select status from feasibility_studies where id='{sid}'") == 'approved')
    shot('editor')

    # ---------- printed report ----------
    go(f'#/feasibility/{sid}/print', 1200)
    m = main()
    check('report: summary, assumptions with sources, yearly cash flow', 'دراسة جدوى' in m and 'الافتراضات ومصدر كل رقم' in m and 'من السجل' in m and 'ذكاء اصطناعي' in m and 'التدفق النقدي السنوي' in m, m[:300])
    check('report carries the written analysis', 'موسم الشتاء' in m)
    check('report uses the company design but no bank details or invoice terms', pg.locator('.paper.tpl-classic').count() == 1 and 'بيانات التحويل البنكي' not in m and 'الدفعة مقدمة' not in m)
    shot('print')

    # ---------- investment study ----------
    go('#/feasibility', 1000); pg.click('#newfs'); pg.wait_for_timeout(400)
    pg.fill('.drawer #f-name', 'مكينة قص بلازما'); pg.click('.drawer .ptype:has(input[value=investment])'); submit(2000)
    check('investment study opens with income instead of price × quantity', pg.locator('#fs-income').count() == 1 and pg.locator('#fs-my_price').count() == 0)
    pg.fill('#fs-income', '9000'); pg.fill('#fs-opex', '1000'); pg.fill('[data-row="capex:0:v"]', '150000'); pg.fill('[data-row="fixed:0:v"]', '0'); pg.wait_for_timeout(300)
    check('investment shows payback and IRR', 'مدة الاسترداد' in res() and re.search(r'معدل العائد الداخلي\s*[\d.,]+٪', res()), res()[:400])
    saved()
    go('#/feasibility', 1200)
    check('list shows both studies with results', 'كرفان 6 متر — الدفعة الجديدة' in main() and 'مكينة قص بلازما' in main() and 'معتمدة' in main(), main()[:400])
    shot('list')

    # ---------- permission module appears in the roles editor ----------
    go('#/users', 1200)
    if pg.locator('#newr').count():
        pg.locator('#newr').first.click(); pg.wait_for_timeout(400)
        check('roles editor offers the feasibility permission', 'دراسات الجدوى' in pg.inner_text('.drawer'))
        pg.click('.drawer [data-close]')
    check('no page errors', not errs, errs[:3])
    b.close()
shim.terminate()
print(f'{sum(results)}/{len(results)} passed')
sys.exit(0 if all(results) else 1)
