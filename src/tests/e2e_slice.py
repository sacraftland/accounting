"""End-to-end test of the vertical slice. Run: python3 tests/e2e_slice.py
Serves app/index.html on localhost, drives Chrome, decodes the invoice QR."""
import base64, http.server, threading, functools, pathlib, sys, json
import cv2, numpy as np
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOTS = ROOT / 'clone-screens'; SHOTS.mkdir(exist_ok=True)
H = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / 'app'))
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8765), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = 'http://127.0.0.1:8765/index.html'
results = []
def check(name, cond, extra=''):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name + (f'  [{extra}]' if extra else ''))

def decode_qr(page, sel):
    png = page.locator(sel).screenshot()
    img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_GRAYSCALE)
    img = cv2.resize(img, None, fx=3, fy=3, interpolation=cv2.INTER_NEAREST)
    val, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
    if not val: return None
    b = base64.b64decode(val); out = {}; i = 0
    while i < len(b): t, l = b[i], b[i+1]; out[t] = b[i+2:i+2+l].decode(); i += 2 + l
    return out

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, locale='ar-SA', timezone_id='Asia/Riyadh')
    pg = ctx.new_page(); errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('requestfailed', lambda r: errors.append('request failed: ' + r.url) if '127.0.0.1' in r.url else None)
    pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text else None)
    pg.goto(URL); pg.wait_for_selector('#authf')
    check('first visit shows sign-up', 'ابدأ تجربتك' in pg.inner_text('#app'))
    pg.screenshot(path=str(SHOTS / 'S02.png'))
    # validation
    pg.fill('#f-email', 'bad'); pg.fill('#f-pw', 'x'); pg.click('[type=submit]')
    check('sign-up rejects bad email', 'صحيحاً' in pg.inner_text('#aerr'))
    pg.fill('#f-email', 'ali@craftland.sa'); pg.fill('#f-pw', 'short'); pg.click('[type=submit]'); pg.wait_for_timeout(200)
    check('sign-up rejects short password', '8 أحرف' in pg.inner_text('#aerr'))
    pg.fill('#f-pw', 'StrongPass123'); pg.click('[type=submit]'); pg.wait_for_selector('#orgf')
    check('after sign-up → company setup', True)
    pg.screenshot(path=str(SHOTS / 'S05.png'))
    pg.fill('#f-name_ar', 'كرافت لاند'); pg.fill('#f-vat_number', '123'); pg.fill('#f-city', 'الرياض'); pg.click('#orgf [type=submit]')
    check('company rejects bad VAT', '15' in pg.inner_text('#oerr'))
    pg.fill('#f-vat_number', '٣٠٠٠٠٠٠٠٠٠٠٠٠٠٣')  # Arabic digits
    pg.fill('#f-cr_number', '1010000000'); pg.fill('#f-district', 'الصناعية الثانية'); pg.fill('#f-street', 'طريق الخرج'); pg.fill('#f-building_no', '1234'); pg.fill('#f-postal_code', '14331')
    pg.click('#orgf [type=submit]'); pg.wait_for_selector('.stat')
    check('company created → dashboard (Arabic digits accepted)', 'لوحة التحكم' in pg.inner_text('#main'))
    check('dashboard empty state', 'لا توجد فواتير بعد' in pg.inner_text('#main'))
    pg.screenshot(path=str(SHOTS / 'S06-empty.png'))
    # chart of accounts
    pg.goto(URL + '#/accounts'); pg.wait_for_selector('.tree-tbl')
    check('chart of accounts has 58 accounts', '58 حساباً' in pg.inner_text('#main'))
    pg.screenshot(path=str(SHOTS / 'S25.png'))
    # customers
    pg.goto(URL + '#/customers'); pg.wait_for_selector('#newp'); pg.click('#newp')
    pg.fill('#f-name', 'مؤسسة الواحة للمقاولات'); pg.fill('#f-vat_number', '31111111111111'); pg.click('.drawer [type=submit]'); pg.wait_for_timeout(150)
    check('customer rejects bad VAT', '15' in pg.inner_text('.drawer [data-err]'))
    pg.fill('#f-vat_number', '311111111111113'); pg.fill('#f-city', 'جدة'); pg.fill('#f-street', 'شارع الملك فهد'); pg.fill('#f-building_no', '4410'); pg.fill('#f-postal_code', '23511')
    pg.click('.drawer [type=submit]'); pg.wait_for_selector('.list-tbl')
    pg.click('#newp'); pg.wait_for_selector('.drawer'); pg.fill('#f-name', 'محمد — عميل فرد بلا رقم ضريبي'); pg.click('.drawer [type=submit]'); pg.wait_for_timeout(300)
    check('two customers listed', pg.locator('.list-tbl tbody tr').count() == 2)
    pg.screenshot(path=str(SHOTS / 'S08.png'))
    # items
    pg.goto(URL + '#/items'); pg.wait_for_selector('#newi'); pg.click('#newi')
    pg.fill('#f-name_ar', 'كرفان مكتبي 6×3 م'); pg.fill('#f-sku', 'CRV-6x3'); pg.fill('#f-sale_price', '50,000'); pg.fill('#f-avg_cost', '32000'); pg.click('.drawer [type=submit]'); pg.wait_for_selector('.list-tbl')
    pg.click('#newi'); pg.wait_for_selector('.drawer'); pg.select_option('#f-kind', 'service'); pg.fill('#f-name_ar', 'نقل وتركيب'); pg.fill('#f-sale_price', '3500'); pg.click('.drawer [type=submit]'); pg.wait_for_timeout(300)
    pg.click('#newi'); pg.wait_for_selector('.drawer'); pg.fill('#f-name_ar', 'كرفان تصدير'); pg.fill('#f-sale_price', '40000'); pg.select_option('#f-tax_category', 'Z'); pg.click('.drawer [type=submit]'); pg.wait_for_timeout(150)
    check('zero-rated item requires a reason', 'سبب' in pg.inner_text('.drawer [data-err]'))
    pg.keyboard.press('Escape'); pg.wait_for_timeout(100)
    check('Esc closes the drawer', pg.locator('.drawer').count() == 0)
    check('two items listed', pg.locator('.list-tbl tbody tr').count() == 2)
    pg.screenshot(path=str(SHOTS / 'S09.png'))
    # invoice: tax invoice to a customer without VAT number must be blocked
    pg.goto(URL + '#/invoices/new'); pg.wait_for_selector('#invf')
    pg.select_option('#f-party', label='محمد — عميل فرد بلا رقم ضريبي (بدون رقم ضريبي)')
    check('warns: customer has no VAT number', 'بلا رقم ضريبي' in pg.inner_text('#kindwarn'))
    pg.select_option('#f-party', label='مؤسسة الواحة للمقاولات')
    check('warning clears for a valid customer', pg.locator('#kindwarn').is_hidden())
    pg.select_option('tr[data-i="0"] [data-k=item_id]', label='كرفان مكتبي 6×3 م')
    pg.fill('tr[data-i="0"] [data-k=qty]', '٢')
    pg.click('#addl'); pg.select_option('tr[data-i="1"] [data-k=item_id]', label='نقل وتركيب'); pg.fill('tr[data-i="1"] [data-k=discount]', '500')
    tot = pg.inner_text('#tTot')
    # 2 x 50,000 = 100,000 ; 3,500 - 500 = 3,000 ; subtotal 103,000 ; VAT 15,450 ; total 118,450
    check('live total = 118,450.00', '118,450.00' in tot, tot)
    pg.screenshot(path=str(SHOTS / 'S10.png'))
    pg.click('#invf [type=submit]'); pg.wait_for_selector('article.paper')
    check('invoice posted with number', 'INV-00001' in pg.inner_text('#main'))
    txt = pg.inner_text('#main')
    check('journal shows AR 118,450 / sales / service / VAT / COGS', all(s in txt for s in ['118,450.00', '100,000.00', '3,000.00', '15,450.00', '64,000.00']))
    qr = decode_qr(pg, 'article.paper svg[aria-label=QR]')
    check('QR decodes to ZATCA TLV', qr is not None, json.dumps(qr, ensure_ascii=False) if qr else 'no decode')
    if qr: check('QR fields correct', qr[1] == 'كرافت لاند' and qr[2] == '300000000000003' and qr[4] == '118450.00' and qr[5] == '15450.00' and qr[3].endswith('Z'), qr[3])
    pg.screenshot(path=str(SHOTS / 'S11.png'), full_page=True)
    # partial receipt from the invoice
    pg.click('text=تسجيل دفعة'); pg.wait_for_selector('#rf')
    check('receipt prefilled with remaining 118,450.00', pg.input_value('#f-amount') == '118,450.00')
    pg.fill('#f-amount', '50000'); pg.wait_for_timeout(100)
    check('auto-allocates 50,000 to the invoice', pg.input_value('[data-doc]') == '50,000.00')
    pg.fill('#f-reference', 'TRX-1001'); pg.screenshot(path=str(SHOTS / 'S14.png'))
    pg.click('#rf [type=submit]'); pg.wait_for_selector('article.paper')
    txt = pg.inner_text('#main')
    check('invoice now partial with 68,450 left', 'مدفوع جزئياً' in txt and '68,450.00' in txt)
    # trying to over-allocate must fail
    pg.goto(URL + '#/receipts/new'); pg.wait_for_selector('#rf'); pg.select_option('#f-party', label='مؤسسة الواحة للمقاولات')
    pg.fill('#f-amount', '100000'); pg.fill('[data-doc]', '90000'); pg.click('#rf [type=submit]'); pg.wait_for_timeout(150)
    check('over-allocation rejected', 'يتجاوز' in pg.inner_text('#rerr'))
    # trial balance
    pg.goto(URL + '#/trial-balance'); pg.wait_for_selector('table')
    txt = pg.inner_text('#main')
    check('trial balance is balanced', 'متوازن ✓' in txt)
    check('trial balance totals 232,450', '232,450.00' in txt)  # debits: AR 118,450 + COGS 64,000 + bank 50,000
    pg.screenshot(path=str(SHOTS / 'S33.png'))
    # statement
    pg.goto(URL + '#/customers'); pg.click('text=مؤسسة الواحة للمقاولات'); pg.wait_for_selector('.kv')
    check('customer statement balance 68,450', '68,450.00' in pg.inner_text('#main'))
    # dashboard filled
    pg.goto(URL + '#/dashboard'); pg.wait_for_selector('.stat')
    txt = pg.inner_text('#main')
    check('dashboard: sales 103,000 / AR 68,450 / cash 50,000', all(s in txt for s in ['103,000.00', '68,450.00', '50,000.00']))
    pg.screenshot(path=str(SHOTS / 'S06.png'))
    # posted invoice cannot be edited
    pg.goto(URL + '#/invoices'); pg.wait_for_selector('.list-tbl')
    inv_id = pg.get_attribute('.list-tbl tbody tr', 'data-href').split('/')[-1]
    pg.goto(URL + f'#/invoices/{inv_id}/edit'); pg.wait_for_timeout(300)
    check('editing a posted invoice redirects to the read-only view', pg.locator('article.paper').count() == 1)
    # draft flow
    pg.goto(URL + '#/invoices/new'); pg.wait_for_selector('#invf'); pg.select_option('#f-kind', 'simplified_invoice')
    pg.fill('tr[data-i="0"] [data-k=description]', 'صيانة باب'); pg.fill('tr[data-i="0"] [data-k=unit_price]', '200'); pg.click('#saved'); pg.wait_for_selector('#invf'); pg.wait_for_timeout(300)
    check('draft saved and reopens in editor', 'تعديل مسودة' in pg.inner_text('#main'))
    # keyboard: Enter in last line adds a line
    pg.focus('tr[data-i="0"] [data-k=qty]'); pg.keyboard.press('Enter'); pg.wait_for_timeout(100)
    check('Enter on the last line adds a new line', pg.locator('#lines tr').count() == 2)
    # long name
    pg.goto(URL + '#/customers'); pg.click('#newp'); pg.wait_for_selector('.drawer'); pg.fill('#f-name', 'شركة ' + 'المؤسسة العربية الحديثة للتجارة والمقاولات ' * 2); pg.click('.drawer [type=submit]'); pg.wait_for_timeout(300)
    check('long names do not widen the page', not pg.evaluate('document.documentElement.scrollWidth > innerWidth'))
    # reload persists, sign out / in
    pg.reload(); pg.wait_for_selector('.list-tbl')
    check('data survives reload', pg.locator('.list-tbl tbody tr').count() == 3)
    pg.click('[data-act=signout]'); pg.wait_for_selector('#authf')
    pg.fill('#f-email', 'ali@craftland.sa'); pg.fill('#f-pw', 'wrong-pass'); pg.click('[type=submit]'); pg.wait_for_timeout(300)
    check('wrong password rejected', 'غير صحيحة' in pg.inner_text('#aerr'))
    pg.fill('#f-pw', 'StrongPass123'); pg.click('[type=submit]'); pg.wait_for_selector('.stat')
    check('sign back in', True)
    # demo seed on a fresh account
    pg.goto(URL + '#/settings'); pg.wait_for_selector('#demo'); pg.click('#demo'); pg.wait_for_selector('.stat'); pg.wait_for_timeout(300)
    pg.goto(URL + '#/trial-balance'); pg.wait_for_selector('table')
    check('after demo data: still balanced', 'متوازن ✓' in pg.inner_text('#main'))
    # mobile
    m = ctx.new_page(); m.set_viewport_size({'width': 390, 'height': 844}); m.on('pageerror', lambda e: errors.append(str(e)))
    for route, name in [('#/dashboard', 'S06-m'), ('#/invoices', 'S10l-m'), ('#/invoices/new', 'S10-m'), (f'#/invoices/{inv_id}', 'S11-m'), ('#/receipts/new', 'S14-m'), ('#/trial-balance', 'S33-m'), ('#/customers', 'S08-m'), ('#/settings', 'S40-m')]:
        m.goto(URL + route); m.wait_for_timeout(500)
        wide = m.evaluate('document.documentElement.scrollWidth > innerWidth + 1')
        check(f'mobile {route} fits 390px', not wide)
        m.screenshot(path=str(SHOTS / f'{name}.png'), full_page=True)
    check('no console errors', not errors, '; '.join(errors[:3]))
    b.close()
srv.shutdown()
failed = [n for n, ok in results if not ok]
print(f'\n{len(results) - len(failed)}/{len(results)} passed')
sys.exit(1 if failed else 0)
