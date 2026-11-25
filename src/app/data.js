// =====================================================================
// Data layer. Two back ends with the SAME functions:
//   LocalAPI    — runs in this browser (localStorage). For trying the app
//                 on one device. Posting rules mirror schema.sql exactly.
//   SupabaseAPI — the real back end (Postgres + RLS + RPC in schema.sql).
// Screens only ever call `api.*`, so switching back ends changes no screen.
// All money is integer halalas (1 SAR = 100).
// =====================================================================
const VAT_RE = /^3[0-9]{13}3$/;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36));
const riyadhToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());
const riyadhTime = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date());
const lineCalc = l => { const gross = Math.round(Number(l.qty) * Number(l.unit_price)); const net = gross - (Number(l.discount) || 0); return { net, vat: Math.round(net * Number(l.vat_rate) / 100) }; };
class AppError extends Error {}

// ---------------- Local (this browser) ----------------
const LocalAPI = (() => {
  const KEY = 'daftar-local-v1';
  const blank = () => ({ users: [], session: null, orgs: [], members: [], accounts: [], parties: [], items: [], documents: [], lines: [],
    entries: [], jlines: [], payments: [], allocs: [], stock: [], counters: {} });
  let S;
  const load = () => { try { S = JSON.parse(localStorage.getItem(KEY)) || blank(); } catch { S = blank(); } };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { throw new AppError('تعذّر الحفظ في المتصفح — المساحة ممتلئة؟'); } };
  load();
  const tx = fn => { const snap = JSON.stringify(S); try { const r = fn(); save(); return r; } catch (e) { S = JSON.parse(snap); throw e; } };
  const hash = async s => { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('daftar:' + s)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); };
  const me = () => { if (!S.session) throw new AppError('سجّل الدخول أولاً'); return S.session; };
  const org = () => { const m = S.members.find(m => m.user_id === me()); return m ? S.orgs.find(o => o.id === m.org_id) : null; };
  const O = () => { const o = org(); if (!o) throw new AppError('لا توجد شركة'); return o; };
  const acct = k => { const a = S.accounts.find(a => a.org_id === O().id && a.system_key === k); if (!a) throw new AppError('حساب النظام غير موجود: ' + k); return a.id; };
  const next = s => { const k = O().id + ':' + s; S.counters[k] = (S.counters[k] || 0) + 1; return S.counters[k]; };
  const mine = list => list.filter(r => r.org_id === O().id);

  function postEntry(date, memo, source_type, source_id, lines) {
    const d = lines.reduce((a, l) => a + (l.debit || 0), 0), c = lines.reduce((a, l) => a + (l.credit || 0), 0);
    if (d !== c || d === 0) throw new AppError(`القيد غير متوازن (مدين ${d} — دائن ${c})`);
    const e = { id: uid(), org_id: O().id, number: next('je'), entry_date: date, memo, source_type, source_id, status: 'posted', created_at: new Date().toISOString() };
    S.entries.push(e);
    lines.filter(l => (l.debit || 0) + (l.credit || 0) > 0).forEach(l => S.jlines.push({ id: uid(), entry_id: e.id, org_id: e.org_id, account_id: l.account_id, party_id: l.party_id || null, cost_center_id: null, debit: l.debit || 0, credit: l.credit || 0 }));
    return e.id;
  }

  return {
    mode: 'local',
    async session() { return S.session ? { user: S.users.find(u => u.id === S.session) } : null; },
    async signUp(email, pw) {
      email = email.trim().toLowerCase(); if (pw.length < 8) throw new AppError('كلمة المرور 8 أحرف على الأقل');
      if (S.users.some(u => u.email === email)) throw new AppError('هذا البريد مسجّل — سجّل الدخول');
      const u = { id: uid(), email, pw: await hash(pw) }; S.users.push(u); S.session = u.id; save(); return u;
    },
    async signIn(email, pw) {
      const u = S.users.find(u => u.email === email.trim().toLowerCase());
      if (!u || u.pw !== await hash(pw)) throw new AppError('البريد أو كلمة المرور غير صحيحة'); S.session = u.id; save(); return u;
    },
    async signOut() { S.session = null; save(); },
    async currentOrg() { return org(); },
    async createOrg(f) {
      if (f.vat_number && !VAT_RE.test(f.vat_number)) throw new AppError('الرقم الضريبي 15 خانة ويبدأ وينتهي بالرقم 3');
      return tx(() => {
        const o = { id: uid(), name_ar: f.name_ar, vat_number: f.vat_number || null, cr_number: f.cr_number || null, city: f.city, district: f.district, street: f.street,
          building_no: f.building_no, postal_code: f.postal_code, sector: f.sector || 'general', logo_path: null, invoice_footer: '', plan: 'trial',
          trial_ends_at: new Date(Date.now() + 14 * 864e5).toISOString(), created_at: new Date().toISOString() };
        S.orgs.push(o); S.members.push({ org_id: o.id, user_id: me(), role: 'owner' });
        const ids = {}; CHART.forEach(([code, parent, ar, en, type, postable, key]) => { ids[code] = uid(); });
        CHART.forEach(([code, parent, ar, en, type, postable, key]) => S.accounts.push({ id: ids[code], org_id: o.id, parent_id: parent ? ids[parent] : null, code, name_ar: ar, name_en: en, type, is_postable: postable, system_key: key }));
        return o;
      });
    },
    async updateOrg(f) {
      if (f.vat_number && !VAT_RE.test(f.vat_number)) throw new AppError('الرقم الضريبي 15 خانة ويبدأ وينتهي بالرقم 3');
      return tx(() => Object.assign(O(), f));
    },
    async listAccounts() { return mine(S.accounts).sort((a, b) => a.code.localeCompare(b.code)); },
    async trialBalance() {
      const accs = mine(S.accounts), by = {};
      mine(S.jlines).forEach(l => { const r = by[l.account_id] ||= { debit: 0, credit: 0 }; r.debit += l.debit; r.credit += l.credit; });
      return accs.filter(a => by[a.id]).map(a => ({ account_id: a.id, code: a.code, name_ar: a.name_ar, type: a.type, ...by[a.id], balance: by[a.id].debit - by[a.id].credit }))
        .sort((a, b) => a.code.localeCompare(b.code));
    },
    async listParties(kind) { return mine(S.parties).filter(p => !kind || p.kind === kind || p.kind === 'both').sort((a, b) => a.name.localeCompare(b.name, 'ar')); },
    async saveParty(p) {
      if (!p.name?.trim()) throw new AppError('الاسم مطلوب');
      if (p.vat_number && !VAT_RE.test(p.vat_number)) throw new AppError('الرقم الضريبي 15 خانة ويبدأ وينتهي بالرقم 3');
      return tx(() => { if (p.id) { const r = S.parties.find(x => x.id === p.id && x.org_id === O().id); Object.assign(r, p); return r; }
        const r = { id: uid(), org_id: O().id, kind: 'customer', country: 'SA', is_active: true, created_at: new Date().toISOString(), ...p }; S.parties.push(r); return r; });
    },
    async listItems() {
      const items = mine(S.items), q = {}; mine(S.stock).forEach(m => q[m.item_id] = (q[m.item_id] || 0) + m.qty);
      return items.map(i => ({ ...i, on_hand: q[i.id] || 0 })).sort((a, b) => a.name_ar.localeCompare(b.name_ar, 'ar'));
    },
    async saveItem(i) {
      if (!i.name_ar?.trim()) throw new AppError('اسم الصنف مطلوب');
      if (['Z', 'E'].includes(i.tax_category) && !i.exemption_reason) throw new AppError('سبب الإعفاء أو النسبة الصفرية مطلوب');
      return tx(() => {
        const dup = mine(S.items).find(x => x.id !== i.id && ((i.sku && x.sku === i.sku) || (i.barcode && x.barcode === i.barcode)));
        if (dup) throw new AppError('رمز الصنف أو الباركود مستخدم لصنف آخر');
        if (i.id) { const r = S.items.find(x => x.id === i.id && x.org_id === O().id); Object.assign(r, i); return r; }
        const r = { id: uid(), org_id: O().id, is_active: true, created_at: new Date().toISOString(), ...i }; S.items.push(r); return r;
      });
    },
    async listDocuments(kinds) {
      const parties = Object.fromEntries(mine(S.parties).map(p => [p.id, p]));
      return mine(S.documents).filter(d => !kinds || kinds.includes(d.kind)).map(d => ({ ...d, party_name: parties[d.party_id]?.name || 'عميل نقدي' }))
        .sort((a, b) => (b.issue_date + b.created_at).localeCompare(a.issue_date + a.created_at));
    },
    async getDocument(id) {
      const d = mine(S.documents).find(d => d.id === id); if (!d) throw new AppError('المستند غير موجود');
      const lines = S.lines.filter(l => l.document_id === id).sort((a, b) => a.line_no - b.line_no);
      const party = S.parties.find(p => p.id === d.party_id) || null;
      const entry = S.entries.find(e => e.source_type === 'document' && e.source_id === id);
      const accs = Object.fromEntries(mine(S.accounts).map(a => [a.id, a]));
      const jl = entry ? S.jlines.filter(l => l.entry_id === entry.id).map(l => ({ ...l, code: accs[l.account_id].code, name_ar: accs[l.account_id].name_ar })) : [];
      const pays = S.allocs.filter(a => a.document_id === id).map(a => ({ ...a, payment: S.payments.find(p => p.id === a.payment_id) }));
      return { ...d, lines, party, entry, journal: jl, payments: pays };
    },
    async saveDraft(doc, lines) {
      return tx(() => {
        let d;
        if (doc.id) { d = mine(S.documents).find(x => x.id === doc.id); if (d.status !== 'draft') throw new AppError('لا يمكن تعديل مستند مرحّل — أصدر إشعاراً دائناً');
          Object.assign(d, doc); S.lines = S.lines.filter(l => l.document_id !== d.id); }
        else { d = { id: uid(), org_id: O().id, status: 'draft', payment_status: 'unpaid', amount_paid: 0, zatca_uuid: uid(), zatca_status: 'not_sent', currency: 'SAR', created_at: new Date().toISOString(), ...doc }; S.documents.push(d); }
        lines.forEach((l, i) => S.lines.push({ id: uid(), document_id: d.id, org_id: d.org_id, line_no: i + 1, ...l }));
        return d.id;
      });
    },
    async postSalesInvoice(id) {
      return tx(() => {
        const d = mine(S.documents).find(x => x.id === id);
        if (!d || d.status !== 'draft') throw new AppError('المستند مرحّل مسبقاً');
        const party = S.parties.find(p => p.id === d.party_id);
        if (d.kind === 'tax_invoice' && !party?.vat_number) throw new AppError('الفاتورة الضريبية تحتاج رقم ضريبي للعميل');
        const lines = S.lines.filter(l => l.document_id === id);
        if (!lines.length) throw new AppError('أضف سطراً واحداً على الأقل');
        let sub = 0, vat = 0; lines.forEach(l => { const c = lineCalc(l); l.line_net = c.net; l.line_vat = c.vat; sub += c.net; vat += c.vat; });
        if (sub <= 0) throw new AppError('إجمالي الفاتورة يجب أن يكون أكبر من صفر');
        Object.assign(d, { subtotal: sub, vat_total: vat, total: sub + vat });
        const rev = {}; lines.forEach(l => { const it = S.items.find(i => i.id === l.item_id); const a = it?.revenue_account_id || acct(it?.kind === 'service' ? 'service_revenue' : 'sales'); rev[a] = (rev[a] || 0) + l.line_net; });
        const jl = [{ account_id: acct('ar'), party_id: d.party_id, debit: d.total }, ...Object.entries(rev).map(([a, v]) => ({ account_id: a, credit: v }))];
        if (vat > 0) jl.push({ account_id: acct('vat_out'), credit: vat });
        let cogs = 0;
        lines.forEach(l => { const it = S.items.find(i => i.id === l.item_id); if (!it || !it.track_stock) return; l.unit_cost = it.avg_cost || 0;
          S.stock.push({ id: uid(), org_id: d.org_id, item_id: it.id, qty: -Number(l.qty), unit_cost: l.unit_cost, source_type: 'sale', source_id: d.id, move_date: d.issue_date }); cogs += Number(l.qty) * l.unit_cost; });
        cogs = Math.round(cogs); if (cogs > 0) jl.push({ account_id: acct('cogs'), debit: cogs }, { account_id: acct('inventory'), credit: cogs });
        postEntry(d.issue_date, 'فاتورة مبيعات', 'document', d.id, jl);
        const n = next('inv'); Object.assign(d, { status: 'posted', number: 'INV-' + String(n).padStart(5, '0'), posted_at: new Date().toISOString(), zatca_status: 'pending', zatca_icv: n });
        return d.id;
      });
    },
    async deleteDraft(id) { return tx(() => { const d = mine(S.documents).find(x => x.id === id); if (d?.status !== 'draft') throw new AppError('لا يمكن حذف مستند مرحّل');
      S.documents = S.documents.filter(x => x.id !== id); S.lines = S.lines.filter(l => l.document_id !== id); }); },
    async listPayments() { const parties = Object.fromEntries(mine(S.parties).map(p => [p.id, p]));
      return mine(S.payments).map(p => ({ ...p, party_name: parties[p.party_id]?.name || '—' })).sort((a, b) => (b.pay_date + b.created_at).localeCompare(a.pay_date + a.created_at)); },
    async createReceipt(r) {
      return tx(() => {
        const amount = Number(r.amount); if (!(amount > 0)) throw new AppError('أدخل مبلغاً صحيحاً');
        const allocated = (r.allocations || []).reduce((a, x) => a + x.amount, 0);
        if (allocated > amount) throw new AppError('المبالغ الموزعة أكبر من مبلغ السند');
        (r.allocations || []).forEach(x => { const d = mine(S.documents).find(d => d.id === x.document_id); if (!d || d.status !== 'posted') throw new AppError('فاتورة غير صالحة');
          if (x.amount > d.total - d.amount_paid) throw new AppError(`المبلغ يتجاوز المتبقي على ${d.number}`); });
        const p = { id: uid(), org_id: O().id, kind: 'receipt', party_id: r.party_id, pay_date: r.pay_date, amount, method: r.method, reference: r.reference || '',
          cash_account_id: acct(r.method === 'cash' ? 'cash' : r.method === 'card' ? 'card_clearing' : 'bank'), status: 'posted', created_at: new Date().toISOString() };
        S.payments.push(p);
        postEntry(p.pay_date, 'سند قبض', 'payment', p.id, [{ account_id: p.cash_account_id, debit: amount }, { account_id: acct('ar'), party_id: p.party_id, credit: amount }]);
        (r.allocations || []).forEach(x => { S.allocs.push({ payment_id: p.id, document_id: x.document_id, amount: x.amount });
          const d = mine(S.documents).find(d => d.id === x.document_id); d.amount_paid += x.amount; d.payment_status = d.amount_paid >= d.total ? 'paid' : 'partial'; });
        p.number = 'RV-' + String(next('rv')).padStart(5, '0');
        return p.id;
      });
    },
    async partyStatement(partyId) {
      const rows = [];
      mine(S.documents).filter(d => d.party_id === partyId && d.status === 'posted').forEach(d => rows.push({ date: d.issue_date, ref: d.number, what: 'فاتورة', debit: d.total, credit: 0, link: '#/invoices/' + d.id }));
      mine(S.payments).filter(p => p.party_id === partyId).forEach(p => rows.push({ date: p.pay_date, ref: p.number, what: 'سند قبض', debit: 0, credit: p.amount }));
      rows.sort((a, b) => a.date.localeCompare(b.date)); let bal = 0; rows.forEach(r => { bal += r.debit - r.credit; r.balance = bal; }); return rows;
    },
    // dev helpers
    async resetAll() { S = blank(); save(); },
  };
})();

// ---------------- Supabase (real back end) ----------------
// Same functions, backed by supabase/setup.sql (RLS + RPC + client guards).
// Auth: email + password (with email confirmation), magic link, password
// reset and Google — all through Supabase Auth with the project's own keys.
const AR_ERRORS = [
  [/invalid login credentials/i, 'البريد أو كلمة المرور غير صحيحة'],
  [/email not confirmed/i, 'لم يتم تأكيد بريدك بعد — افتح رسالة التأكيد في بريدك ثم سجّل الدخول'],
  [/user already registered|already been registered/i, 'هذا البريد مسجّل — سجّل الدخول'],
  [/password should be at least|password.*(short|length)/i, 'كلمة المرور 8 أحرف على الأقل'],
  [/weak password|password.*(characters|pwned)/i, 'كلمة المرور ضعيفة — استخدم حروفاً وأرقاماً'],
  [/same.*password|different from the old/i, 'اختر كلمة مرور مختلفة عن السابقة'],
  [/rate limit|too many|security purposes.*after/i, 'محاولات كثيرة — انتظر دقيقة ثم حاول مجدداً'],
  [/unable to validate email|invalid.*email|email address.*invalid/i, 'البريد الإلكتروني غير صحيح'],
  [/signups not allowed|signup.*disabled/i, 'التسجيل مغلق حالياً'],
  [/provider is not enabled|unsupported provider/i, 'الدخول بـ Google غير مفعّل في إعدادات Supabase بعد'],
  [/otp_expired|expired|invalid.*(link|token)/i, 'انتهت صلاحية الرابط — اطلب رابطاً جديداً'],
  [/auth session missing|jwt expired|not authenticated/i, 'انتهت الجلسة — سجّل الدخول مجدداً'],
  [/failed to fetch|networkerror|load failed/i, 'لا يوجد اتصال بالخادم — تحقق من الإنترنت'],
  [/duplicate key.*(sku)/i, 'رمز الصنف مستخدم لصنف آخر'],
  [/duplicate key.*(barcode)/i, 'الباركود مستخدم لصنف آخر'],
  [/duplicate key/i, 'هذا السجل موجود مسبقاً'],
  [/vat_number_check|vat_number/i, 'الرقم الضريبي 15 رقماً ويبدأ وينتهي بـ 3'],
  [/tax invoice needs a customer vat/i, 'الفاتورة الضريبية تحتاج رقم ضريبي للعميل'],
  [/already posted|document already posted/i, 'المستند مرحّل مسبقاً'],
  [/posted documents cannot be edited|cannot be changed/i, 'لا يمكن تعديل مستند مرحّل — أصدر إشعاراً دائناً'],
  [/posted vouchers cannot be edited/i, 'لا يمكن تعديل سند مرحّل'],
  [/still open on (\S+)/i, m => `المبلغ يتجاوز المتبقي على ${m[1]}`],
  [/allocations exceed/i, 'المبالغ الموزعة أكبر من مبلغ السند'],
  [/entry .*not balanced|unbalanced/i, 'القيد غير متوازن'],
  [/period.*locked|locked_until/i, 'الفترة مقفلة — لا يمكن الترحيل في هذا التاريخ'],
  [/not allowed|permission denied|row-level security/i, 'ليست لديك صلاحية لهذا الإجراء'],
  [/qty.*check|document_lines_qty/i, 'الكمية يجب أن تكون أكبر من صفر'],
  [/paid_not_over/i, 'المدفوع أكبر من قيمة الفاتورة'],
];
const arErr = e => { const msg = String(e?.message || e || ''); for (const [re, t] of AR_ERRORS) { const m = msg.match(re); if (m) return typeof t === 'function' ? t(m) : t; }
  return msg ? 'تعذّر إتمام العملية: ' + msg : 'حدث خطأ غير متوقع'; };
const appUrl = () => location.origin + location.pathname;   // where Supabase sends users back (no #route)

const SupabaseAPI = (cfg) => {
  const sb = window.supabase.createClient(cfg.url, cfg.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit', storageKey: 'daftar-auth' } });
  let orgCache = null;
  const ok = ({ data, error }) => { if (error) throw new AppError(arErr(error)); return data; };
  const orgId = async () => (orgCache ||= await loadOrg())?.id;
  async function loadOrg() { const { data: { session } } = await sb.auth.getSession(); const u = session?.user; if (!u) return null;
    const m = ok(await sb.from('members').select('org_id').eq('user_id', u.id).order('created_at').limit(1)); if (!m.length) return null;
    return ok(await sb.from('orgs').select('*').eq('id', m[0].org_id).single()); }
  const acctId = async k => ok(await sb.from('accounts').select('id').eq('org_id', await orgId()).eq('system_key', k).single()).id;
  const nulls = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === '' ? null : v]));
  return {
    mode: 'supabase', client: sb,
    async session() { return (await sb.auth.getSession()).data.session; },
    onAuth(cb) { sb.auth.onAuthStateChange((event, session) => cb(event, session)); },
    async signUp(email, pw) {
      if (pw.length < 8) throw new AppError('كلمة المرور 8 أحرف على الأقل');
      const r = ok(await sb.auth.signUp({ email: email.trim(), password: pw, options: { emailRedirectTo: appUrl() } }));
      // with "Confirm email" on, Supabase returns no session; an existing address comes back with no identities
      if (r.user && Array.isArray(r.user.identities) && r.user.identities.length === 0) throw new AppError('هذا البريد مسجّل — سجّل الدخول');
      return { user: r.user, needsConfirm: !r.session };
    },
    async signIn(email, pw) { orgCache = null; return ok(await sb.auth.signInWithPassword({ email: email.trim(), password: pw })).user; },
    async magicLink(email) { ok(await sb.auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: appUrl(), shouldCreateUser: true } })); },
    async resetPassword(email) { ok(await sb.auth.resetPasswordForEmail(email.trim(), { redirectTo: appUrl() })); },
    async updatePassword(pw) { if (pw.length < 8) throw new AppError('كلمة المرور 8 أحرف على الأقل'); ok(await sb.auth.updateUser({ password: pw })); },
    async resendConfirm(email) { ok(await sb.auth.resend({ type: 'signup', email: email.trim(), options: { emailRedirectTo: appUrl() } })); },
    async signInWithGoogle() { ok(await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: appUrl(), queryParams: { prompt: 'select_account' } } })); },
    async signOut() { orgCache = null; await sb.auth.signOut(); },
    async currentOrg() { return orgCache = await loadOrg(); },
    async createOrg(f) {
      if (f.vat_number && !VAT_RE.test(f.vat_number)) throw new AppError('الرقم الضريبي 15 خانة ويبدأ وينتهي بالرقم 3');
      const id = ok(await sb.rpc('create_org', { p_name: f.name_ar, p_vat: f.vat_number || null, p_cr: f.cr_number || null, p_city: f.city || null, p_street: f.street || null,
        p_building: f.building_no || null, p_postal: f.postal_code || null, p_district: f.district || null, p_sector: f.sector || 'general' })); orgCache = null; return { id }; },
    async updateOrg(f) {
      if (f.vat_number && !VAT_RE.test(f.vat_number)) throw new AppError('الرقم الضريبي 15 خانة ويبدأ وينتهي بالرقم 3');
      const allowed = ['name_ar', 'name_en', 'vat_number', 'cr_number', 'street', 'building_no', 'district', 'city', 'postal_code', 'sector', 'logo_path', 'brand_color', 'invoice_footer'];
      const row = nulls(Object.fromEntries(Object.entries(f).filter(([k]) => allowed.includes(k))));
      const r = ok(await sb.from('orgs').update(row).eq('id', await orgId()).select().single()); orgCache = r; return r; },
    async listAccounts() { return ok(await sb.from('accounts').select('*').eq('org_id', await orgId()).order('code')); },
    async trialBalance() { return ok(await sb.from('trial_balance').select('*').eq('org_id', await orgId()).order('code'))
      .map(r => ({ ...r, debit: Number(r.debit), credit: Number(r.credit), balance: Number(r.balance) })); },
    async listParties(kind) { let q = sb.from('parties').select('*').eq('org_id', await orgId()).order('name'); if (kind) q = q.in('kind', [kind, 'both']); return ok(await q); },
    async saveParty(p) { return ok(await sb.from('parties').upsert(nulls({ ...p, org_id: await orgId() })).select().single()); },
    async listItems() { const o = await orgId(); const items = ok(await sb.from('items').select('*').eq('org_id', o).order('name_ar'));
      const bal = ok(await sb.from('stock_balances').select('item_id,qty').eq('org_id', o)); const q = {}; bal.forEach(b => q[b.item_id] = (q[b.item_id] || 0) + Number(b.qty));
      return items.map(i => ({ ...i, on_hand: q[i.id] || 0, avg_cost: Number(i.avg_cost), vat_rate: Number(i.vat_rate) })); },
    async saveItem(i) {
      if (!i.name_ar?.trim()) throw new AppError('اسم الصنف مطلوب');
      if (['Z', 'E'].includes(i.tax_category) && !i.exemption_reason) throw new AppError('سبب الإعفاء أو النسبة الصفرية مطلوب');
      return ok(await sb.from('items').upsert({ ...i, org_id: await orgId() }).select().single()); },
    async listDocuments(kinds) { let q = sb.from('documents').select('*, parties(name)').eq('org_id', await orgId()).order('issue_date', { ascending: false }).order('created_at', { ascending: false });
      if (kinds) q = q.in('kind', kinds); return ok(await q).map(d => ({ ...d, party_name: d.parties?.name || 'عميل نقدي' })); },
    async getDocument(id) {
      const d = ok(await sb.from('documents').select('*, parties(*)').eq('id', id).maybeSingle()); if (!d) throw new AppError('المستند غير موجود');
      const lines = ok(await sb.from('document_lines').select('*').eq('document_id', id).order('line_no')).map(l => ({ ...l, qty: Number(l.qty), vat_rate: Number(l.vat_rate) }));
      const entry = ok(await sb.from('journal_entries').select('*').eq('source_type', 'document').eq('source_id', id).eq('status', 'posted').maybeSingle());
      const journal = entry ? ok(await sb.from('journal_lines').select('*, accounts(code,name_ar)').eq('entry_id', entry.id)).map(l => ({ ...l, code: l.accounts.code, name_ar: l.accounts.name_ar })) : [];
      const payments = ok(await sb.from('payment_allocations').select('*, payments(*)').eq('document_id', id)).map(a => ({ ...a, payment: a.payments }));
      return { ...d, party: d.parties, lines, entry, journal, payments };
    },
    async saveDraft(doc, lines) {
      const o = await orgId();
      if (!doc.branch_id) { const w = ok(await sb.from('warehouses').select('id,branch_id').eq('org_id', o).limit(1).single()); doc = { ...doc, branch_id: w.branch_id, warehouse_id: w.id }; }
      const row = ok(await sb.from('documents').upsert(nulls({ ...doc, org_id: o })).select().single());
      ok(await sb.from('document_lines').delete().eq('document_id', row.id));
      if (lines.length) ok(await sb.from('document_lines').insert(lines.map((l, i) => ({ item_id: l.item_id || null, description: l.description, qty: l.qty, unit_price: l.unit_price,
        discount: l.discount || 0, tax_category: l.tax_category, vat_rate: l.vat_rate, document_id: row.id, org_id: o, line_no: i + 1 }))));
      return row.id;
    },
    async postSalesInvoice(id) { ok(await sb.rpc('post_sales_invoice', { doc: id })); return id; },
    async deleteDraft(id) { ok(await sb.from('documents').delete().eq('id', id).eq('status', 'draft')); },
    async listPayments() { return ok(await sb.from('payments').select('*, parties(name)').eq('org_id', await orgId()).eq('status', 'posted').order('pay_date', { ascending: false }).order('created_at', { ascending: false }))
      .map(p => ({ ...p, party_name: p.parties?.name || '—' })); },
    async createReceipt(r) {
      const amount = Number(r.amount); if (!(amount > 0)) throw new AppError('أدخل مبلغاً صحيحاً');
      if ((r.allocations || []).reduce((a, x) => a + x.amount, 0) > amount) throw new AppError('المبالغ الموزعة أكبر من مبلغ السند');
      const o = await orgId(); const key = r.method === 'cash' ? 'cash' : r.method === 'card' ? 'card_clearing' : 'bank';
      const p = ok(await sb.from('payments').insert({ org_id: o, kind: 'receipt', party_id: r.party_id || null, pay_date: r.pay_date, amount, method: r.method, cash_account_id: await acctId(key), reference: r.reference || null }).select().single());
      try {
        if (r.allocations?.length) ok(await sb.from('payment_allocations').insert(r.allocations.map(a => ({ payment_id: p.id, document_id: a.document_id, amount: a.amount }))));
        ok(await sb.rpc('post_payment', { p: p.id }));
      } catch (e) { await sb.from('payments').delete().eq('id', p.id).eq('status', 'draft'); throw e; }   // don't leave a half-made voucher
      return p.id;
    },
    async partyStatement(partyId) {
      const docs = ok(await sb.from('documents').select('id,number,issue_date,total').eq('party_id', partyId).eq('status', 'posted'));
      const pays = ok(await sb.from('payments').select('number,pay_date,amount').eq('party_id', partyId).eq('status', 'posted'));
      const rows = [...docs.map(d => ({ date: d.issue_date, ref: d.number, what: 'فاتورة', debit: d.total, credit: 0, link: '#/invoices/' + d.id })),
        ...pays.map(p => ({ date: p.pay_date, ref: p.number, what: 'سند قبض', debit: 0, credit: p.amount }))].sort((a, b) => a.date.localeCompare(b.date));
      let bal = 0; rows.forEach(r => { bal += r.debit - r.credit; r.balance = bal; }); return rows;
    },
    async resetAll() { throw new AppError('غير متاح في وضع الخادم'); },
  };
};
