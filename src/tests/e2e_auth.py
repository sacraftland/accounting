"""Browser test of the Supabase sign-in screens. Run: python3 tests/e2e_auth.py
The real supabase-js is swapped for a small stand-in that records every call
and answers the way Supabase Auth does, so the screens and redirects can be
checked without a live project. (The database side is tested separately in
tests/run_supabase_tests.sh.)"""
import http.server, threading, functools, pathlib, json, re
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
H = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / 'app'))
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8766), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = 'http://127.0.0.1:8766/index.html'
CDN = re.compile(r'.*supabase-js.*')
results = []
def check(name, cond, extra=''):
    results.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + name + (f'  [{extra}]' if extra else ''))

FAKE = r"""
window.__calls = [];
window.supabase = { createClient(url, key, opts) {
  const log = (n, a) => __calls.push([n, JSON.parse(JSON.stringify(a ?? null))]);
  log('createClient', { url, key, opts });
  let session = JSON.parse(localStorage.getItem('fake-session') || 'null'); const subs = [];
  const emit = (e, s) => subs.forEach(f => f(e, s));
  const h = new URLSearchParams(location.hash.slice(1));
  const init = (async () => {
    if (h.get('access_token')) { session = { access_token: h.get('access_token'), user: { id: 'u1', email: 'ali@example.com' } };
      localStorage.setItem('fake-session', JSON.stringify(session)); history.replaceState(null, '', location.pathname);
      emit(h.get('type') === 'recovery' ? 'PASSWORD_RECOVERY' : 'SIGNED_IN', session); }
  })();
  const q = (table) => { const st = { table, ops: [] }; const p = new Proxy({}, { get(_, k) {
      if (k === 'then') { log('from', st); const empty = ['single', 'maybeSingle'].some(o => st.ops.includes(o)) ? null : [];
        return (res) => res({ data: window.__tables?.[table] ?? empty, error: null }); }
      return (...a) => { st.ops.push(k); return p; }; } }); return p; };
  return {
    auth: {
      async getSession() { await init; return { data: { session } }; },
      async getUser() { await init; return { data: { user: session?.user || null } }; },
      onAuthStateChange(f) { subs.push(f); return { data: { subscription: { unsubscribe() {} } } }; },
      async signUp(a) { log('signUp', a); if (a.email === 'stranger@example.com') return { data: {}, error: { message: 'Database error saving new user' } };
        if (a.email === 'taken@example.com') return { data: { user: { identities: [] }, session: null }, error: null };
        return { data: { user: { id: 'u1', identities: [{}] }, session: null }, error: null }; },
      async signInWithPassword(a) { log('signInWithPassword', a); if (a.password !== 'goodpass1') return { data: {}, error: { message: 'Invalid login credentials' } };
        session = { user: { id: 'u1', email: a.email } }; localStorage.setItem('fake-session', JSON.stringify(session)); emit('SIGNED_IN', session); return { data: { user: session.user, session }, error: null }; },
      async signInWithOtp(a) { log('signInWithOtp', a); return { data: {}, error: null }; },
      async signInWithOAuth(a) { log('signInWithOAuth', a); return { data: { url: 'https://accounts.google.com/x' }, error: null }; },
      async resetPasswordForEmail(e, o) { log('resetPasswordForEmail', { e, o }); return { data: {}, error: null }; },
      async updateUser(a) { log('updateUser', a); return { data: { user: session.user }, error: null }; },
      async resend(a) { log('resend', a); return { data: {}, error: null }; },
      async signOut() { log('signOut'); session = null; localStorage.removeItem('fake-session'); emit('SIGNED_OUT', null); return { error: null }; },
    },
    from: q,
    async rpc(n, a) { log('rpc:' + n, a); const r = window.__rpc?.[n];
      return { data: r !== undefined ? r : '11111111-1111-1111-1111-111111111111', error: window.__rpcErr?.[n] ? { message: window.__rpcErr[n] } : null }; },
  };
} };
"""
CFG = "localStorage.setItem('daftar-backend', JSON.stringify({url:'https://abcd.supabase.co', key:'anon-key-anon-key-anon-key-anon-key-1234'}));"

OWNER_RPC = "window.__rpc = { whoami: { email: 'sa.craft.land@gmail.com', is_platform_admin: true }, accept_invitations: 0 };"
def calls(pg, name): return [a for n, a in pg.evaluate('window.__calls') if n == name]

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    def fresh(init_hash='', extra=''):
        ctx = b.new_context(viewport={'width': 1280, 'height': 860}, locale='ar-SA')
        ctx.route(CDN, lambda r: r.fulfill(status=200, content_type='application/javascript', body=FAKE))
        ctx.route(re.compile(r'https://fonts\..*'), lambda r: r.fulfill(status=200, body=''))
        ctx.add_init_script(CFG + extra)
        pg = ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(URL + init_hash); pg.wait_for_timeout(500)
        return ctx, pg, errs

    # 1. login screen shows Google + magic link + forgot
    ctx, pg, errs = fresh('#/login', OWNER_RPC)
    check('client created with implicit flow', calls(pg, 'createClient')[0]['opts']['auth']['flowType'] == 'implicit')
    check('login: Google button', pg.locator('#google').is_visible())
    check('login: magic-link button', pg.locator('#magic').is_visible())
    check('login: forgot-password link', pg.locator('a[href="#/forgot"]').is_visible())
    check('login: no "trial mode" note on server', pg.locator('.note').count() == 0)
    pg.screenshot(path=str(ROOT / 'clone-screens' / 'S03-supabase.png'))

    pg.click('#google'); pg.wait_for_timeout(200)
    g = calls(pg, 'signInWithOAuth')
    check('Google: provider google, back to app URL', g and g[0]['provider'] == 'google' and g[0]['options']['redirectTo'] == URL, g)

    pg.click('#magic'); check('magic link: asks for email first', 'اكتب بريدك' in pg.inner_text('#aerr'))
    pg.fill('#f-email', 'ali@example.com'); pg.click('#magic'); pg.wait_for_timeout(200)
    m = calls(pg, 'signInWithOtp')
    check('magic link: sent with redirect', m and m[0]['options']['emailRedirectTo'] == URL)
    check('magic link: "check your email" screen', 'أرسلنا رابط دخول' in pg.inner_text('#app'))

    # wrong password → Arabic message
    pg.click('#toLogin'); pg.wait_for_timeout(300)
    check('"back to login" works from same route', pg.locator('#authf').count() == 1)
    pg.fill('#f-email', 'ali@example.com'); pg.fill('#f-pw', 'nope'); pg.click('#authf [type=submit]'); pg.wait_for_timeout(300)
    check('wrong password: Arabic error', pg.inner_text('#aerr') == 'البريد أو كلمة المرور غير صحيحة', pg.inner_text('#aerr'))

    # sign-up needing confirmation
    pg.goto(URL + '#/signup'); pg.wait_for_timeout(300)
    check('signup: Google button too', pg.locator('#google').is_visible())
    pg.fill('#f-email', 'new@example.com'); pg.fill('#f-pw', 'short'); pg.click('#authf [type=submit]'); pg.wait_for_timeout(200)
    check('signup: short password blocked', '8 أحرف' in pg.inner_text('#aerr'))
    pg.fill('#f-pw', 'goodpass1'); pg.click('#authf [type=submit]'); pg.wait_for_timeout(300)
    su = calls(pg, 'signUp')
    check('signup: email confirmation redirect set', su and su[-1]['options']['emailRedirectTo'] == URL)
    check('signup: "confirm your email" screen', 'أرسلنا رابط تأكيد' in pg.inner_text('#app'))
    pg.click('#resend'); pg.wait_for_timeout(200)
    check('signup: resend confirmation', len(calls(pg, 'resend')) == 1)
    pg.reload(); pg.wait_for_timeout(400)
    pg.fill('#f-email', 'taken@example.com'); pg.fill('#f-pw', 'goodpass1'); pg.click('#authf [type=submit]'); pg.wait_for_timeout(300)
    check('signup: existing email → "sign in" message', 'مسجّل' in pg.inner_text('#aerr'))
    pg.fill('#f-email', 'stranger@example.com'); pg.fill('#f-pw', 'goodpass1'); pg.click('#authf [type=submit]'); pg.wait_for_timeout(300)
    check('signup: not-invited email → clear Arabic message', 'غير مدعو' in pg.inner_text('#aerr'), pg.inner_text('#aerr'))

    # forgot password
    pg.goto(URL + '#/forgot'); pg.wait_for_timeout(300)
    pg.fill('#f-email', 'ali@example.com'); pg.click('#ff [type=submit]'); pg.wait_for_timeout(300)
    r = calls(pg, 'resetPasswordForEmail')
    check('forgot: reset email with redirect', r and r[0]['o']['redirectTo'] == URL)
    pg.screenshot(path=str(ROOT / 'clone-screens' / 'S03-forgot.png'))

    # sign in → no company yet → onboarding → create_org RPC
    pg.click('#toLogin'); pg.wait_for_timeout(300)
    pg.fill('#f-email', 'ali@example.com'); pg.fill('#f-pw', 'goodpass1'); pg.click('#authf [type=submit]'); pg.wait_for_timeout(600)
    check('sign in → invitations accepted first', len(calls(pg, 'rpc:accept_invitations')) >= 1)
    check('owner with no company → company setup screen', pg.locator('#f-name_ar').count() == 1)
    check('no page errors', not errs, errs)
    ctx.close()

    # 1b. signed-in user who was never added to a company
    ctx, pg, errs = fresh('#access_token=tok2&expires_in=3600', "window.__rpc = { whoami: { email: 'x@example.com', is_platform_admin: false }, accept_invitations: 0 };")
    pg.wait_for_timeout(500)
    check('no company + not owner → "ask for an invite" screen', 'غير مرتبط بشركة' in pg.inner_text('#app'))
    check('…and no company-setup form', pg.locator('#f-name_ar').count() == 0)
    pg.click('#again'); pg.wait_for_timeout(300)
    check('"check again" re-runs accept', len(calls(pg, 'rpc:accept_invitations')) >= 3)
    ctx.close()

    # 1c. Google sign-in with an email that was not invited
    ctx, pg, errs = fresh('#error=server_error&error_code=unexpected_failure&error_description=Database+error+saving+new+user')
    pg.wait_for_timeout(300)
    check('Google, not invited → clear Arabic message', 'غير مدعو' in pg.inner_text('#app'))
    ctx.close()

    # 2. coming back from the reset-password email
    ctx, pg, errs = fresh('#access_token=tok&type=recovery&expires_in=3600')
    pg.wait_for_timeout(400)
    check('recovery link → new-password screen', pg.locator('#f-pw2').count() == 1, pg.url)
    check('recovery: token removed from address bar', 'access_token' not in pg.url)
    pg.fill('#f-pw', 'newpass123'); pg.fill('#f-pw2', 'newpass12'); pg.click('#rf [type=submit]'); pg.wait_for_timeout(200)
    check('recovery: mismatch caught', 'غير متطابقتين' in pg.inner_text('#rerr'))
    pg.fill('#f-pw2', 'newpass123'); pg.click('#rf [type=submit]'); pg.wait_for_timeout(500)
    check('recovery: password updated', calls(pg, 'updateUser') == [{'password': 'newpass123'}])
    check('recovery: continues into the app', pg.locator('#f-pw2').count() == 0)
    ctx.close()

    # 3. expired link
    ctx, pg, errs = fresh('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired')
    pg.wait_for_timeout(300)
    check('expired link: clear Arabic message', 'انتهت صلاحية الرابط' in pg.inner_text('#app'))
    check('expired link: lands on login', pg.url.endswith('#/login'))
    ctx.close()

    # 4. Google return (signed in, company exists) → dashboard, sign out works
    ctx, pg, errs = fresh('#access_token=googletok&token_type=bearer&expires_in=3600',
        "window.__tables = { members: [{ org_id: 'o1', role: 'owner' }], orgs: { id: 'o1', name_ar: 'كرافت لاند', city: 'الرياض' }, invitations: [{ id: 'i1', email: 'sales@example.com', role: 'sales', created_at: '2026-11-25T10:00:00Z' }] };"
        "window.__rpc = { accept_invitations: 0, my_permissions: { _owner: true }, list_members: [{ user_id: 'u1', email: 'sa.craft.land@gmail.com', role: 'owner', joined_at: '2026-11-25', is_me: true }, { user_id: 'u2', email: 'acc@example.com', role: 'accountant', joined_at: '2026-11-25', is_me: false }] };")
    pg.wait_for_timeout(500)
    check('Google return → app with company name', 'كرافت لاند' in pg.inner_text('#app'), pg.inner_text('#app')[:80])
    check('Google return: token removed from address bar', 'access_token' not in pg.url)
    check('server mode: no "trial" pill', pg.locator('.mode-pill').count() == 0)
    pg.goto(URL + '#/settings'); pg.wait_for_timeout(500)
    check('settings: shows connected project', 'abcd.supabase.co' in pg.inner_text('#main'))
    check('settings: links to users & permissions for owner', pg.locator('a[href="#/users"]').count() >= 1)
    check('nav: purchases & manufacturing visible for owner', pg.locator('.nav a[href="#/bills"]').count() == 1 and pg.locator('.nav a[href="#/mfg"]').count() == 1)
    pg.click('[data-act=signout]'); pg.wait_for_timeout(400)
    check('sign out → login screen', pg.locator('#authf').count() == 1 and len(calls(pg, 'signOut')) == 1)
    check('no page errors', not errs, errs)
    ctx.close()
    b.close()
print(f'\n{sum(results)}/{len(results)} passed')
