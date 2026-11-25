// Stand-in for supabase-js in browser tests: same call shapes, forwarded to tests/pgrest_shim.py
(function () {
  const SHIM = window.__SHIM || 'http://127.0.0.1:8790';
  const post = async (path, body) => (await fetch(SHIM + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  window.supabase = { createClient() {
    let session = JSON.parse(localStorage.getItem('fake-session') || 'null'); const subs = [];
    const emit = (e, s) => subs.forEach(f => f(e, s));
    const save = s => { session = s; s ? localStorage.setItem('fake-session', JSON.stringify(s)) : localStorage.removeItem('fake-session'); };
    const q = table => { const ops = []; const p = new Proxy({}, { get(_, k) {
        if (k === 'then') return (res, rej) => post('/rest', { table, ops, sub: session?.user?.id }).then(res, rej);
        return (...a) => { ops.push([k, a]); return p; }; } }); return p; };
    return {
      auth: {
        async getSession() { return { data: { session } }; },
        async getUser() { return { data: { user: session?.user || null } }; },
        onAuthStateChange(f) { subs.push(f); return { data: { subscription: { unsubscribe() {} } } }; },
        async signUp(a) { const r = await post('/auth', { action: 'signup', email: a.email }); if (r.data?.session) { save(r.data.session); emit('SIGNED_IN', session); } return r; },
        async signInWithPassword(a) { const r = await post('/auth', { action: 'signin', email: a.email }); if (r.data?.session) { save(r.data.session); emit('SIGNED_IN', session); } return r; },
        async signInWithOtp() { return { data: {}, error: null }; },
        async signInWithOAuth() { return { data: {}, error: null }; },
        async resetPasswordForEmail() { return { data: {}, error: null }; },
        async updateUser() { return { data: {}, error: null }; },
        async resend() { return { data: {}, error: null }; },
        async signOut() { save(null); emit('SIGNED_OUT', null); return { error: null }; },
      },
      from: q,
      rpc: (fn, args) => post('/rest', { rpc: fn, args, sub: session?.user?.id }),
    };
  } };
})();
