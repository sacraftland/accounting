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
// VAT on the document = per rate, rounded once (ZATCA BR-S-09); lines keep their own rounded VAT for display
const docVat = rows => { const g = {}; rows.forEach(([net, rate]) => { if (Number.isFinite(net)) g[rate] = (g[rate] || 0) + net; }); return Object.entries(g).reduce((t, [r, n]) => t + Math.round(n * Number(r) / 100), 0); };
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
        let sub = 0; lines.forEach(l => { const c = lineCalc(l); l.line_net = c.net; l.line_vat = c.vat; sub += c.net; }); const vat = docVat(lines.map(l => [l.line_net, Number(l.vat_rate)]));
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
  [/RESET_CONFIRM/, 'اكتب اسم الشركة كما هو للتأكيد'],
  [/RESET_BROKEN/, 'تعذّر التصفير بأمان — لم يُمسح شيء'],
  [/BACKUP_IDS_TAKEN/, 'هذه النسخة استُرجعت من قبل — أعد اختيار الملف ليُجهَّز من جديد'],
  [/BACKUP_INVALID[: ]*(.*)/, m => 'ملف النسخة غير صالح أو معدّل' + (m[1] ? ` (${m[1]})` : '')],
  [/WAGES_MORE_THAN_OWED/i, 'المبلغ أكبر من الأجور المستحقة للعامل'], [/employees_casual_rate/i, 'أدخل الأجر اليومي أو أجر الساعة للعامل'],
  [/RETURN_MORE_THAN_ISSUED/i, 'لا يمكن إرجاع أكثر مما صُرف للمشروع'], [/ISSUE_PROJECT/i, 'اختر المشروع'], [/ISSUE_SERVICE/i, 'الخدمات لا تُصرف من المخزون'], [/TIMESHEET_POSTED/i, 'الساعات المرحّلة لا تُعدَّل'],
  [/TASK_DATES/i, 'تاريخ الاستحقاق قبل تاريخ البداية'], [/PROJECT_CODE/i, 'رمز المشروع مستخدم'], [/PROJECT_NAME/i, 'أدخل رمز المشروع واسمه'], [/cost_centers_dates/i, 'تاريخ التسليم قبل تاريخ البداية'],
  [/PORTAL_INVALID/i, 'الرابط غير صالح أو أُلغي'], [/TRIP_VAN/i, 'اختر سيارة المندوب'], [/TRIP_OPEN/i, 'لهذه السيارة رحلة مفتوحة — أغلقها أولاً'], [/TRIP_CLOSED/i, 'الرحلة مغلقة'],
  [/ASSET_HAS_DEPRECIATION/i, 'على الأصل إهلاك مرحّل — لا يمكن تعديل تكلفته أو حذفه، استبعده بدلاً من ذلك'], [/ASSET_DISPOSED/i, 'هذا الأصل مستبعد'],
  [/CARD_AMOUNTS/i, 'تحقق من مبلغ التسوية والعمولة'], [/LEAVE_DECIDED/i, 'تم البت في هذا الطلب مسبقاً'],
  [/ACCOUNT_SYSTEM/i, 'حسابات النظام لا تُحذف'], [/ACCOUNT_USED/i, 'الحساب عليه قيود أو حسابات فرعية'], [/ACCOUNT_PARENT/i, 'اختر حساباً رئيسياً (تجميعياً) كأب'],
  [/PAYROLL_POSTED/i, 'رواتب هذا الشهر مرحّلة ولا يمكن تعديلها'], [/PAYROLL_EMPTY/i, 'لا يوجد موظفون نشطون في هذا الشهر'],
  [/PAYROLL_NOT_POSTED/i, 'رحّل مسير الرواتب أولاً، أو أنه صُرف مسبقاً'], [/PAYSLIP_NEGATIVE/i, 'الخصومات أكبر من الراتب'],
  [/EMP_SALARY/i, 'مبالغ الراتب لا يمكن أن تكون سالبة'],
  [/PERM_ESCALATION/i, 'لا يمكنك منح صلاحيات لا تملكها أنت'],
  [/SYSTEM_ROLE/i, 'هذا دور أساسي — المالك فقط يعدّله، ولا يُحذف'],
  [/ROLE_IN_USE/i, 'هذا الدور مستخدم — انقل أعضاءه لدور آخر أولاً'],
  [/SELF_ROLE/i, 'لا يمكنك تغيير دورك بنفسك'],
  [/NOT_ENOUGH_STOCK: (.*) \(available ([-\d.]+)\)/i, m => `الكمية غير كافية من «${m[1]}» في هذا المستودع (المتاح ${Number(m[2])})`],
  [/RETURN_NEEDS_SOURCE/i, 'اختر الفاتورة المرحّلة المراد الإرجاع منها'],
  [/RETURN_TOO_BIG/i, 'المرتجعات أكبر من قيمة الفاتورة الأصلية'],
  [/RETURN_PARTY/i, 'المرتجع يجب أن يكون لنفس الطرف في الفاتورة الأصلية'],
  [/SUPPLIER_REQUIRED/i, 'اختر المورد'],
  [/NO_LINES/i, 'أضف سطراً واحداً على الأقل'],
  [/LANDED_NO_STOCK/i, 'تكاليف الشحن تحتاج سطر صنف مخزني واحد على الأقل'],
  [/EXPENSE_ACCOUNT/i, 'اختر حساب مصروف'],
  [/PAID_FROM/i, 'اختر الحساب المدفوع منه: صندوق أو بنك أو عهدة أو مورد'],
  [/ENTRY_UNBALANCED/i, 'القيد غير متوازن: مجموع المدين لا يساوي مجموع الدائن'],
  [/ENTRY_LINES?/i, 'كل سطر إما مدين أو دائن، والقيد يحتاج سطرين على الأقل'],
  [/REVERSE_MANUAL_ONLY/i, 'قيود المستندات تُعكس بإشعار دائن أو مرتجع، لا يدوياً'],
  [/already reversed/i, 'هذا القيد معكوس مسبقاً'],
  [/TRANSFER_WAREHOUSES/i, 'اختر مستودعين مختلفين'],
  [/OPENING_COST/i, 'أدخل الكمية وتكلفة الوحدة'],
  [/MFG_PRODUCT/i, 'المنتج التام يجب أن يكون صنفاً مخزنياً'],
  [/MFG_COMPONENT_STOCK/i, 'المكونات يجب أن تكون أصنافاً مخزنية — الخدمات تُضاف كتكاليف إضافية'],
  [/MFG_EMPTY/i, 'أضف مكونات أو تكاليف للأمر'],
  [/BOM_SELF/i, 'لا يمكن أن يكون المنتج مكوّناً لنفسه'],
  [/boms_org_id_item_id_key/i, 'لهذا المنتج قائمة مواد مسبقاً'],
  [/roles_org_id_name_key/i, 'يوجد دور بنفس الاسم'],
  [/NOT_INVITED|database error saving new user/i, 'هذا البريد غير مدعو. اطلب من مدير الشركة إضافة بريدك أولاً'],
  [/NOT_ALLOWED_CREATE_ORG/i, 'إنشاء شركة جديدة متاح للمالك فقط'],
  [/ONLY_OWNER_ADMIN/i, 'المالك فقط يستطيع إضافة أو إزالة المديرين'],
  [/OWNER_PROTECTED/i, 'لا يمكن تغيير صلاحية المالك أو إزالته'],
  [/ALREADY_MEMBER/i, 'هذا البريد عضو في الشركة مسبقاً'],
  [/invitations_email_check/i, 'البريد الإلكتروني غير صحيح'],
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
  let accepted = null;   // user id we already accepted invitations for
  async function loadOrg() { const { data: { session } } = await sb.auth.getSession(); const u = session?.user; if (!u) return null;
    const mine = async () => ok(await sb.from('members').select('org_id,role').eq('user_id', u.id).order('created_at'));
    if (accepted !== u.id) { ok(await sb.rpc('accept_invitations')); accepted = u.id; }    // joins any company that invited this email
    let m = await mine(); if (!m.length) { ok(await sb.rpc('accept_invitations')); m = await mine(); } if (!m.length) return null;
    const pick = m.find(x => x.org_id === localStorage.getItem('daftar-org')) || m[0];
    const org = ok(await sb.from('orgs').select('*').eq('id', pick.org_id).single());
    const perms = ok(await sb.rpc('my_permissions', { p_org: pick.org_id })) || {};
    const role_dashboard = pick.role === 'owner' ? null : await sb.rpc('my_role_dashboard', { p_org: pick.org_id }).then(r => r.error ? null : r.data).catch(() => null);
    return { ...org, my_role: pick.role, perms, org_count: m.length, role_dashboard }; }
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
    async googleEnabled() { if (this._g !== undefined) return this._g;
      try { const r = await fetch(cfg.url.replace(/\/$/, '') + '/auth/v1/settings', { headers: { apikey: cfg.key } }); const j = await r.json(); this._g = !!j?.external?.google; }
      catch { this._g = true; } return this._g; },
    async signInWithGoogle() { ok(await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: appUrl(), queryParams: { prompt: 'select_account' } } })); },
    async signOut() { orgCache = null; await sb.auth.signOut(); },
    async currentOrg() { return orgCache = await loadOrg(); },
    async createOrg(f) {
      if (f.vat_number && !VAT_RE.test(f.vat_number)) throw new AppError('الرقم الضريبي 15 خانة ويبدأ وينتهي بالرقم 3');
      const id = ok(await sb.rpc('create_org', { p_name: f.name_ar, p_vat: f.vat_number || null, p_cr: f.cr_number || null, p_city: f.city || null, p_street: f.street || null,
        p_building: f.building_no || null, p_postal: f.postal_code || null, p_district: f.district || null, p_sector: f.sector || 'general' })); orgCache = null; return { id }; },
    async updateOrg(f) {
      if (f.vat_number && !VAT_RE.test(f.vat_number)) throw new AppError('الرقم الضريبي 15 خانة ويبدأ وينتهي بالرقم 3');
      const allowed = ['name_ar', 'name_en', 'vat_number', 'cr_number', 'street', 'building_no', 'district', 'city', 'postal_code', 'sector', 'logo_path', 'brand_color', 'invoice_footer', 'allow_negative_stock', 'invoice_settings', 'stamp_path', 'signature_path'];
      const row = nulls(Object.fromEntries(Object.entries(f).filter(([k]) => allowed.includes(k))));
      const r = ok(await sb.from('orgs').update(row).eq('id', await orgId()).select().single()); orgCache = { ...r, my_role: orgCache?.my_role, perms: orgCache?.perms, org_count: orgCache?.org_count, role_dashboard: orgCache?.role_dashboard }; return orgCache; },
    async setRoleDashboard(role, dash) { ok(await sb.rpc('set_role_dashboard', { p_role: role, p_dash: dash })); },
    // ---- users & invitations (owner / admin) ----
    async whoami() { return ok(await sb.rpc('whoami')); },
    async listMembers() { return ok(await sb.rpc('list_members', { p_org: await orgId() })); },
    async listInvites() { return ok(await sb.from('invitations').select('*, roles(name)').eq('org_id', await orgId()).is('accepted_at', null).order('created_at', { ascending: false })); },
    async invite(email, roleId) { email = (email || '').trim().toLowerCase(); if (!/^\S+@\S+\.\S+$/.test(email)) throw new AppError('البريد الإلكتروني غير صحيح');
      if (!roleId) throw new AppError('اختر الدور'); return ok(await sb.rpc('invite_member', { p_org: await orgId(), p_email: email, p_role_id: roleId })); },
    async sendInviteLink(email) { ok(await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: appUrl(), shouldCreateUser: true } })); },
    async revokeInvite(id) { ok(await sb.rpc('revoke_invitation', { p_id: id })); },
    async setRole(userId, roleId) { ok(await sb.rpc('set_member_role', { p_org: await orgId(), p_user: userId, p_role_id: roleId })); },
    async removeMember(userId) { ok(await sb.rpc('remove_member', { p_org: await orgId(), p_user: userId })); },
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
      const lines = ok(await sb.from('document_lines').select('*').eq('document_id', id).order('line_no')).map(l => ({ ...l, qty: Number(l.qty), vat_rate: Number(l.vat_rate), unit_cost: l.unit_cost == null ? null : Number(l.unit_cost) }));
      const entry = ok(await sb.from('journal_entries').select('*').eq('source_type', 'document').eq('source_id', id).eq('status', 'posted').maybeSingle());
      const related = ok(await sb.from('documents').select('id,kind,number,status,total').eq('related_document_id', id));
      const source = d.related_document_id ? ok(await sb.from('documents').select('id,kind,number,status,total,amount_paid').eq('id', d.related_document_id).maybeSingle()) : null;
      const journal = entry ? ok(await sb.from('journal_lines').select('*, accounts(code,name_ar)').eq('entry_id', entry.id)).map(l => ({ ...l, code: l.accounts.code, name_ar: l.accounts.name_ar })) : [];
      const payments = ok(await sb.from('payment_allocations').select('*, payments(*)').eq('document_id', id)).map(a => ({ ...a, payment: a.payments }));
      return { ...d, party: d.parties, lines, entry, journal, payments, related, source };
    },
    async saveDraft(doc, lines) {
      const o = await orgId();
      if (!doc.branch_id) { let q = sb.from('warehouses').select('id,branch_id').eq('org_id', o); q = doc.warehouse_id ? q.eq('id', doc.warehouse_id) : q.order('created_at');
        const w = ok(await q.limit(1).single()); doc = { ...doc, branch_id: w.branch_id, warehouse_id: w.id }; }
      const row = ok(await sb.from('documents').upsert(nulls({ ...doc, org_id: o })).select().single());
      ok(await sb.from('document_lines').delete().eq('document_id', row.id));
      if (lines.length) ok(await sb.from('document_lines').insert(lines.map((l, i) => ({ item_id: l.item_id || null, account_id: l.account_id || null, description: l.description, qty: l.qty, unit_price: l.unit_price,
        discount: l.discount || 0, tax_category: l.tax_category, vat_rate: l.vat_rate, document_id: row.id, org_id: o, line_no: i + 1 }))));
      return row.id;
    },
    async postSalesInvoice(id) { ok(await sb.rpc('post_sales_invoice', { doc: id })); return id; },
    async deleteDraft(id) { ok(await sb.from('documents').delete().eq('id', id).eq('status', 'draft')); },
    async listPayments(kind = 'receipt') { return ok(await sb.from('payments').select('*, parties(name)').eq('org_id', await orgId()).eq('kind', kind).eq('status', 'posted').order('pay_date', { ascending: false }).order('created_at', { ascending: false }))
      .map(p => ({ ...p, party_name: p.parties?.name || '—' })); },
    async createReceipt(r) {
      const amount = Number(r.amount); if (!(amount > 0)) throw new AppError('أدخل مبلغاً صحيحاً');
      if ((r.allocations || []).reduce((a, x) => a + x.amount, 0) > amount) throw new AppError('المبالغ الموزعة أكبر من مبلغ السند');
      const o = await orgId(); const key = r.method === 'cash' ? 'cash' : r.method === 'card' ? 'card_clearing' : 'bank';
      const p = ok(await sb.from('payments').insert({ org_id: o, kind: r.kind || 'receipt', party_id: r.party_id || null, pay_date: r.pay_date, amount, method: r.method, cash_account_id: r.cash_account_id || await acctId(key), reference: r.reference || null }).select().single());
      try {
        if (r.allocations?.length) ok(await sb.from('payment_allocations').insert(r.allocations.map(a => ({ payment_id: p.id, document_id: a.document_id, amount: a.amount }))));
        ok(await sb.rpc('post_payment', { p: p.id }));
      } catch (e) { await sb.from('payments').delete().eq('id', p.id).eq('status', 'draft'); throw e; }   // don't leave a half-made voucher
      return p.id;
    },
    async partyStatement(partyId, side = 'customer') {
      // customer: + invoices, − credit notes & receipts · supplier: + bills, − returns & payments (balance = what we owe)
      const docs = ok(await sb.from('documents').select('id,kind,number,issue_date,total').eq('party_id', partyId).eq('status', 'posted')
        .in('kind', side === 'customer' ? ['tax_invoice', 'simplified_invoice', 'credit_note'] : ['purchase_bill', 'purchase_return']));
      const pays = ok(await sb.from('payments').select('number,pay_date,amount').eq('party_id', partyId).eq('status', 'posted').eq('kind', side === 'customer' ? 'receipt' : 'payment'));
      const W = { tax_invoice: 'فاتورة', simplified_invoice: 'فاتورة', credit_note: 'إشعار دائن', purchase_bill: 'فاتورة مشتريات', purchase_return: 'مرتجع مشتريات' };
      const R = { tax_invoice: '#/invoices/', simplified_invoice: '#/invoices/', credit_note: '#/credit-notes/', purchase_bill: '#/bills/', purchase_return: '#/purchase-returns/' };
      const plus = k => ['tax_invoice', 'simplified_invoice', 'purchase_bill'].includes(k);
      const rows = [...docs.map(d => ({ date: d.issue_date, ref: d.number, what: W[d.kind], debit: plus(d.kind) ? d.total : 0, credit: plus(d.kind) ? 0 : d.total, link: R[d.kind] + d.id })),
        ...pays.map(p => ({ date: p.pay_date, ref: p.number, what: side === 'customer' ? 'سند قبض' : 'سند صرف', debit: 0, credit: p.amount }))];
      // manual entries & opening balances posted to the receivable / payable account for this party
      const acc = ok(await sb.from('accounts').select('id').eq('org_id', await orgId()).eq('system_key', side === 'customer' ? 'ar' : 'ap'))[0];
      if (acc) ok(await sb.from('journal_lines').select('debit,credit,journal_entries(id,number,entry_date,source_type,status,memo)').eq('party_id', partyId).eq('account_id', acc.id))
        .filter(l => l.journal_entries?.status === 'posted' && l.journal_entries.source_type === 'manual').forEach(l => { const e = l.journal_entries, d = Number(l.debit), c = Number(l.credit);
          rows.push({ date: e.entry_date, ref: String(e.number), what: e.memo || 'قيد يدوي', debit: side === 'customer' ? d : c, credit: side === 'customer' ? c : d, link: '#/journal/' + e.id }); });
      rows.sort((a, b) => a.date.localeCompare(b.date));
      let bal = 0; rows.forEach(r => { bal += r.debit - r.credit; r.balance = bal; }); return rows;
    },
    // ---------- companies & permissions ----------
    async myOrgs() { const u = (await sb.auth.getSession()).data.session?.user; if (!u) return [];
      return ok(await sb.from('members').select('org_id,role,orgs(name_ar)').eq('user_id', u.id).order('created_at')).map(m => ({ id: m.org_id, role: m.role, name: m.orgs?.name_ar })); },
    switchOrg(id) { localStorage.setItem('daftar-org', id); orgCache = null; },
    async listRoles() { return ok(await sb.from('roles').select('*').eq('org_id', await orgId()).order('created_at')); },
    async saveRole(id, name, permissions) { if (!name?.trim()) throw new AppError('اسم الدور مطلوب'); return ok(await sb.rpc('save_role', { p_org: await orgId(), p_id: id || null, p_name: name, p_permissions: permissions })); },
    async deleteRole(id) { ok(await sb.rpc('delete_role', { p_id: id })); },
    // ---------- documents: post / issue / convert / approval ----------
    async postDocument(kind, id) {
      const fn = { tax_invoice: 'post_sales_invoice', simplified_invoice: 'post_sales_invoice', credit_note: 'post_credit_note', purchase_bill: 'post_purchase_bill',
        purchase_return: 'post_purchase_return', quote: 'issue_document', sales_order: 'issue_document', purchase_order: 'issue_document', delivery_note: 'issue_document' }[kind];
      ok(await sb.rpc(fn, { doc: id })); return id; },
    async convertDocument(src, target) { return ok(await sb.rpc('convert_document', { src, target })); },
    async submitForApproval(table, id) { ok(await sb.from(table).update({ submitted_at: new Date().toISOString() }).eq('id', id).eq('status', 'draft')); },
    async relatedDocuments(id) { return ok(await sb.from('documents').select('id,kind,number,status,total').eq('related_document_id', id)); },
    async listLanded(billId) { return ok(await sb.from('landed_costs').select('*').eq('bill_id', billId)); },
    async saveLanded(billId, rows) { const o = await orgId(); ok(await sb.from('landed_costs').delete().eq('bill_id', billId));
      if (rows.length) ok(await sb.from('landed_costs').insert(rows.map(r => ({ org_id: o, bill_id: billId, description: r.description, amount: r.amount })))); },
    async listCostCenters(all) { return ok(await sb.from('cost_centers').select('*').eq('org_id', await orgId()).order('code')).filter(c => all || !c.is_template)
      .map(c => ({ ...c, contract_value: c.contract_value == null ? null : Number(c.contract_value), budget_other: c.budget_other == null ? null : Number(c.budget_other), production_qty: c.production_qty == null ? null : Number(c.production_qty) })); },
    // ---- projects: plan, materials, workers, hours, copies ----
    async listProjectMaterials(cc) { return ok(await sb.from('project_materials').select('*').eq('cost_center_id', cc)).map(m => ({ ...m, planned_qty: Number(m.planned_qty) })); },
    async saveProjectMaterial(m) { return ok(await sb.from('project_materials').upsert({ ...m, org_id: await orgId() }, { onConflict: 'cost_center_id,item_id' }).select().single()); },
    async deleteProjectMaterial(id) { ok(await sb.from('project_materials').delete().eq('id', id)); },
    async projectStock(cc) { return ok(await sb.from('stock_docs').select('id,kind,number,doc_date,status,from_warehouse_id,to_warehouse_id,stock_doc_lines(item_id,qty,unit_cost)').eq('org_id', await orgId()).eq('cost_center_id', cc).in('kind', ['issue', 'issue_return']).order('doc_date', { ascending: false }))
      .map(d => ({ ...d, stock_doc_lines: d.stock_doc_lines.map(l => ({ ...l, qty: Number(l.qty), unit_cost: Number(l.unit_cost || 0) })) })); },
    async listWorkers() { return ok(await sb.rpc('list_workers', { p_org: await orgId() })).map(w => ({ ...w, hour_rate: w.hour_rate == null ? null : Number(w.hour_rate), daily_rate: w.daily_rate == null ? null : Number(w.daily_rate), employment_type: w.employment_type || 'monthly' })); },
    async listTimesheets(cc) { return ok(await sb.from('timesheets').select('*').eq('cost_center_id', cc).order('work_date', { ascending: false }).order('created_at', { ascending: false }))
      .map(t => ({ ...t, hours: Number(t.hours), rate: Number(t.rate), amount: Number(t.amount) })); },
    async addTimesheets(rows) { const o = await orgId(); return ok(await sb.from('timesheets').insert(rows.map(r => ({ ...r, org_id: o }))).select()); },
    async deleteTimesheet(id) { ok(await sb.from('timesheets').delete().eq('id', id)); },
    async postLabor(cc, until) { return ok(await sb.rpc('post_labor', { p_cc: cc, p_until: until })); },
    async copyProject(src, code, name, party, start, template) { return ok(await sb.rpc('copy_project', { p_src: src, p_code: code, p_name: name, p_party: party || null, p_start: start || null, p_template: !!template })); },
    async saveCostCenter(c) { return ok(await sb.from('cost_centers').upsert(nulls({ ...c, org_id: await orgId() })).select().single()); },
    // ---------- expenses ----------
    async listExpenses() { return ok(await sb.from('expenses').select('*, accounts(code,name_ar)').eq('org_id', await orgId()).order('expense_date', { ascending: false }).order('created_at', { ascending: false })); },
    async saveExpense(x) { return ok(await sb.from('expenses').upsert(nulls({ ...x, org_id: await orgId() })).select().single()); },
    async postExpense(id) { ok(await sb.rpc('post_expense', { e: id })); },
    async deleteExpense(id) { ok(await sb.from('expenses').delete().eq('id', id).eq('status', 'draft')); },
    // ---------- journal ----------
    async listEntries() { return ok(await sb.from('journal_entries').select('*, journal_lines(debit,credit)').eq('org_id', await orgId()).eq('status', 'posted').order('number', { ascending: false }).limit(300)); },
    async getEntry(id) { const e = ok(await sb.from('journal_entries').select('*').eq('id', id).single());
      const lines = ok(await sb.from('journal_lines').select('*, accounts(code,name_ar), parties(name)').eq('entry_id', id));
      const reversed = ok(await sb.from('journal_entries').select('id,number').eq('reverses_id', id)); return { ...e, lines, reversed: reversed[0] || null }; },
    async postManualEntry(date, memo, lines) { return ok(await sb.rpc('post_manual_entry', { p_org: await orgId(), p_date: date, p_memo: memo, p_lines: lines })); },
    async reverseEntry(id, date) { return ok(await sb.rpc('reverse_entry', { e: id, on_date: date })); },
    // ---------- warehouses & stock ----------
    // ---- customer portal & van trips ----
    async createPortalLink(party) { return ok(await sb.rpc('create_portal_link', { p_party: party })); },
    async revokePortalLink(party) { ok(await sb.rpc('revoke_portal_link', { p_party: party })); },
    async portalView(tok) { const r = ok(await sb.rpc('portal_view', { p_token: tok })); return { ...r, balance: Number(r.balance), documents: r.documents.map(d => ({ ...d, total: Number(d.total), amount_paid: Number(d.amount_paid), subtotal: Number(d.subtotal), vat_total: Number(d.vat_total) })), payments: r.payments.map(y => ({ ...y, amount: Number(y.amount) })) }; },
    async portalDocument(tok, id) { const d = ok(await sb.rpc('portal_document', { p_token: tok, p_doc: id })); return { ...d, total: Number(d.total), amount_paid: Number(d.amount_paid), subtotal: Number(d.subtotal), vat_total: Number(d.vat_total) }; },
    async listTrips() { return ok(await sb.from('van_trips').select('*').eq('org_id', await orgId()).order('opened_at', { ascending: false })).map(t => ({ ...t, cash_handed: t.cash_handed == null ? null : Number(t.cash_handed) })); },
    async openTrip(van, source, emp, driver, date, route) { return ok(await sb.rpc('open_trip', { p_org: await orgId(), p_van: van, p_source: source, p_employee: emp, p_driver: driver || null, p_date: date, p_route: route || null })); },
    async closeTrip(id, cash, notes) { ok(await sb.rpc('close_trip', { p_trip: id, p_cash: cash, p_notes: notes || null })); },
    async tripData(t) { const o = await orgId(), inWin = x => x.posted_at && x.posted_at >= t.opened_at && (!t.closed_at || x.posted_at <= t.closed_at);
      const [st, docs] = await Promise.all([sb.from('stock_docs').select('id,kind,from_warehouse_id,to_warehouse_id,posted_at,stock_doc_lines(item_id,qty)').eq('org_id', o).eq('kind', 'transfer').eq('status', 'posted'),
        sb.from('documents').select('id,kind,number,total,amount_paid,payment_status,posted_at,parties(name),document_lines(item_id,qty)').eq('org_id', o).eq('warehouse_id', t.van_warehouse_id).eq('status', 'posted').in('kind', ['tax_invoice', 'simplified_invoice', 'credit_note'])]);
      return { stock: ok(st).filter(x => (x.from_warehouse_id === t.van_warehouse_id || x.to_warehouse_id === t.van_warehouse_id) && inWin(x)), docs: ok(docs).filter(inWin) }; },
    async listBranches() { return ok(await sb.from('branches').select('*').eq('org_id', await orgId()).order('created_at')); },
    async saveBranch(b) { const row = { ...b, org_id: await orgId() }; return b.id ? ok(await sb.from('branches').update(row).eq('id', b.id).select().single()) : ok(await sb.from('branches').insert(row).select().single()); },
    async listWarehouses() { return ok(await sb.from('warehouses').select('*').eq('org_id', await orgId()).order('created_at')); },
    async saveWarehouse(w) { const o = await orgId(); if (!w.branch_id) w = { ...w, branch_id: ok(await sb.from('branches').select('id').eq('org_id', o).limit(1).single()).id };
      return ok(await sb.from('warehouses').upsert(nulls({ ...w, org_id: o })).select().single()); },
    async stockByWarehouse() { return ok(await sb.from('stock_by_warehouse').select('*').eq('org_id', await orgId())).map(r => ({ ...r, qty: Number(r.qty) })); },
    async listStockDocs() { return ok(await sb.from('stock_docs').select('*, stock_doc_lines(qty)').eq('org_id', await orgId()).order('doc_date', { ascending: false }).order('created_at', { ascending: false })); },
    async getStockDoc(id) { const d = ok(await sb.from('stock_docs').select('*').eq('id', id).single());
      return { ...d, lines: ok(await sb.from('stock_doc_lines').select('*').eq('stock_doc_id', id).order('line_no')).map(l => ({ ...l, qty: Number(l.qty), unit_cost: l.unit_cost == null ? null : Number(l.unit_cost), system_qty: l.system_qty == null ? null : Number(l.system_qty) })) }; },
    async saveStockDoc(d, lines) { const row = ok(await sb.from('stock_docs').upsert(nulls({ ...d, org_id: await orgId() })).select().single());
      ok(await sb.from('stock_doc_lines').delete().eq('stock_doc_id', row.id));
      if (lines.length) ok(await sb.from('stock_doc_lines').insert(lines.map((l, i) => ({ stock_doc_id: row.id, line_no: i + 1, item_id: l.item_id, qty: l.qty, unit_cost: l.unit_cost ?? null }))));
      return row.id; },
    async postStockDoc(id) { ok(await sb.rpc('post_stock_doc', { sd: id })); },
    async deleteStockDoc(id) { ok(await sb.from('stock_docs').delete().eq('id', id).eq('status', 'draft')); },
    // ---------- manufacturing ----------
    async listBoms() { return ok(await sb.from('boms').select('*, bom_lines(*)').eq('org_id', await orgId())).map(b => ({ ...b, output_qty: Number(b.output_qty),
      bom_lines: b.bom_lines.sort((x, y) => x.line_no - y.line_no).map(l => ({ ...l, qty: Number(l.qty), waste_pct: Number(l.waste_pct) })) })); },
    async saveBom(b, lines) { const o = await orgId();
      const row = ok(await sb.from('boms').upsert(nulls({ ...(b.id ? { id: b.id } : {}), org_id: o, item_id: b.item_id, output_qty: b.output_qty, notes: b.notes })).select().single());
      ok(await sb.from('bom_lines').delete().eq('bom_id', row.id));
      if (lines.length) ok(await sb.from('bom_lines').insert(lines.map((l, i) => ({ bom_id: row.id, org_id: o, line_no: i + 1, item_id: l.item_id, qty: l.qty, waste_pct: l.waste_pct || 0 }))));
      return row.id; },
    async deleteBom(id) { ok(await sb.from('boms').delete().eq('id', id)); },
    // ---- reports ----
    async accountBalances(from, to) { return ok(await sb.rpc('account_balances', { p_org: await orgId(), p_from: from, p_to: to })).map(r => ({ ...r, opening: Number(r.opening), debit: Number(r.debit), credit: Number(r.credit), closing: Number(r.closing) })); },
    async monthlySummary(n = 6) { return ok(await sb.rpc('monthly_summary', { p_org: await orgId(), p_months: n })).map(r => ({ month: r.month, revenue: Number(r.revenue), cogs: Number(r.cogs), expenses: Number(r.expenses), cash_in: Number(r.cash_in), cash_out: Number(r.cash_out) })); },
    async vatReturn(from, to) { return ok(await sb.rpc('vat_return', { p_org: await orgId(), p_from: from, p_to: to })); },
    async openDocuments(kinds) { return ok(await sb.from('documents').select('id,kind,number,issue_date,due_date,total,amount_paid,party_id,parties(name)').eq('org_id', await orgId()).in('kind', kinds).eq('status', 'posted').neq('payment_status', 'paid').order('issue_date'))
      .map(d => ({ ...d, open: Number(d.total) - Number(d.amount_paid), party_name: d.parties?.name || 'عميل نقدي' })); },
    async projectPl(from, to) { return ok(await sb.rpc('project_pl', { p_org: await orgId(), p_from: from, p_to: to })).map(r => ({ id: r.cost_center_id, revenue: Number(r.revenue), cogs: Number(r.cogs), expenses: Number(r.expenses) })); },
    async projectDocs(cc) { const o = await orgId();
      const [docs, xs, ms] = await Promise.all([sb.from('documents').select('id,kind,number,issue_date,total,status,payment_status,amount_paid,parties(name)').eq('org_id', o).eq('cost_center_id', cc).order('issue_date', { ascending: false }),
        sb.from('expenses').select('id,number,expense_date,amount,vat_amount,description,status').eq('org_id', o).eq('cost_center_id', cc).order('expense_date', { ascending: false }),
        sb.from('mfg_orders').select('id,number,order_date,qty,total_cost,status,items(name_ar)').eq('org_id', o).eq('cost_center_id', cc).order('order_date', { ascending: false })]);
      return { docs: ok(docs), expenses: ok(xs), mfg: ok(ms) }; },
    // ---- extended: accounting ----
    async saveAccount(a) { const o = await orgId(); return a.id ? ok(await sb.from('accounts').update({ name_ar: a.name_ar, code: a.code }).eq('id', a.id).select().single())
      : ok(await sb.from('accounts').insert({ org_id: o, parent_id: a.parent_id, code: a.code, name_ar: a.name_ar, type: a.type, is_postable: a.is_postable !== false }).select().single()); },
    async deleteAccount(id) { const r = ok(await sb.from('accounts').delete().eq('id', id).select()); if (!r.length) throw new AppError('لا يمكن حذف هذا الحساب'); },
    async accountStatement(acc, from, to, party) { return ok(await sb.rpc('account_statement', { p_org: await orgId(), p_account: acc, p_from: from, p_to: to, p_party: party || null }))
      .map(r => ({ ...r, debit: Number(r.debit), credit: Number(r.credit), balance: Number(r.balance) })); },
    async listAssets() { const o = await orgId(); const [a, d] = await Promise.all([sb.from('fixed_assets').select('*, accounts(code,name_ar)').eq('org_id', o).order('code'), sb.from('asset_depreciation').select('asset_id,amount,month').eq('org_id', o)]);
      const dep = {}; ok(d).forEach(x => { (dep[x.asset_id] ||= { sum: 0, last: null }).sum += Number(x.amount); if (!dep[x.asset_id].last || x.month > dep[x.asset_id].last) dep[x.asset_id].last = x.month; });
      return ok(a).map(x => ({ ...x, depreciated: dep[x.id]?.sum || 0, last_month: dep[x.id]?.last || null })); },
    async saveAsset(a) { const row = nulls({ ...a, org_id: await orgId() }); return a.id ? ok(await sb.from('fixed_assets').update(row).eq('id', a.id).select().single()) : ok(await sb.from('fixed_assets').insert(row).select().single()); },
    async deleteAsset(id) { ok(await sb.from('fixed_assets').delete().eq('id', id)); },
    async runDepreciation(month) { return ok(await sb.rpc('run_depreciation', { p_org: await orgId(), p_month: month })); },
    async disposeAsset(id, date, proceeds, account) { return ok(await sb.rpc('dispose_asset', { p_asset: id, p_date: date, p_proceeds: proceeds, p_account: account || null })); },
    async employeeParty(emp) { return ok(await sb.rpc('employee_party', { p_emp: emp })); },
    async custodyBalances() { return ok(await sb.rpc('custody_balances', { p_org: await orgId() })).map(r => ({ ...r, balance: Number(r.balance) })); },
    async custodyMove(party, date, amount, cash, kind, memo) { return ok(await sb.rpc('custody_move', { p_org: await orgId(), p_party: party, p_date: date, p_amount: amount, p_cash_account: cash, p_kind: kind, p_memo: memo || null })); },
    async settleCards(date, gross, fee, bank, ref) { return ok(await sb.rpc('settle_cards', { p_org: await orgId(), p_date: date, p_gross: gross, p_fee: fee, p_bank: bank, p_ref: ref || null })); },
    async listBudgets(year) { return ok(await sb.from('budgets').select('*').eq('org_id', await orgId()).eq('year', year)); },
    async saveBudget(year, account, amounts) { return ok(await sb.from('budgets').upsert({ org_id: await orgId(), year, account_id: account, amounts }, { onConflict: 'org_id,year,account_id' }).select().single()); },
    // ---- extended: CRM & work ----
    async listLeads() { return ok(await sb.from('leads').select('*').eq('org_id', await orgId()).order('created_at', { ascending: false })); },
    async saveLead(l) { const row = nulls({ ...l, org_id: await orgId(), updated_at: new Date().toISOString() }); return l.id ? ok(await sb.from('leads').update(row).eq('id', l.id).select().single()) : ok(await sb.from('leads').insert(row).select().single()); },
    async deleteLead(id) { ok(await sb.from('leads').delete().eq('id', id)); },
    async exportOrg(source = 'app') { return ok(await sb.rpc('export_org', { p_org: await orgId(), p_source: source })); },
    async resetOrg(mode, confirm) { return ok(await sb.rpc('reset_org', { p_org: await orgId(), p_mode: mode, p_confirm: confirm })); },
    async importOrg(data, mode) { return ok(await sb.rpc('import_org', { p_data: data, p_mode: mode, p_target: mode === 'replace' ? await orgId() : null })); },
    async backupLog() { return ok(await sb.from('backup_log').select('*').eq('org_id', await orgId()).order('at', { ascending: false }).limit(60)); },
    async dataset(ds, from, to) { return ok(await sb.rpc('report_dataset', { p_org: await orgId(), p_ds: ds, p_from: from, p_to: to })) || []; },
    async listReports() { return ok(await sb.from('saved_reports').select('*').eq('org_id', await orgId()).order('name')); },
    async getReport(id) { return ok(await sb.from('saved_reports').select('*').eq('id', id).single()); },
    async saveReport(r) { const row = { name: r.name, definition: r.definition, pinned: !!r.pinned, org_id: await orgId() };
      return r.id ? ok(await sb.from('saved_reports').update(row).eq('id', r.id).select().single()) : ok(await sb.from('saved_reports').insert(row).select().single()); },
    async deleteReport(id) { ok(await sb.from('saved_reports').delete().eq('id', id)); },
    async listStudies() { return ok(await sb.from('feasibility_studies').select('*').eq('org_id', await orgId()).order('updated_at', { ascending: false })); },
    async getStudy(id) { return ok(await sb.from('feasibility_studies').select('*').eq('id', id).single()); },
    async saveStudy(f) { const row = { name: f.name, kind: f.kind, inputs: f.inputs || {}, ai_notes: f.ai_notes || null, status: f.status || 'draft', org_id: await orgId() };
      return f.id ? ok(await sb.from('feasibility_studies').update(row).eq('id', f.id).select().single()) : ok(await sb.from('feasibility_studies').insert(row).select().single()); },
    async deleteStudy(id) { ok(await sb.from('feasibility_studies').delete().eq('id', id)); },
    async projectHistory(cc) { const r = ok(await sb.rpc('project_cost_history', { p_org: await orgId(), p_cc: cc }))[0] || {};
      return { revenue: Number(r.revenue || 0), materials: Number(r.materials || 0), labor: Number(r.labor || 0), other: Number(r.other || 0), hours: Number(r.hours || 0), qty: Number(r.qty || 0), name: r.name, product_item_id: r.product_item_id }; },
    async itemHistory(item) { const r = ok(await sb.rpc('item_history', { p_org: await orgId(), p_item: item }))[0] || {};
      return { avg_cost: Number(r.avg_cost || 0), avg_price: r.avg_price == null ? null : Number(r.avg_price), sold_qty: Number(r.sold_qty || 0), list_price: Number(r.list_price || 0), name: r.name }; },
    async overheadHistory() { return ok(await sb.rpc('overhead_history', { p_org: await orgId() })).map(r => ({ id: r.account_id, name: r.name, monthly: Number(r.monthly) })); },
    async listTasks() { return ok(await sb.from('tasks').select('*, cost_centers(code,name)').eq('org_id', await orgId()).order('due_date', { nullsFirst: false })); },
    async saveTask(t) { const row = nulls({ ...t, org_id: await orgId() }); return t.id ? ok(await sb.from('tasks').update(row).eq('id', t.id).select().single()) : ok(await sb.from('tasks').insert(row).select().single()); },
    async deleteTask(id) { ok(await sb.from('tasks').delete().eq('id', id)); },
    async listCommitments() { return ok(await sb.from('commitments').select('*, employees(full_name)').eq('org_id', await orgId()).order('expiry_date')); },
    async saveCommitment(c) { const row = nulls({ ...c, org_id: await orgId() }); return c.id ? ok(await sb.from('commitments').update(row).eq('id', c.id).select().single()) : ok(await sb.from('commitments').insert(row).select().single()); },
    async deleteCommitment(id) { ok(await sb.from('commitments').delete().eq('id', id)); },
    async listNotes(from, to) { return ok(await sb.from('calendar_notes').select('*').eq('org_id', await orgId()).gte('note_date', from).lte('note_date', to).order('note_date')); },
    async saveNote(n) { const row = { ...n, org_id: await orgId() }; return n.id ? ok(await sb.from('calendar_notes').update(row).eq('id', n.id).select().single()) : ok(await sb.from('calendar_notes').insert(row).select().single()); },
    async deleteNote(id) { ok(await sb.from('calendar_notes').delete().eq('id', id)); },
    // ---- extended: HR ----
    async listLeaves() { return ok(await sb.from('leaves').select('*, employees(full_name)').eq('org_id', await orgId()).order('start_date', { ascending: false })); },
    async saveLeave(l) { const row = nulls({ ...l, org_id: await orgId() }); return l.id ? ok(await sb.from('leaves').update(row).eq('id', l.id).select().single()) : ok(await sb.from('leaves').insert(row).select().single()); },
    async deleteLeave(id) { ok(await sb.from('leaves').delete().eq('id', id)); },
    async decideLeave(id, approve) { ok(await sb.rpc('decide_leave', { p_id: id, p_approve: approve })); },
    async leaveBalances(year) { return ok(await sb.rpc('leave_balances', { p_org: await orgId(), p_year: year })).map(r => ({ ...r, used: Number(r.used), remaining: Number(r.remaining) })); },
    async listAttendance(day) { return ok(await sb.from('attendance').select('*').eq('org_id', await orgId()).eq('day', day)); },
    async attendanceRange(from, to) { return ok(await sb.from('attendance').select('*').eq('org_id', await orgId()).gte('day', from).lte('day', to)); },
    async saveAttendance(rows) { const o = await orgId(); return ok(await sb.from('attendance').upsert(rows.map(r => ({ ...r, org_id: o })), { onConflict: 'employee_id,day' }).select()); },
    async listEvaluations() { return ok(await sb.from('evaluations').select('*, employees(full_name)').eq('org_id', await orgId()).order('eval_date', { ascending: false })); },
    async saveEvaluation(e) { return ok(await sb.from('evaluations').insert({ ...e, org_id: await orgId() }).select().single()); },
    // ---- HR & payroll ----
    async listEmployees() { return ok(await sb.from('employees').select('*').eq('org_id', await orgId()).order('full_name')).map(e => ({ ...e, basic_salary: Number(e.basic_salary), housing_allowance: Number(e.housing_allowance), transport_allowance: Number(e.transport_allowance),
      hourly_rate: e.hourly_rate == null ? null : Number(e.hourly_rate), daily_rate: e.daily_rate == null ? null : Number(e.daily_rate), employment_type: e.employment_type || 'monthly' })); },
    async casualBalances() { return ok(await sb.rpc('casual_balances', { p_org: await orgId() })).map(r => ({ ...r, earned: Number(r.earned), paid: Number(r.paid), owed: Number(r.owed) })); },
    async payCasual(emp, amount, cash, date, memo) { return ok(await sb.rpc('pay_casual', { p_org: await orgId(), p_emp: emp, p_amount: amount, p_cash: cash, p_date: date, p_memo: memo || null })); },
    async saveEmployee(e) { const o = await orgId(); const row = { ...e, org_id: o };
      return e.id ? ok(await sb.from('employees').update(row).eq('id', e.id).select().single()) : ok(await sb.from('employees').insert(row).select().single()); },
    async listPayrollRuns() { return ok(await sb.from('payroll_runs').select('*').eq('org_id', await orgId()).order('period_month', { ascending: false })); },
    async getPayrollRun(id) { const r = ok(await sb.from('payroll_runs').select('*').eq('id', id).single());
      r.payslips = ok(await sb.from('payslips').select('*, employees(full_name,is_saudi,job_title,iban,hire_date,basic_salary,housing_allowance,transport_allowance,other_allowances)').eq('run_id', id));
      r.payslips.sort((a, b) => (a.employees?.full_name || '').localeCompare(b.employees?.full_name || '', 'ar')); return r; },
    async preparePayroll(month) { return ok(await sb.rpc('prepare_payroll', { p_org: await orgId(), p_month: month })); },
    async updatePayslip(id, additions, deductions, note) { ok(await sb.rpc('update_payslip', { p_id: id, p_additions: additions, p_deductions: deductions, p_note: note || null })); },
    async setPayrollOptions(id, includeEosb, submit) { ok(await sb.rpc('set_payroll_options', { p_run: id, p_include_eosb: includeEosb, p_submit: !!submit })); },
    async deletePayroll(id) { ok(await sb.rpc('delete_payroll', { p_run: id })); },
    async postPayroll(id) { return ok(await sb.rpc('post_payroll', { p_run: id })); },
    async payPayroll(id, account, date) { return ok(await sb.rpc('pay_payroll', { p_run: id, p_account: account, p_date: date })); },
    async listMfg() { return ok(await sb.from('mfg_orders').select('*, items(name_ar,unit), parties(name)').eq('org_id', await orgId()).order('order_date', { ascending: false }).order('created_at', { ascending: false }))
      .map(m => ({ ...m, qty: Number(m.qty), unit_cost: m.unit_cost == null ? null : Number(m.unit_cost) })); },
    async getMfg(id) { const m = ok(await sb.from('mfg_orders').select('*, items(name_ar,unit), parties(name)').eq('id', id).single());
      const lines = ok(await sb.from('mfg_order_lines').select('*').eq('order_id', id).order('line_no')).map(l => ({ ...l, planned_qty: Number(l.planned_qty), actual_qty: Number(l.actual_qty), waste_qty: Number(l.waste_qty), unit_cost: l.unit_cost == null ? null : Number(l.unit_cost) }));
      const costs = ok(await sb.from('mfg_order_costs').select('*').eq('order_id', id));
      const entry = m.status === 'posted' ? ok(await sb.from('journal_entries').select('id,number').eq('source_type', 'stock').eq('source_id', id).maybeSingle()) : null;
      return { ...m, qty: Number(m.qty), unit_cost: m.unit_cost == null ? null : Number(m.unit_cost), lines, costs, entry }; },
    async saveMfg(m, lines, costs) { const o = await orgId();
      const row = ok(await sb.from('mfg_orders').upsert(nulls({ ...m, org_id: o })).select().single());
      ok(await sb.from('mfg_order_lines').delete().eq('order_id', row.id)); ok(await sb.from('mfg_order_costs').delete().eq('order_id', row.id));
      if (lines.length) ok(await sb.from('mfg_order_lines').insert(lines.map((l, i) => ({ order_id: row.id, org_id: o, line_no: i + 1, item_id: l.item_id, planned_qty: l.planned_qty || 0, actual_qty: l.actual_qty || 0, waste_qty: l.waste_qty || 0 }))));
      if (costs.length) ok(await sb.from('mfg_order_costs').insert(costs.map(c => ({ order_id: row.id, org_id: o, description: c.description, amount: c.amount, account_id: c.account_id }))));
      return row.id; },
    async postMfg(id) { ok(await sb.rpc('post_mfg_order', { mo: id })); },
    async deleteMfg(id) { ok(await sb.from('mfg_orders').delete().eq('id', id).eq('status', 'draft')); },
    async resetAll() { throw new AppError('غير متاح في وضع الخادم'); },
  };
};
