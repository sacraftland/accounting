// =====================================================================
// Screens. Hash router: #/dashboard, #/invoices/new, #/invoices/<id> ...
// =====================================================================
{
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = h => (Number(h || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toLatin = s => String(s ?? '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/٫/g, '.').replace(/[,٬\s]/g, '');
const toHalalas = s => { const n = Number(toLatin(s)); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };
const num = s => { const n = Number(toLatin(s)); return Number.isFinite(n) ? n : NaN; };
const icon = (n, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const KIND = { tax_invoice: 'فاتورة ضريبية', simplified_invoice: 'فاتورة مبسطة' };
const PAY = { unpaid: ['غير مدفوع', 'b-bad'], partial: ['مدفوع جزئياً', 'b-warn'], paid: ['مدفوع', 'b-ok'] };
const ZAT = { not_sent: ['لم تُرسل', 'b-draft'], pending: ['بانتظار الربط مع زاتكا', 'b-info'], cleared: ['معتمدة', 'b-ok'], reported: ['مُبلَّغة', 'b-ok'], rejected: ['مرفوضة', 'b-bad'] };
const METHOD = { cash: 'نقداً', card: 'شبكة / مدى', bank_transfer: 'تحويل بنكي' };
const TAXCAT = { S: 'خاضع 15%', Z: 'نسبة صفرية', E: 'معفى' };
const badge = ([t, c]) => `<span class="badge ${c}">${esc(t)}</span>`;

// ---------- back end selection ----------
let api = LocalAPI;
// Supabase settings: written into the file (config.js block) for everyone, or typed in Settings on one device.
const BAKED = SUPABASE_CONFIG?.url && SUPABASE_CONFIG?.anonKey ? { url: SUPABASE_CONFIG.url.replace(/\/$/, ''), key: SUPABASE_CONFIG.anonKey } : null;
const LOCAL_CFG = (() => { try { return JSON.parse(localStorage.getItem('daftar-backend') || 'null'); } catch { return null; } })();
const cfg = LOCAL_CFG?.url ? LOCAL_CFG : BAKED;
// What the auth redirect left in the URL, read before supabase-js tidies it away.
const BOOT = (() => { const h = new URLSearchParams(location.hash.replace(/^#\/?/, '')), q = new URLSearchParams(location.search);
  const get = k => h.get(k) || q.get(k);
  return { recovery: get('type') === 'recovery', authReturn: !!(get('access_token') || get('code')), error: get('error_description') || get('error_code') || get('error') }; })();
let authNotice = BOOT.error ? { kind: 'bad', text: arErr(BOOT.error) } : null;
let recovering = BOOT.recovery;
async function pickBackend() {
  if (!cfg?.url || !cfg?.key) return;
  try {
    await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';
      s.crossOrigin = 'anonymous'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    api = SupabaseAPI(cfg);
    api.onAuth((event) => {
      if (event === 'PASSWORD_RECOVERY') { recovering = true; if (location.hash !== '#/reset') location.hash = '#/reset'; }
      if (event === 'SIGNED_OUT') { ORG = null; }
    });
    await api.session();                                    // waits for supabase-js to read the redirect
    if (BOOT.error || BOOT.authReturn || location.search) history.replaceState(null, '', location.pathname + (recovering ? '#/reset' : BOOT.error ? '#/login' : '#/dashboard'));
  } catch { api = LocalAPI; toast('تعذّر تحميل مكتبة Supabase — تحقق من الإنترنت ثم أعد تحميل الصفحة', 'bad'); serverDown = true; }
}
let serverDown = false;

// ---------- toasts & drawer ----------
function toast(msg, kind = 'ok') {
  const box = $('#toasts'); const t = document.createElement('div');
  t.className = 'toast ' + kind; t.setAttribute('role', kind === 'bad' ? 'alert' : 'status');
  t.innerHTML = icon(kind === 'ok' ? 'check' : kind === 'bad' ? 'x' : 'alert', kind === 'ok' ? 'up' : kind === 'bad' ? 'down' : '') + `<span>${esc(msg)}</span>`;
  while (box.children.length >= 3) box.firstElementChild.remove();
  box.appendChild(t); setTimeout(() => t.remove(), kind === 'bad' ? 7000 : 4000);
}
const fail = e => { console.warn(e); toast(e instanceof AppError || e?.message ? e.message : 'حدث خطأ غير متوقع', 'bad'); };
let lastFocus = null;
function drawer(title, body, onSubmit, submitLabel = 'حفظ') {
  lastFocus = document.activeElement;
  const bg = document.createElement('div'); bg.className = 'drawer-bg';
  bg.innerHTML = `<form class="drawer" role="dialog" aria-modal="true" aria-labelledby="dt" novalidate>
    <header><h2 id="dt">${esc(title)}</h2><button type="button" class="btn ghost icon" data-close aria-label="إغلاق">${icon('x')}</button></header>
    <div class="grid" style="gap:16px">${body}</div><p class="help err" data-err role="alert"></p>
    <footer><button type="button" class="btn ghost" data-close>إلغاء</button><button class="btn primary" type="submit">${esc(submitLabel)}</button></footer></form>`;
  document.body.appendChild(bg);
  const close = () => { bg.remove(); lastFocus?.focus?.(); };
  bg.addEventListener('click', e => { if (e.target === bg || e.target.closest('[data-close]')) close(); });
  bg.addEventListener('keydown', e => { if (e.key === 'Escape') close();
    if (e.key === 'Tab') { const f = $$('input,select,textarea,button', bg).filter(x => !x.disabled); if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); } else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); } } });
  const form = $('form', bg);
  form.addEventListener('submit', async e => { e.preventDefault(); const btn = $('[type=submit]', form); btn.disabled = true; $('[data-err]', form).textContent = '';
    try { await onSubmit(Object.fromEntries(new FormData(form)), form); close(); } catch (err) { $('[data-err]', form).textContent = err.message || 'حدث خطأ'; } finally { btn.disabled = false; } });
  setTimeout(() => { if (!form.contains(document.activeElement)) $('input,select', form)?.focus(); }, 30);
  return form;
}
const field = (name, label, { type = 'text', value = '', req = false, help = '', attrs = '', cls = '' } = {}) =>
  `<div class="field ${cls}"><label for="f-${name}">${esc(label)}${req ? ' <span aria-hidden="true" style="color:var(--c-danger)">*</span>' : ''}</label>
   <input class="input${type === 'money' || attrs.includes('num') ? ' num' : ''}" id="f-${name}" name="${name}" type="${type === 'money' ? 'text' : type}" ${type === 'money' ? 'inputmode="decimal"' : ''} value="${esc(value)}" ${req ? 'required aria-required="true"' : ''} ${help ? `aria-describedby="h-${name}"` : ''} ${attrs}>
   ${help ? `<span class="help" id="h-${name}">${esc(help)}</span>` : ''}</div>`;
const select = (name, label, opts, value = '', extra = '') => `<div class="field"><label for="f-${name}">${esc(label)}</label><select class="input" id="f-${name}" name="${name}" ${extra}>${
  opts.map(([v, t]) => `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></div>`;

// ---------- shell ----------
const NAV = [   // [route, icon, label, module, local-mode too?]
  ['dashboard', 'home', 'الرئيسية', null, 1],
  ['g', '', 'المبيعات', 'sales'], ['pos', 'pos', 'نقطة البيع', 'sales'], ['invoices', 'file', 'الفواتير', 'sales', 1], ['quotes', 'file', 'عروض الأسعار', 'sales'], ['credit-notes', 'file', 'الإشعارات الدائنة', 'sales'], ['delivery-notes', 'file', 'سندات التسليم', 'sales'],
  ['card-settle', 'receipt', 'تسوية الشبكة (مدى)', 'sales|accounting'], ['leads', 'users', 'العملاء المحتملون', 'sales'],
  ['receipts', 'receipt', 'سندات القبض', 'sales', 1], ['customers', 'users', 'العملاء', 'sales', 1],
  ['g', '', 'المشتريات', 'purchases'], ['bills', 'cart', 'فواتير المشتريات', 'purchases'], ['purchase-orders', 'cart', 'أوامر الشراء', 'purchases'], ['purchase-returns', 'cart', 'مرتجعات المشتريات', 'purchases'],
  ['payments', 'receipt', 'سندات الصرف', 'purchases'], ['suppliers', 'users', 'الموردون', 'purchases'],
  ['g', '', 'المصروفات', 'expenses'], ['expenses', 'receipt', 'المصروفات', 'expenses'], ['custody', 'receipt', 'الصندوق والعهد', 'expenses'],
  ['g', '', 'المخزون والتصنيع', 'inventory|manufacturing'], ['items', 'box', 'الأصناف والخدمات', 'sales|purchases|inventory|manufacturing', 1], ['warehouses', 'box', 'المستودعات والأرصدة', 'inventory'], ['stock', 'box', 'حركات المخزون', 'inventory'], ['trips', 'cart', 'رحلات المندوبين', 'inventory|sales'],
  ['boms', 'box', 'قوائم المواد', 'manufacturing'], ['mfg', 'gear', 'أوامر التصنيع', 'manufacturing'],
  ['g', '', 'المالية', 'accounting|reports'], ['journal', 'book', 'القيود اليومية', 'accounting'], ['accounts', 'book', 'شجرة الحسابات', 'accounting', 1], ['trial-balance', 'chart', 'ميزان المراجعة', 'accounting|reports', 1],
  ['assets', 'box', 'الأصول الثابتة', 'accounting'],
  ['reports', 'chart', 'التقارير المالية', 'reports|accounting'],
  ['g', '', 'الموارد البشرية', 'hr'], ['employees', 'users', 'الموظفون', 'hr'], ['payroll', 'receipt', 'مسيرات الرواتب', 'hr'], ['leaves', 'users', 'الإجازات', 'hr'], ['attendance', 'users', 'الحضور والانصراف', 'hr'], ['evaluations', 'users', 'تقييم الأداء', 'hr'],
  ['g', '', 'المهام والمشاريع', null], ['projects', 'box', 'المشاريع', 'accounting|manufacturing|reports'], ['tasks', 'check', 'المهام', null],
  ['g', '', 'المتابعة', null], ['commitments', 'bell', 'الالتزامات والتجديدات', null],
  ['g', '', '', null], ['branches', 'home', 'الفروع', 'settings'], ['import', 'down', 'استيراد من Excel', 'sales|purchases|inventory'], ['users', 'lock', 'المستخدمون والصلاحيات', 'users'], ['settings', 'gear', 'الإعدادات', null, 1],
];
const navVisible = ([k, , , mod, local]) => (api.mode === 'supabase' || local || k === 'g') && (!mod || mod.split('|').some(m => can(m)));
let ORG = null;
function shell(active, html) {
  const logo = ORG?.logo_path ? `<img src="${esc(ORG.logo_path)}" alt="" style="width:34px;height:34px;object-fit:contain;border-radius:8px;background:#fff">` : `<span class="mark">${icon('book')}</span>`;
  $('#app').innerHTML = `<div class="shell">
    <aside class="side" id="side" aria-label="القائمة الرئيسية"><div class="brand">${logo}<span>${esc(ORG?.name_ar || 'دفتر')}</span></div><div id="orgsw" style="padding:0 12px 8px"></div>
      <nav class="nav">${NAV.filter(navVisible).filter((n, i, a) => n[0] !== 'g' || (a[i + 1] && a[i + 1][0] !== 'g')).map(([k, ic, t, , , soon]) => k === 'g' ? (t ? `<div class="nav-group">${esc(t)}</div>` : '<div style="height:12px"></div>') :
        `<a href="#/${k}" class="${active === k ? 'on' : ''}" ${active === k ? 'aria-current="page"' : ''}>${icon(ic)}${esc(t)}${soon ? '<span class="xs" style="margin-inline-start:auto;opacity:.6">قريباً</span>' : ''}</a>`).join('')}</nav></aside>
    <div class="main"><header class="top">
      <button class="btn ghost icon menu-btn" aria-label="فتح القائمة" aria-controls="side" data-act="menu">${icon('menu')}</button>
      <strong class="m-hide-sm" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(ORG?.name_ar || '')}</strong>
      ${api.mode === 'local' ? '<span class="mode-pill" title="البيانات محفوظة في هذا المتصفح فقط">تجريبي — على هذا الجهاز</span>' : ''}
      <span class="sp"></span>
      ${can('sales', 'create') ? `<a class="btn primary sm" href="#/invoices/new">${icon('plus')}<span class="new-lbl">فاتورة جديدة</span></a>` : ''}
      <button class="btn ghost sm" data-act="signout">خروج</button>
    </header><main class="page" id="main" tabindex="-1">${html}</main></div></div>
    <nav class="bottom-bar" aria-label="اختصارات">
      <a href="#/dashboard" class="${active === 'dashboard' ? 'on' : ''}">${icon('home')}الرئيسية</a><a href="#/invoices/new">${icon('file')}فاتورة</a>
      <a href="#/receipts/new" class="${active === 'receipts' ? 'on' : ''}">${icon('receipt')}سند قبض</a><a href="#/trial-balance" class="${active === 'trial-balance' ? 'on' : ''}">${icon('chart')}الميزان</a></nav>`;
  orgSwitcher().catch(() => {});
}
document.addEventListener('click', async e => {
  const a = e.target.closest('[data-act]'); if (!a) return;
  if (a.dataset.act === 'menu') $('#side').classList.toggle('open');
  if (a.dataset.act === 'signout') { await api.signOut(); ORG = null; if (location.hash === '#/login') route(); else location.hash = '#/login'; }
});
const loading = (msg = 'جارٍ التحميل…') => `<div class="loading-screen" role="status"><div><span class="spin" aria-hidden="true"></span><p>${esc(msg)}</p></div></div>`;
const empty = (ic, title, text, action = '') => `<div class="card empty">${icon(ic)}<h3 style="margin:12px 0 4px">${esc(title)}</h3><p class="muted" style="margin:0 0 16px">${esc(text)}</p>${action}</div>`;

// ---------- auth ----------
const G_LOGO = `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;
const authCard = (title, sub, body) => `<div class="auth"><div class="card">
    <div class="brand"><span class="mark">${icon('book')}</span><span>دفتر</span></div>
    <h1 style="font-size:var(--fs-lg);text-align:center;margin-bottom:4px">${title}</h1>
    ${sub ? `<p class="muted" style="text-align:center;margin:0 0 20px">${sub}</p>` : ''}
    ${authNotice ? `<p class="note ${authNotice.kind}" role="status" style="margin-bottom:16px">${esc(authNotice.text)}</p>` : ''}${body}</div></div>`;
const busy = (btn, on, label) => { btn.disabled = on; if (on) { btn.dataset.l = btn.innerHTML; btn.innerHTML = '<span class="spin"></span> لحظة…'; } else btn.innerHTML = label || btn.dataset.l; };
const emailOk = e => /^\S+@\S+\.\S+$/.test(e || '');
function sentView(email, what) {
  const t = { confirm: ['تحقق من بريدك', 'أرسلنا رابط تأكيد إلى'], magic: ['تحقق من بريدك', 'أرسلنا رابط دخول إلى'], reset: ['تحقق من بريدك', 'أرسلنا رابط تعيين كلمة المرور إلى'] }[what];
  authNotice = null;
  $('#app').innerHTML = authCard(t[0], '', `<div class="grid" style="gap:16px;text-align:center">
    <p style="margin:0">${t[1]}<br><b dir="ltr">${esc(email)}</b></p>
    <p class="muted" style="margin:0">افتح الرسالة واضغط الرابط من نفس الجهاز. لم تصلك؟ تفقّد مجلد الرسائل غير المرغوبة.</p>
    ${what === 'confirm' ? '<button class="btn secondary wide" id="resend">إعادة إرسال رسالة التأكيد</button>' : ''}
    <button class="btn ghost wide" id="toLogin">العودة لتسجيل الدخول</button></div>`);
  $('#toLogin').onclick = () => { if (location.hash === '#/login') route(); else location.hash = '#/login'; };
  if ($('#resend')) $('#resend').onclick = async e => { busy(e.target, true); try { await api.resendConfirm(email); toast('أُعيد الإرسال'); } catch (x) { toast(x.message, 'bad'); } busy(e.target, false); };
}
function authView(mode) {
  const isUp = mode === 'signup', server = api.mode === 'supabase';
  $('#app').innerHTML = authCard(isUp ? 'ابدأ تجربتك المجانية' : 'تسجيل الدخول', isUp ? '14 يوماً بلا بطاقة دفع. حساباتك تُرتَّب تلقائياً مع كل فاتورة.' : 'أهلاً بعودتك.', `
    ${server ? `<button type="button" class="btn secondary lg wide" id="google">${G_LOGO}<span>المتابعة بحساب Google</span></button>
      <div class="or"><span>أو بالبريد الإلكتروني</span></div>` : ''}
    <form id="authf" novalidate>
      ${field('email', 'البريد الإلكتروني', { type: 'email', req: true, attrs: 'autocomplete="email" dir="ltr"' })}
      ${field('pw', 'كلمة المرور', { type: 'password', req: true, help: isUp ? '8 أحرف على الأقل' : '', attrs: `autocomplete="${isUp ? 'new-password' : 'current-password'}" dir="ltr"` })}
      ${!isUp && server ? '<p style="margin:-8px 0 0;text-align:start"><a href="#/forgot">نسيت كلمة المرور؟</a></p>' : ''}
      <p class="help err" id="aerr" role="alert"></p>
      <button class="btn primary lg wide" type="submit">${isUp ? 'إنشاء الحساب' : 'دخول'}</button>
      ${!isUp && server ? '<button type="button" class="btn ghost wide" id="magic">أرسل لي رابط دخول بدون كلمة مرور</button>' : ''}
      <p style="text-align:center;margin:0">${isUp ? 'لديك حساب؟ <a href="#/login">سجّل الدخول</a>' : 'جديد هنا؟ <a href="#/signup">أنشئ حساباً</a>'}</p>
      ${api.mode === 'local' ? `<p class="note${serverDown ? ' bad' : ''}">${serverDown ? 'تعذّر الوصول للخادم — هذه نسخة تجريبية على هذا المتصفح فقط.' : 'وضع التجربة: الحساب والبيانات محفوظة في هذا المتصفح فقط. للربط بالخادم: ضع بيانات Supabase في الملف أو في الإعدادات.'}</p>` : ''}
    </form>`);
  authNotice = null;
  const err = $('#aerr');
  if ($('#google') && api.googleEnabled) api.googleEnabled().then(on => { if (!on) { $('#google')?.remove(); $('.or')?.remove(); } });
  if ($('#google')) $('#google').onclick = async e => { err.textContent = ''; busy(e.currentTarget, true); try { await api.signInWithGoogle(); } catch (x) { err.textContent = x.message; busy(e.currentTarget, false); } };
  if ($('#magic')) $('#magic').onclick = async e => { const email = $('#f-email').value.trim(); err.textContent = '';
    if (!emailOk(email)) { err.textContent = 'اكتب بريدك الإلكتروني أولاً ثم اضغط الزر'; $('#f-email').focus(); return; }
    busy(e.target, true); try { await api.magicLink(email); sentView(email, 'magic'); } catch (x) { err.textContent = x.message; busy(e.target, false); } };
  $('#authf').addEventListener('submit', async e => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); err.textContent = '';
    if (!emailOk(f.email)) return err.textContent = 'أدخل بريداً إلكترونياً صحيحاً';
    if (!f.pw) return err.textContent = 'أدخل كلمة المرور';
    const btn = $('[type=submit]', e.target); busy(btn, true);
    try {
      if (isUp) { const r = await api.signUp(f.email, f.pw); if (r?.needsConfirm) return sentView(f.email.trim(), 'confirm'); }
      else await api.signIn(f.email, f.pw);
      location.hash = '#/dashboard'; route();
    } catch (x) { err.textContent = x.message; busy(btn, false); }
  });
}
function forgotView() {
  $('#app').innerHTML = authCard('نسيت كلمة المرور', 'اكتب بريدك وسنرسل لك رابطاً لتعيين كلمة مرور جديدة.', `<form id="ff" novalidate>
    ${field('email', 'البريد الإلكتروني', { type: 'email', req: true, attrs: 'autocomplete="email" dir="ltr"' })}
    <p class="help err" id="ferr" role="alert"></p><button class="btn primary lg wide" type="submit">إرسال الرابط</button>
    <p style="text-align:center;margin:0"><a href="#/login">العودة لتسجيل الدخول</a></p></form>`);
  $('#ff').addEventListener('submit', async e => { e.preventDefault(); const email = $('#f-email').value.trim(); if (!emailOk(email)) return $('#ferr').textContent = 'أدخل بريداً إلكترونياً صحيحاً';
    const btn = $('[type=submit]', e.target); busy(btn, true); try { await api.resetPassword(email); sentView(email, 'reset'); } catch (x) { $('#ferr').textContent = x.message; busy(btn, false); } });
}
function resetView() {
  $('#app').innerHTML = authCard('كلمة مرور جديدة', 'اختر كلمة مرور جديدة لحسابك.', `<form id="rf" novalidate>
    ${field('pw', 'كلمة المرور الجديدة', { type: 'password', req: true, help: '8 أحرف على الأقل', attrs: 'autocomplete="new-password" dir="ltr"' })}
    ${field('pw2', 'تأكيد كلمة المرور', { type: 'password', req: true, attrs: 'autocomplete="new-password" dir="ltr"' })}
    <p class="help err" id="rerr" role="alert"></p><button class="btn primary lg wide" type="submit">حفظ كلمة المرور</button></form>`);
  $('#rf').addEventListener('submit', async e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)), err = $('#rerr'); err.textContent = '';
    if (f.pw.length < 8) return err.textContent = 'كلمة المرور 8 أحرف على الأقل'; if (f.pw !== f.pw2) return err.textContent = 'كلمتا المرور غير متطابقتين';
    const btn = $('[type=submit]', e.target); busy(btn, true);
    try { await api.updatePassword(f.pw); recovering = false; toast('تم تغيير كلمة المرور'); location.hash = '#/dashboard'; } catch (x) { err.textContent = x.message; busy(btn, false); } });
}

function noCompanyView(email) {
  $('#app').innerHTML = authCard('حسابك غير مرتبط بشركة', '', `<div class="grid" style="gap:16px;text-align:center">
    <p style="margin:0">دخلت بالبريد <b dir="ltr">${esc(email || '')}</b> لكن لا توجد شركة أضافتك بعد.</p>
    <p class="muted" style="margin:0">اطلب من مدير الشركة إضافة بريدك من «الإعدادات ← المستخدمون والصلاحيات»، ثم سجّل الدخول مجدداً.</p>
    <button class="btn secondary wide" id="again">تحقق مرة أخرى</button><button class="btn ghost wide" data-act="signout">تسجيل الخروج</button></div>`);
  $('#again').onclick = () => { ORG = null; route(); };
}

// ---------- onboarding: company ----------
const SECTORS = [['manufacturing', 'صناعة وتصنيع'], ['contracting', 'مقاولات'], ['retail', 'تجارة تجزئة وجملة'], ['services', 'خدمات'], ['food', 'مطاعم ومقاهي'], ['general', 'نشاط آخر']];
const companyFields = (o = {}) => `
  <fieldset class="form-grid"><legend class="full">بيانات المنشأة</legend>
  ${field('name_ar', 'اسم المنشأة', { req: true, value: o.name_ar, cls: 'full' })}
  ${field('vat_number', 'الرقم الضريبي', { value: o.vat_number, help: '15 رقماً يبدأ وينتهي بـ 3 — اتركه فارغاً إن لم تكن مسجلاً', attrs: 'inputmode="numeric" dir="ltr" maxlength="15"' })}
  ${field('cr_number', 'السجل التجاري', { value: o.cr_number, attrs: 'inputmode="numeric" dir="ltr"' })}
  ${select('sector', 'النشاط', SECTORS, o.sector || 'manufacturing')}
  ${field('city', 'المدينة', { req: true, value: o.city })}</fieldset>
  <fieldset class="form-grid"><legend class="full">العنوان الوطني <span class="muted xs">(يظهر على الفاتورة الضريبية)</span></legend>
  ${field('district', 'الحي', { value: o.district })}${field('street', 'الشارع', { value: o.street })}
  ${field('building_no', 'رقم المبنى', { value: o.building_no, attrs: 'inputmode="numeric" dir="ltr" maxlength="4"' })}${field('postal_code', 'الرمز البريدي', { value: o.postal_code, attrs: 'inputmode="numeric" dir="ltr" maxlength="5"' })}</fieldset>`;
function cleanCompany(f) { f.vat_number = toLatin(f.vat_number); f.cr_number = toLatin(f.cr_number); f.building_no = toLatin(f.building_no); f.postal_code = toLatin(f.postal_code);
  if (!f.name_ar?.trim()) throw new AppError('اسم المنشأة مطلوب'); if (!f.city?.trim()) throw new AppError('المدينة مطلوبة');
  if (f.vat_number && !VAT_RE.test(f.vat_number)) throw new AppError('الرقم الضريبي 15 رقماً ويبدأ وينتهي بـ 3'); return f; }
function onboardingView() {
  $('#app').innerHTML = `<div class="auth"><div class="card" style="width:min(720px,100%)">
    <ol class="steps" style="margin-bottom:24px"><li class="done"><span class="n">✓</span><span class="lbl">الحساب</span></li><li class="cur"><span class="n">2</span><span class="lbl">المنشأة</span></li><li><span class="n">3</span><span class="lbl">ابدأ</span></li></ol>
    <h1 style="font-size:var(--fs-lg)">عرّفنا بمنشأتك</h1><p class="muted" style="margin:4px 0 20px">ننشئ لك شجرة حسابات جاهزة وفرعاً ومستودعاً، وتقدر تعدّل كل شيء لاحقاً.</p>
    <form id="orgf" class="grid" style="gap:20px" novalidate>${companyFields()}<p class="help err" id="oerr" role="alert"></p>
    <button class="btn primary lg" type="submit">إنشاء المنشأة</button>${NEW_ORG ? '<button type="button" class="btn ghost" id="cancelorg">رجوع</button>' : ''}</form></div></div>`;
  if ($('#cancelorg')) $('#cancelorg').onclick = () => { NEW_ORG = false; route(); };
  $('#orgf').addEventListener('submit', async e => {
    e.preventDefault(); const err = $('#oerr'); err.textContent = '';
    try { const f = cleanCompany(Object.fromEntries(new FormData(e.target)));
      $('#app').innerHTML = loading('نجهّز حساباتك وشجرة الحسابات…');
      const made = await api.createOrg(f); if (made?.id && api.switchOrg) api.switchOrg(made.id); NEW_ORG = false; ORG = await api.currentOrg(); toast('تم إنشاء المنشأة وشجرة الحسابات'); location.hash = '#/dashboard'; route();
    } catch (x) { if ($('#oerr')) $('#oerr').textContent = x.message; else { fail(x); onboardingView(); } }
  });
}

// ---------- dashboard ----------
async function dashboardView() {
  shell('dashboard', loading());
  const [docs, tb, cns] = await Promise.all([api.listDocuments(['tax_invoice', 'simplified_invoice']), api.trialBalance(), api.mode === 'supabase' && can('sales') ? api.listDocuments(['credit_note']) : []]);
  const month = riyadhToday().slice(0, 7), posted = docs.filter(d => d.status === 'posted');
  const mDocs = posted.filter(d => d.issue_date.startsWith(month));
  const mCn = cns.filter(d => d.status === 'posted' && d.issue_date.startsWith(month));
  const sales = mDocs.reduce((a, d) => a + d.subtotal, 0) - mCn.reduce((a, d) => a + d.subtotal, 0), vat = mDocs.reduce((a, d) => a + d.vat_total, 0) - mCn.reduce((a, d) => a + d.vat_total, 0);
  const open = posted.reduce((a, d) => a + (d.total - d.amount_paid), 0), overdue = posted.filter(d => d.due_date && d.due_date < riyadhToday() && d.payment_status !== 'paid');
  const [pend, ins, cal, top] = await Promise.all([approvalsCard().catch(() => ''), dashInsights().catch(() => ''), dashCalendar().catch(() => ''), topBalances().catch(() => '')]);
  const cash = tb.filter(r => ['1101', '1102', '1103'].includes(r.code)).reduce((a, r) => a + Number(r.balance), 0);
  $('#main').innerHTML = `<div class="page-head"><h1>لوحة التحكم</h1><a class="btn secondary" href="#/receipts/new">${icon('receipt')}سند قبض</a><a class="btn primary" href="#/invoices/new">${icon('plus')}فاتورة جديدة</a></div>
    ${pend}<div class="grid g4" style="margin-bottom:24px">
      <div class="card stat"><div class="label">مبيعات هذا الشهر <span class="xs">(قبل الضريبة)</span></div><div class="val num">${money(sales)}</div><div class="xs muted">${mDocs.length} فاتورة${mCn.length ? ` · بعد ${mCn.length} إشعار دائن` : ''}</div></div>
      <div class="card stat"><div class="label">ضريبة المخرجات هذا الشهر</div><div class="val num">${money(vat)}</div><div class="xs muted">تُورَّد في الإقرار الضريبي</div></div>
      <div class="card stat"><div class="label">مستحق من العملاء</div><div class="val num">${money(open)}</div><div class="xs ${overdue.length ? 'down' : 'muted'}">${overdue.length ? overdue.length + ' فاتورة متأخرة' : 'لا يوجد متأخر'}</div></div>
      <div class="card stat"><div class="label">النقدية والبنك</div><div class="val num">${money(cash)}</div><div class="xs muted">الصندوق + البنك + الشبكة</div></div>
    </div>${cal}${ins}${top}
    <h2 style="margin-bottom:12px">آخر الفواتير</h2>
    ${docs.length ? invoiceTable(docs.slice(0, 6)) : empty('receipt', 'لا توجد فواتير بعد', 'ابدأ بإضافة عميل وصنف، ثم أصدر أول فاتورة — يُسجَّل قيدها في الحسابات تلقائياً.', `<div class="row" style="justify-content:center"><a class="btn secondary" href="#/customers">إضافة عميل</a><a class="btn primary" href="#/invoices/new">${icon('plus')}فاتورة جديدة</a></div>`)}`;
  wireCalendar();
}

// ---------- invoices ----------
const invoiceTable = docs => `<div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>الرقم</th><th>العميل</th><th>التاريخ</th><th>النوع</th><th class="amt">الإجمالي</th><th>الحالة</th></tr></thead><tbody>
  ${docs.map(d => `<tr class="click" data-href="#/invoices/${esc(d.id)}"><td><a class="rowlink num" href="#/invoices/${esc(d.id)}">${esc(d.number || 'مسودة')}</a></td><td class="m-sub" style="white-space:normal">${esc(d.party_name)}</td>
    <td class="num m-hide">${esc(d.issue_date)}</td><td class="m-hide">${esc(KIND[d.kind])}</td><td class="amt num">${money(d.total)}</td>
    <td>${d.status === 'draft' ? badge(['مسودة', 'b-draft']) : badge(PAY[d.payment_status])}</td></tr>`).join('')}</tbody></table></div>`;
document.addEventListener('click', e => { const tr = e.target.closest('tr[data-href]'); if (tr && !e.target.closest('a,button,input,select')) location.hash = tr.dataset.href; });

async function invoicesView() {
  shell('invoices', loading());
  const docs = await api.listDocuments(['tax_invoice', 'simplified_invoice']);
  let tab = sessionStorage.getItem('inv-tab') || 'all';
  const render = () => {
    const f = { all: docs, draft: docs.filter(d => d.status === 'draft'), unpaid: docs.filter(d => d.status === 'posted' && d.payment_status !== 'paid'), paid: docs.filter(d => d.payment_status === 'paid') }[tab];
    const tot = f.filter(d => d.status === 'posted').reduce((a, d) => a + d.total, 0);
    $('#main').innerHTML = `<div class="page-head"><h1>الفواتير</h1><a class="btn primary" href="#/invoices/new">${icon('plus')}فاتورة جديدة</a></div>
      <div class="tabs" role="tablist">${[['all', 'الكل'], ['unpaid', 'غير مدفوعة'], ['paid', 'مدفوعة'], ['draft', 'مسودات']].map(([k, t]) => `<button role="tab" aria-selected="${tab === k}" class="${tab === k ? 'on' : ''}" data-tab="${k}">${t} <span class="muted num">(${({ all: docs, draft: docs.filter(d => d.status === 'draft'), unpaid: docs.filter(d => d.status === 'posted' && d.payment_status !== 'paid'), paid: docs.filter(d => d.payment_status === 'paid') })[k].length})</span></button>`).join('')}</div>
      ${f.length ? invoiceTable(f) + `<p class="muted" style="text-align:end">الإجمالي المرحّل: <b class="num">${money(tot)}</b> ر.س</p>` : empty('file', docs.length ? 'لا شيء هنا' : 'لا توجد فواتير بعد', docs.length ? 'جرّب تبويباً آخر.' : 'أصدر أول فاتورة لعميلك.', docs.length ? '' : `<a class="btn primary" href="#/invoices/new">${icon('plus')}فاتورة جديدة</a>`)}`;
    $$('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; sessionStorage.setItem('inv-tab', tab); render(); });
  };
  render();
}

async function invoiceEditView(id) {
  shell('invoices', loading());
  const srv = api.mode === 'supabase';
  const [parties, items, existing, whs, ccs] = await Promise.all([api.listParties('customer'), api.listItems(), id ? api.getDocument(id) : null, srv ? api.listWarehouses() : [], srv ? api.listCostCenters() : []]);
  if (existing && existing.status !== 'draft') { location.hash = '#/invoices/' + id; return; }
  const doc = existing || { kind: 'tax_invoice', party_id: '', issue_date: riyadhToday(), due_date: '', note: '' };
  let lines = existing ? existing.lines.map(l => ({ item_id: l.item_id || '', description: l.description, qty: Number(l.qty), unit_price: l.unit_price, discount: l.discount || 0, tax_category: l.tax_category, vat_rate: Number(l.vat_rate) }))
    : [{ item_id: '', description: '', qty: 1, unit_price: 0, discount: 0, tax_category: 'S', vat_rate: 15 }];
  const itemById = Object.fromEntries(items.map(i => [i.id, i]));
  $('#main').innerHTML = `<a class="crumb" href="#/invoices">${icon('chev')} الفواتير</a>
    <div class="page-head"><h1>${existing ? 'تعديل مسودة' : 'فاتورة جديدة'}</h1></div>
    ${!parties.length ? `<p class="note warn" style="margin-bottom:16px">لا يوجد عملاء بعد. <a href="#/customers">أضف عميلاً</a> للفاتورة الضريبية، أو اختر "فاتورة مبسطة" للبيع النقدي.</p>` : ''}
    <form class="card" id="invf" novalidate>
      <div class="grid g3" style="margin-bottom:16px">
        ${select('kind', 'نوع الفاتورة', [['tax_invoice', 'فاتورة ضريبية (لمنشأة)'], ['simplified_invoice', 'فاتورة مبسطة (لفرد / نقدي)']], doc.kind)}
        <div class="field"><label for="f-party">العميل</label><select class="input" id="f-party" name="party_id"><option value="">— عميل نقدي —</option>${parties.map(p => `<option value="${esc(p.id)}"${p.id === doc.party_id ? ' selected' : ''}>${esc(p.name)}${p.vat_number ? '' : ' (بدون رقم ضريبي)'}</option>`).join('')}</select>
          <a href="#" class="xs" id="qparty">+ عميل جديد</a><span class="help err" id="climit" role="status"></span></div>
        ${field('issue_date', 'تاريخ الفاتورة', { type: 'date', value: doc.issue_date, req: true })}
        ${field('due_date', 'تاريخ الاستحقاق', { type: 'date', value: doc.due_date || '' })}
        ${whs.length > 1 ? select('warehouse_id', 'المستودع', whs.map(w => [w.id, w.name]), doc.warehouse_id || whs[0].id) : ''}
        ${ccField(ccs, doc.cost_center_id)}
      </div>
      <p class="note bad" id="kindwarn" hidden></p>
      <div class="tbl-wrap editor editor-lines"><table><thead><tr><th style="width:32px">#</th><th style="min-width:180px">الصنف</th><th style="min-width:180px">الوصف</th><th style="width:90px">الكمية</th><th style="width:130px">السعر</th><th style="width:110px">الخصم</th><th style="width:130px">الضريبة</th><th class="amt" style="width:130px">الإجمالي</th><th style="width:44px"></th></tr></thead><tbody id="lines"></tbody></table></div>
      <button type="button" class="btn ghost sm" style="margin-top:8px" id="addl">${icon('plus')}إضافة سطر</button>
      <div class="totals" aria-live="polite"><div><span class="muted">المجموع قبل الضريبة</span><span class="num" id="tSub"></span></div><div><span class="muted">ضريبة القيمة المضافة</span><span class="num" id="tVat"></span></div><div class="grand"><span>الإجمالي</span><span class="num" id="tTot"></span></div></div>
      ${field('note', 'ملاحظات تظهر على الفاتورة', { value: doc.note || '' })}
      <p class="help err" id="ierr" role="alert"></p>
      <div class="row" style="justify-content:flex-end;margin-top:16px">${existing ? '<button type="button" class="btn ghost" id="deld" style="color:var(--c-danger)">حذف المسودة</button>' : ''}<a class="btn ghost" href="#/invoices">إلغاء</a><button type="button" class="btn secondary" id="saved">حفظ كمسودة</button><button class="btn primary" type="submit">ترحيل وإصدار</button></div>
    </form>`;
  const itemOpts = sel => `<option value="">— بدون صنف —</option>` + items.map(i => `<option value="${esc(i.id)}"${i.id === sel ? ' selected' : ''}>${esc(i.name_ar)}</option>`).join('');
  const drawLines = () => {
    $('#lines').innerHTML = lines.map((l, i) => `<tr data-i="${i}">
      <td class="num muted m-hide">${i + 1}</td>
      <td class="c-item" data-l="الصنف"><select class="input" data-k="item_id" aria-label="الصنف — سطر ${i + 1}">${itemOpts(l.item_id)}</select></td>
      <td class="c-desc" data-l="الوصف"><input class="input" data-k="description" value="${esc(l.description)}" aria-label="الوصف — سطر ${i + 1}" placeholder="وصف السلعة أو الخدمة"></td>
      <td data-l="الكمية"><input class="input num" data-k="qty" inputmode="decimal" value="${esc(l.qty)}" aria-label="الكمية"></td>
      <td data-l="السعر (قبل الضريبة)"><input class="input num" data-k="unit_price" inputmode="decimal" value="${esc(money(l.unit_price))}" aria-label="السعر قبل الضريبة"></td>
      <td data-l="الخصم"><input class="input num" data-k="discount" inputmode="decimal" value="${esc(l.discount ? money(l.discount) : '')}" aria-label="الخصم" placeholder="0.00"></td>
      <td data-l="الضريبة"><select class="input" data-k="tax_category" aria-label="نوع الضريبة">${Object.entries(TAXCAT).map(([k, t]) => `<option value="${k}"${k === l.tax_category ? ' selected' : ''}>${t}</option>`).join('')}</select></td>
      <td class="amt num line-total" data-l="الإجمالي" data-total></td>
      <td><button type="button" class="btn ghost icon sm" data-del aria-label="حذف السطر ${i + 1}">${icon('trash')}</button></td></tr>`).join('');
    totals();
  };
  const totals = () => { let s = 0, v = 0; lines.forEach((l, i) => { const c = lineCalc(l); const ok = Number.isFinite(c.net); s += ok ? c.net : 0; v += ok ? c.vat : 0;
      const cell = $(`tr[data-i="${i}"] [data-total]`); if (cell) cell.textContent = ok ? money(c.net + c.vat) : '—'; });
    $('#tSub').textContent = money(s); $('#tVat').textContent = money(v); $('#tTot').textContent = money(s + v) + ' ر.س'; };
  const kindCheck = () => { const k = $('#f-kind').value, p = parties.find(x => x.id === $('#f-party').value), w = $('#kindwarn');
    let msg = ''; if (k === 'tax_invoice' && !p) msg = 'الفاتورة الضريبية تحتاج عميلاً مسجلاً ضريبياً. اختر عميلاً أو غيّر النوع إلى مبسطة.';
    else if (k === 'tax_invoice' && !p.vat_number) msg = 'هذا العميل بلا رقم ضريبي — أضف رقمه من صفحة العملاء أو استخدم فاتورة مبسطة.';
    else if (k === 'tax_invoice' && !(p.city && p.street && p.building_no && p.postal_code)) msg = 'عنوان العميل الوطني ناقص (مطلوب في الفاتورة الضريبية): المدينة، الشارع، رقم المبنى، الرمز البريدي.';
    w.textContent = msg; w.hidden = !msg; return msg; };
  $('#lines').addEventListener('input', e => { const tr = e.target.closest('tr'), k = e.target.dataset.k; if (!tr || !k) return; const l = lines[tr.dataset.i];
    if (k === 'qty') l.qty = num(e.target.value); else if (k === 'unit_price' || k === 'discount') l[k] = toHalalas(e.target.value || 0); else if (k === 'description') l.description = e.target.value; totals(); });
  $('#lines').addEventListener('change', e => { const tr = e.target.closest('tr'), k = e.target.dataset.k; if (!tr) return; const l = lines[tr.dataset.i];
    if (k === 'item_id') { l.item_id = e.target.value; const it = itemById[l.item_id]; if (it) { l.description = it.name_ar; l.unit_price = it.sale_price; l.tax_category = it.tax_category; l.vat_rate = it.tax_category === 'S' ? 15 : 0; } drawLines(); }
    if (k === 'tax_category') { l.tax_category = e.target.value; l.vat_rate = l.tax_category === 'S' ? 15 : 0; totals(); } });
  $('#lines').addEventListener('click', e => { if (e.target.closest('[data-del]')) { lines.splice(e.target.closest('tr').dataset.i, 1); if (!lines.length) lines.push({ item_id: '', description: '', qty: 1, unit_price: 0, discount: 0, tax_category: 'S', vat_rate: 15 }); drawLines(); } });
  $('#lines').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); const tr = e.target.closest('tr');
    if (+tr.dataset.i === lines.length - 1) { addLine(); } else $(`tr[data-i="${+tr.dataset.i + 1}"] input`)?.focus(); } });
  const addLine = () => { lines.push({ item_id: '', description: '', qty: 1, unit_price: 0, discount: 0, tax_category: 'S', vat_rate: 15 }); drawLines(); $(`tr[data-i="${lines.length - 1}"] select`).focus(); };
  $('#addl').onclick = addLine;
  ['#f-kind', '#f-party'].forEach(s => $(s).addEventListener('change', kindCheck));
  const climit = async () => { const el = $('#climit'), p = parties.find(x => x.id === $('#f-party').value); if (!el) return; el.textContent = '';
    if (!p || p.credit_limit == null || api.mode !== 'supabase') return; const open = (await api.openDocuments(['tax_invoice', 'simplified_invoice']).catch(() => [])).filter(d => d.party_id === p.id && d.id !== id).reduce((s, d) => s + d.open, 0);
    const tot = lines.reduce((s, l) => s + Math.round((Number(l.qty) || 0) * (Number(l.unit_price) || 0) * (1 + (Number(l.vat_rate ?? 15)) / 100)), 0);
    if (open + tot > p.credit_limit) el.textContent = `تنبيه: الرصيد المستحق ${money(open)} + هذه الفاتورة يتجاوز حد الائتمان ${money(p.credit_limit)}`; };
  $('#f-party').addEventListener('change', climit); climit();
  $('#qparty').onclick = e => { e.preventDefault(); partyDrawer(null, async p => { toast('تمت إضافة العميل'); const keep = collect(); await invoiceEditViewKeep(keep, p.id); }); };
  const collect = () => { const f = Object.fromEntries(new FormData($('#invf'))); return { doc: { ...(existing ? { id: existing.id } : {}), kind: f.kind, party_id: f.party_id || null, issue_date: f.issue_date, issue_time: riyadhTime(), due_date: f.due_date || null, note: f.note, branch_id: existing?.branch_id || null,
    ...(srv ? { warehouse_id: f.warehouse_id || existing?.warehouse_id || null, cost_center_id: f.cost_center_id || null } : {}) }, lines }; };
  const validate = () => { const err = []; if (!$('#f-issue_date').value) err.push('تاريخ الفاتورة مطلوب');
    const real = lines.filter(l => l.description?.trim() || l.item_id);
    if (!real.length) err.push('أضف سطراً واحداً على الأقل');
    real.forEach((l, i) => { if (!l.description?.trim()) err.push(`السطر ${i + 1}: الوصف مطلوب`); if (!(l.qty > 0)) err.push(`السطر ${i + 1}: الكمية يجب أن تكون أكبر من صفر`);
      if (!Number.isFinite(l.unit_price) || l.unit_price < 0) err.push(`السطر ${i + 1}: السعر غير صحيح`); if (!Number.isFinite(l.discount) || l.discount < 0) err.push(`السطر ${i + 1}: الخصم غير صحيح`);
      if (l.discount > Math.round(l.qty * l.unit_price)) err.push(`السطر ${i + 1}: الخصم أكبر من قيمة السطر`); });
    return { err, real }; };
  const save = async post => { const { err, real } = validate(); if (post) { const k = kindCheck(); if (k) err.unshift(k); }
    $('#ierr').textContent = err.join(' · '); if (err.length) return;
    const btns = $$('#invf button'); btns.forEach(b => b.disabled = true);
    try { const { doc } = collect(); const newId = await api.saveDraft(doc, real.map(l => ({ ...l, item_id: l.item_id || null, discount: l.discount || 0, line_net: 0, line_vat: 0 })));
      if (post) { await api.postSalesInvoice(newId); toast('تم إصدار الفاتورة وتسجيل قيدها'); } else toast('تم حفظ المسودة');
      location.hash = '#/invoices/' + newId; } catch (x) { fail(x); $('#ierr').textContent = x.message; btns.forEach(b => b.disabled = false); } };
  $('#invf').addEventListener('submit', e => { e.preventDefault(); save(true); });
  $('#saved').onclick = () => save(false);
  if (existing) $('#deld').onclick = async () => { if ($('#deld').dataset.sure) { await api.deleteDraft(existing.id); toast('حُذفت المسودة'); location.hash = '#/invoices'; } else { $('#deld').dataset.sure = 1; $('#deld').textContent = 'اضغط مرة أخرى للتأكيد'; } };
  drawLines(); if (parties.length || doc.kind !== 'tax_invoice') kindCheck();
  invoiceEditViewKeep = async (keep, newParty) => { await invoiceEditView(id); lines = keep.lines; $('#f-kind').value = keep.doc.kind; $('#f-party').value = newParty; $('#f-issue_date').value = keep.doc.issue_date; drawLines(); kindCheck(); };
}
let invoiceEditViewKeep = null;

async function invoiceView(id) {
  shell('invoices', loading());
  const d = await api.getDocument(id), o = ORG, p = d.party;
  if (d.status === 'draft') { location.hash = '#/invoices/' + id + '/edit'; return; }
  const ts = `${d.issue_date}T${(d.issue_time || '00:00:00').slice(0, 8)}+03:00`;
  let qrSvg = '', qrErr = '';
  try { const tlv = QR.zatcaTLV({ seller: o.name_ar, vatNo: o.vat_number || '', timestamp: new Date(ts).toISOString().replace('.000', ''), total: (d.total / 100).toFixed(2), vat: (d.vat_total / 100).toFixed(2) });
    qrSvg = QR.svg(QR.encode(QR.ascii(tlv)), 3); } catch (x) { qrErr = x.message; }
  const addr = x => [x?.building_no && 'مبنى ' + x.building_no, x?.street, x?.district, x?.city, x?.postal_code].filter(Boolean).map(esc).join('، ');
  const left = d.total - d.amount_paid;
  $('#main').innerHTML = `<a class="crumb no-print" href="#/invoices">${icon('chev')} الفواتير</a>
    <div class="page-head no-print"><h1><span class="num">${esc(d.number)}</span></h1>${badge(PAY[d.payment_status])}${badge(ZAT[d.zatca_status] || ZAT.not_sent)}
      <button class="btn secondary" onclick="window.print()">${icon('down')}طباعة / PDF</button>
      ${api.mode === 'supabase' && can('sales', 'create') ? '<button class="btn secondary" id="mkcn">إصدار إشعار دائن</button>' : ''}
      ${left > 0 ? `<a class="btn primary" href="#/receipts/new?party=${esc(d.party_id || '')}&doc=${esc(d.id)}">${icon('receipt')}تسجيل دفعة</a>` : ''}</div>
    ${!o.vat_number ? '<p class="note warn no-print" style="margin-bottom:16px">منشأتك بلا رقم ضريبي — رمز QR لن يكون صالحاً لزاتكا. أضفه من الإعدادات.</p>' : ''}
    <article class="paper" aria-label="الفاتورة">
      <div class="hd"><div>${o.logo_path ? `<img src="${esc(o.logo_path)}" alt="شعار ${esc(o.name_ar)}" style="max-height:56px;max-width:160px;display:block;margin-bottom:8px">` : ''}
        <b style="font-size:18px">${esc(o.name_ar)}</b><br>${o.vat_number ? `الرقم الضريبي: <span class="num">${esc(o.vat_number)}</span><br>` : ''}${o.cr_number ? `السجل التجاري: <span class="num">${esc(o.cr_number)}</span><br>` : ''}${addr(o)}</div>
        <div style="text-align:end"><b style="font-size:18px">${d.kind === 'tax_invoice' ? 'فاتورة ضريبية<br>Tax Invoice' : 'فاتورة ضريبية مبسطة<br>Simplified Tax Invoice'}</b><br>
        رقم الفاتورة: <span class="num">${esc(d.number)}</span><br>تاريخ الإصدار: <span class="num">${esc(d.issue_date)} ${esc((d.issue_time || '').slice(0, 5))}</span>${d.due_date ? `<br>تاريخ الاستحقاق: <span class="num">${esc(d.due_date)}</span>` : ''}</div></div>
      <p style="margin:0 0 12px"><b>العميل:</b> ${esc(p?.name || 'عميل نقدي')}${p?.vat_number ? ` — الرقم الضريبي <span class="num">${esc(p.vat_number)}</span>` : ''}${addr(p) ? `<br>${addr(p)}` : ''}</p>
      <div style="overflow-x:auto"><table><thead><tr><th>#</th><th>الوصف</th><th>الكمية</th><th class="amt">سعر الوحدة</th><th class="amt">الخصم</th><th class="amt">المبلغ الخاضع</th><th>النسبة</th><th class="amt">الضريبة</th><th class="amt">الإجمالي</th></tr></thead>
        <tbody>${d.lines.map((l, i) => `<tr><td class="num">${i + 1}</td><td style="white-space:normal">${esc(l.description)}</td><td class="num">${esc(Number(l.qty))}</td><td class="amt num">${money(l.unit_price)}</td><td class="amt num">${l.discount ? money(l.discount) : '—'}</td><td class="amt num">${money(l.line_net)}</td><td class="num">${l.tax_category === 'S' ? '15%' : esc(TAXCAT[l.tax_category])}</td><td class="amt num">${money(l.line_vat)}</td><td class="amt num">${money(l.line_net + l.line_vat)}</td></tr>`).join('')}</tbody></table></div>
      <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin-top:16px;flex-wrap:wrap">
        <div>${qrSvg || `<p class="note bad">${esc(qrErr)}</p>`}</div>
        <div style="width:min(300px,100%)"><div style="display:flex;justify-content:space-between">الإجمالي غير شامل الضريبة<span class="num">${money(d.subtotal)}</span></div>
          <div style="display:flex;justify-content:space-between">ضريبة القيمة المضافة<span class="num">${money(d.vat_total)}</span></div>
          <div style="display:flex;justify-content:space-between;font-weight:700;border-top:2px solid #000;margin-top:6px;padding-top:6px">الإجمالي (ر.س)<span class="num">${money(d.total)}</span></div>
          ${d.amount_paid ? `<div style="display:flex;justify-content:space-between">المدفوع<span class="num">${money(d.amount_paid)}</span></div><div style="display:flex;justify-content:space-between;font-weight:700">المتبقي<span class="num">${money(left)}</span></div>` : ''}</div></div>
      ${d.note ? `<p style="margin-top:12px">${esc(d.note)}</p>` : ''}${o.invoice_footer ? `<p style="margin-top:12px;color:#444;font-size:12px">${esc(o.invoice_footer)}</p>` : ''}
    </article>
    <div class="grid g2 no-print" style="margin-top:24px">
      <section class="card"><h3 style="margin-bottom:8px">القيد المحاسبي <span class="muted xs">(سُجّل تلقائياً — رقم <span class="num">${esc(d.entry?.number)}</span>)</span></h3>
        <div class="tbl-wrap"><table><thead><tr><th>الحساب</th><th class="amt">مدين</th><th class="amt">دائن</th></tr></thead><tbody>
        ${d.journal.map(l => `<tr><td><span class="num muted">${esc(l.code)}</span> ${esc(l.name_ar)}</td><td class="amt num">${l.debit ? money(l.debit) : ''}</td><td class="amt num">${l.credit ? money(l.credit) : ''}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td>المجموع</td><td class="amt num">${money(d.journal.reduce((a, l) => a + Number(l.debit), 0))}</td><td class="amt num">${money(d.journal.reduce((a, l) => a + Number(l.credit), 0))}</td></tr></tfoot></table></div></section>
      <section class="card"><h3 style="margin-bottom:8px">الدفعات</h3>${d.payments.length ? `<div class="tbl-wrap"><table><thead><tr><th>السند</th><th>التاريخ</th><th>الطريقة</th><th class="amt">المبلغ</th></tr></thead><tbody>
        ${d.payments.map(a => `<tr><td class="num">${esc(a.payment?.number)}</td><td class="num">${esc(a.payment?.pay_date)}</td><td>${esc(METHOD[a.payment?.method] || '')}</td><td class="amt num">${money(a.amount)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">لم تُسجَّل دفعات بعد.</p>'}
        ${d.related?.length ? relatedCard(d) : ''}<p class="note" style="margin-top:12px">الربط المباشر مع منصة فاتورة (زاتكا — المرحلة الثانية) يأتي في مرحلة لاحقة. رمز QR الحالي بصيغة المرحلة الأولى.</p></section></div>`;
  wireInvoiceActions(d);
}

function wireInvoiceActions(d) { if ($('#mkcn')) $('#mkcn').onclick = async e => { e.target.disabled = true;
  try { const nid = await api.convertDocument(d.id, 'credit_note'); toast('أُنشئت مسودة إشعار دائن — عدّل الكميات المرتجعة ثم رحّلها'); location.hash = '#/credit-notes/' + nid + '/edit'; } catch (x) { fail(x); e.target.disabled = false; } }; }
// ---------- customers ----------
function partyDrawer(p, after, side = 'customer') {
  p = p || {}; const sup = side === 'supplier';
  drawer(p.id ? (sup ? 'تعديل مورد' : 'تعديل عميل') : (sup ? 'مورد جديد' : 'عميل جديد'), `
    ${field('name', 'الاسم', { req: true, value: p.name })}
    ${select('kind', 'النوع', sup ? [['supplier', 'مورد'], ['both', 'مورد وعميل']] : [['customer', 'عميل'], ['both', 'عميل ومورد']], p.kind || side)}
    <div class="form-grid">${field('vat_number', 'الرقم الضريبي', { value: p.vat_number, help: sup ? 'مطلوب لخصم ضريبة المدخلات' : 'مطلوب للفاتورة الضريبية', attrs: 'inputmode="numeric" dir="ltr" maxlength="15"' })}${field('cr_number', 'السجل التجاري', { value: p.cr_number, attrs: 'inputmode="numeric" dir="ltr"' })}</div>
    <fieldset class="form-grid"><legend class="full">العنوان الوطني</legend>${field('city', 'المدينة', { value: p.city })}${field('district', 'الحي', { value: p.district })}${field('street', 'الشارع', { value: p.street })}${field('building_no', 'رقم المبنى', { value: p.building_no, attrs: 'inputmode="numeric" dir="ltr" maxlength="4"' })}${field('postal_code', 'الرمز البريدي', { value: p.postal_code, attrs: 'inputmode="numeric" dir="ltr" maxlength="5"' })}</fieldset>
    <div class="form-grid">${field('phone', 'الجوال', { type: 'tel', value: p.phone, attrs: 'dir="ltr"' })}${field('email', 'البريد', { type: 'email', value: p.email, attrs: 'dir="ltr"' })}</div>
    ${sup ? '' : field('credit_limit', 'حد الائتمان (اتركه فارغاً بلا حد)', { type: 'money', value: p.credit_limit ? money(p.credit_limit) : '', help: 'ينبّهك النظام عند إصدار فاتورة تتجاوز الحد' })}`,
    async f => { ['vat_number', 'cr_number', 'building_no', 'postal_code', 'phone'].forEach(k => f[k] = toLatin(f[k]));
      if (f.vat_number && !VAT_RE.test(f.vat_number)) throw new AppError('الرقم الضريبي 15 رقماً ويبدأ وينتهي بـ 3');
      if (f.email && !/^\S+@\S+\.\S+$/.test(f.email)) throw new AppError('البريد الإلكتروني غير صحيح');
      Object.keys(f).forEach(k => { if (f[k] === '') f[k] = null; });
      if (f.credit_limit != null) { f.credit_limit = toHalalas(f.credit_limit); if (!(f.credit_limit >= 0)) throw new AppError('حد الائتمان غير صحيح'); } const r = await api.saveParty({ ...(p.id ? { id: p.id } : {}), ...f }); await after?.(r); });
}
async function customersView() {
  shell('customers', loading()); const [ps, docs] = await Promise.all([api.listParties('customer'), api.listDocuments(['tax_invoice', 'simplified_invoice'])]);
  const bal = {}; docs.filter(d => d.status === 'posted').forEach(d => bal[d.party_id] = (bal[d.party_id] || 0) + d.total - d.amount_paid);
  $('#main').innerHTML = `<div class="page-head"><h1>العملاء</h1><button class="btn primary" id="newp">${icon('plus')}عميل جديد</button></div>
    ${ps.length ? `<div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>الاسم</th><th>الرقم الضريبي</th><th>المدينة</th><th>الجوال</th><th class="amt">الرصيد المستحق</th><th></th></tr></thead><tbody>
    ${ps.map(p => `<tr class="click" data-href="#/customers/${esc(p.id)}"><td style="white-space:normal"><a class="rowlink" href="#/customers/${esc(p.id)}">${esc(p.name)}</a></td><td class="num m-sub">${esc(p.vat_number || '—')}</td><td class="m-hide">${esc(p.city || '')}</td><td class="num m-hide">${esc(p.phone || '')}</td><td class="amt num">${money(bal[p.id] || 0)}</td><td class="m-hide"><button class="btn ghost sm" data-edit="${esc(p.id)}">تعديل</button></td></tr>`).join('')}</tbody></table></div>`
    : empty('users', 'لم تضف أي عميل بعد', 'أضف عملاءك مع أرقامهم الضريبية وعناوينهم الوطنية لتصدر لهم فواتير ضريبية.', `<button class="btn primary" id="newp2">${icon('plus')}إضافة عميل</button>`)}`;
  const add = () => partyDrawer(null, () => { toast('تمت إضافة العميل'); customersView(); });
  $('#newp').onclick = add; if ($('#newp2')) $('#newp2').onclick = add;
  $$('[data-edit]').forEach(b => b.onclick = () => partyDrawer(ps.find(p => p.id === b.dataset.edit), () => { toast('تم الحفظ'); customersView(); }));
}
async function customerView(id) {
  shell('customers', loading()); const ps = await api.listParties(); const p = ps.find(x => x.id === id); if (!p) throw new AppError('العميل غير موجود');
  const rows = await api.partyStatement(id), bal = rows.at(-1)?.balance || 0;
  $('#main').innerHTML = `<a class="crumb" href="#/customers">${icon('chev')} العملاء</a><div class="page-head"><h1>${esc(p.name)}</h1><button class="btn secondary" id="ed">تعديل</button>${p.phone && bal > 0 ? `<a class="btn secondary" target="_blank" rel="noopener" href="${waLink(p.phone, `السلام عليكم ${p.name}، نود تذكيركم بأن الرصيد المستحق لدى ${ORG.name_ar} هو ${money(bal)} ر.س. شاكرين تعاونكم.`)}">واتساب تذكير</a>` : ''}${p.email && bal > 0 ? `<a class="btn secondary" href="mailto:${esc(p.email)}?subject=${encodeURIComponent('تذكير بالرصيد المستحق — ' + ORG.name_ar)}&body=${encodeURIComponent(`السلام عليكم ${p.name}،\nنود تذكيركم بأن الرصيد المستحق هو ${money(bal)} ر.س.\nشاكرين تعاونكم.`)}">بريد تذكير</a>` : ''}${api.mode === 'supabase' && can('sales', 'create') ? '<button class="btn secondary" id="portal">رابط بوابة العميل</button>' : ''}<a class="btn primary" href="#/receipts/new?party=${esc(p.id)}">${icon('receipt')}سند قبض</a></div>
    <div class="grid g3" style="margin-bottom:20px"><div class="card stat"><div class="label">الرصيد المستحق</div><div class="val num">${money(bal)}</div>${p.credit_limit != null ? `<div class="xs ${bal > p.credit_limit ? 'down' : 'muted'}">حد الائتمان ${money(p.credit_limit)}${bal > p.credit_limit ? ' — متجاوز!' : ` · متاح ${money(p.credit_limit - bal)}`}</div>` : ''}</div>
    <div class="card" style="grid-column:span 2"><dl class="kv"><dt>الرقم الضريبي</dt><dd class="num">${esc(p.vat_number || '—')}</dd><dt>العنوان</dt><dd>${esc([p.building_no, p.street, p.district, p.city, p.postal_code].filter(Boolean).join('، ') || '—')}</dd><dt>التواصل</dt><dd class="num">${esc([p.phone, p.email].filter(Boolean).join(' · ') || '—')}</dd></dl></div></div>
    <h2 style="margin-bottom:12px">كشف الحساب</h2>
    ${rows.length ? `<div class="tbl-wrap"><table><thead><tr><th>التاريخ</th><th>المستند</th><th>البيان</th><th class="amt">مدين</th><th class="amt">دائن</th><th class="amt">الرصيد</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td class="num">${esc(r.date)}</td><td class="num">${r.link ? `<a href="${esc(r.link)}">${esc(r.ref)}</a>` : esc(r.ref)}</td><td>${esc(r.what)}</td><td class="amt num">${r.debit ? money(r.debit) : ''}</td><td class="amt num">${r.credit ? money(r.credit) : ''}</td><td class="amt num">${money(r.balance)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">لا توجد حركات بعد.</p>'}`;
  $('#ed').onclick = () => partyDrawer(p, () => { toast('تم الحفظ'); customerView(id); });
  if ($('#portal')) $('#portal').onclick = () => portalShare(p);
}

// ---------- items ----------
function itemDrawer(it, after) {
  it = it || { kind: 'product', tax_category: 'S', track_stock: true, unit: 'حبة' };
  const f = drawer(it.id ? 'تعديل صنف' : 'صنف أو خدمة جديدة', `
    ${select('kind', 'النوع', [['product', 'سلعة / منتج تام (لها مخزون)'], ['raw_material', 'مادة خام (لها مخزون)'], ['service', 'خدمة']], it.kind)}
    ${field('name_ar', 'الاسم', { req: true, value: it.name_ar })}
    <div class="form-grid">${field('sku', 'رمز الصنف', { value: it.sku, attrs: 'dir="ltr"' })}${field('barcode', 'الباركود', { value: it.barcode, attrs: 'dir="ltr" inputmode="numeric"' })}
    ${field('unit', 'الوحدة', { value: it.unit, help: 'حبة، متر، طن، ساعة…' })}${field('sale_price', 'سعر البيع قبل الضريبة', { type: 'money', value: it.sale_price != null ? money(it.sale_price) : '', req: true })}</div>
    ${select('tax_category', 'الضريبة', Object.entries(TAXCAT), it.tax_category)}
    <div id="exw" ${['Z', 'E'].includes(it.tax_category) ? '' : 'hidden'}>${field('exemption_reason', 'سبب الإعفاء / النسبة الصفرية', { value: it.exemption_reason, help: 'يُطلب من زاتكا، مثل: تصدير سلع خارج المملكة' })}</div>
    <div id="cw" ${it.kind === 'service' ? 'hidden' : ''}>${field('avg_cost', 'تكلفة الوحدة', { type: 'money', value: it.avg_cost ? money(it.avg_cost) : '', help: 'تُستخدم لحساب تكلفة المبيعات، وتُحدَّث تلقائياً بمتوسط التكلفة من فواتير الشراء والتصنيع.' })}</div>`,
    async v => { const price = toHalalas(v.sale_price); if (!Number.isFinite(price) || price < 0 || v.sale_price === '') throw new AppError('سعر البيع غير صحيح');
      const cost = v.avg_cost ? toHalalas(v.avg_cost) : 0; if (!Number.isFinite(cost) || cost < 0) throw new AppError('التكلفة غير صحيحة');
      const r = await api.saveItem({ ...(it.id ? { id: it.id } : {}), kind: v.kind, name_ar: v.name_ar.trim(), sku: v.sku || null, barcode: toLatin(v.barcode) || null, unit: v.unit || 'حبة',
        sale_price: price, tax_category: v.tax_category, vat_rate: v.tax_category === 'S' ? 15 : 0, exemption_reason: v.exemption_reason || null, track_stock: v.kind !== 'service', avg_cost: v.kind !== 'service' ? cost : 0 });
      await after?.(r); });
  $('#f-tax_category', f).addEventListener('change', e => $('#exw', f).hidden = !['Z', 'E'].includes(e.target.value));
  $('#f-kind', f).addEventListener('change', e => $('#cw', f).hidden = e.target.value === 'service');
}
async function itemsView() {
  shell('items', loading()); const items = await api.listItems();
  $('#main').innerHTML = `<div class="page-head"><h1>الأصناف والخدمات</h1><button class="btn primary" id="newi">${icon('plus')}صنف جديد</button></div>
  ${items.length ? `<div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>الاسم</th><th>النوع</th><th>الرمز</th><th class="amt">سعر البيع</th><th class="amt">التكلفة</th><th class="amt">الكمية</th><th>الضريبة</th><th></th></tr></thead><tbody>
    ${items.map(i => `<tr><td style="white-space:normal"><b>${esc(i.name_ar)}</b></td><td class="m-sub">${i.kind === 'service' ? 'خدمة' : i.kind === 'raw_material' ? 'مادة خام' : 'سلعة'}</td><td class="num m-hide">${esc(i.sku || '')}</td><td class="amt num">${money(i.sale_price)}</td><td class="amt num m-hide">${i.track_stock ? money(i.avg_cost) : '—'}</td>
      <td class="amt num m-sub">${i.track_stock ? `<span class="${i.on_hand < 0 ? 'down' : ''}">${esc(Number(i.on_hand))} ${esc(i.unit)}</span>` : '—'}</td><td class="m-hide">${esc(TAXCAT[i.tax_category])}</td><td class="m-hide"><button class="btn ghost sm" data-edit="${esc(i.id)}">تعديل</button></td></tr>`).join('')}</tbody></table></div>
    ${items.some(i => i.on_hand < 0) ? `<p class="note warn" style="margin-top:12px">بعض الأصناف رصيدها بالسالب — ${api.mode === 'supabase' ? 'سجّل فواتير الشراء أو رصيداً افتتاحياً من «حركات المخزون».' : 'فواتير الشراء تعمل عند الربط بالخادم.'}</p>` : ''}`
  : empty('box', 'لا توجد أصناف بعد', 'أضف السلع والخدمات التي تبيعها مع أسعارها ونوع ضريبتها.', `<button class="btn primary" id="newi2">${icon('plus')}إضافة صنف</button>`)}`;
  const add = () => itemDrawer(null, () => { toast('تمت إضافة الصنف'); itemsView(); });
  $('#newi').onclick = add; if ($('#newi2')) $('#newi2').onclick = add;
  $$('[data-edit]').forEach(b => b.onclick = () => itemDrawer(items.find(i => i.id === b.dataset.edit), () => { toast('تم الحفظ'); itemsView(); }));
}

// ---------- receipts ----------
async function receiptsView() {
  shell('receipts', loading()); const pays = await api.listPayments();
  $('#main').innerHTML = `<div class="page-head"><h1>سندات القبض</h1><a class="btn primary" href="#/receipts/new">${icon('plus')}سند قبض</a></div>
  ${pays.length ? `<div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>الرقم</th><th>العميل</th><th>التاريخ</th><th>الطريقة</th><th class="amt">المبلغ</th></tr></thead><tbody>
    ${pays.map(p => `<tr><td class="num"><b>${esc(p.number)}</b></td><td class="m-sub" style="white-space:normal">${esc(p.party_name)}</td><td class="num m-hide">${esc(p.pay_date)}</td><td class="m-hide">${esc(METHOD[p.method] || p.method)}</td><td class="amt num">${money(p.amount)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="4">الإجمالي</td><td class="amt num">${money(pays.reduce((a, p) => a + Number(p.amount), 0))}</td></tr></tfoot></table></div>`
  : empty('receipt', 'لا توجد سندات قبض', 'سجّل ما تستلمه من عملائك، ويُخصم تلقائياً من فواتيرهم.', `<a class="btn primary" href="#/receipts/new">${icon('plus')}سند قبض</a>`)}`;
}
async function receiptNewView(qs) {
  shell('receipts', loading());
  const [ps, docs] = await Promise.all([api.listParties('customer'), api.listDocuments(['tax_invoice', 'simplified_invoice'])]);
  const openDocs = docs.filter(d => d.status === 'posted' && d.payment_status !== 'paid');
  let party = qs.get('party') || '', alloc = {};
  $('#main').innerHTML = `<a class="crumb" href="#/receipts">${icon('chev')} سندات القبض</a><div class="page-head"><h1>سند قبض جديد</h1></div>
    <form class="card" id="rf" novalidate style="max-width:var(--l-form-max)">
      <div class="form-grid"><div class="field"><label for="f-party">العميل</label><select class="input" id="f-party" name="party_id"><option value="">— عميل نقدي —</option>${ps.map(p => `<option value="${esc(p.id)}"${p.id === party ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      ${field('pay_date', 'التاريخ', { type: 'date', value: riyadhToday(), req: true })}
      ${field('amount', 'المبلغ المستلم', { type: 'money', req: true })}
      ${select('method', 'طريقة الاستلام', Object.entries(METHOD), 'bank_transfer')}
      ${field('reference', 'المرجع', { help: 'رقم الحوالة أو الإيصال (اختياري)', cls: 'full' })}</div>
      <h3 style="margin:20px 0 8px">توزيع المبلغ على الفواتير</h3><div id="allocs"></div>
      <p class="help err" id="rerr" role="alert"></p>
      <div class="row" style="justify-content:flex-end;margin-top:16px"><a class="btn ghost" href="#/receipts">إلغاء</a><button class="btn primary" type="submit">حفظ وترحيل السند</button></div></form>`;
  const pre = qs.get('doc');
  const drawAlloc = () => {
    const mine = openDocs.filter(d => (d.party_id || '') === party);
    $('#allocs').innerHTML = mine.length ? `<div class="tbl-wrap"><table class="alloc"><thead><tr><th>الفاتورة</th><th>التاريخ</th><th class="amt">المتبقي</th><th style="width:160px">المبلغ المخصص</th></tr></thead><tbody>
      ${mine.map(d => `<tr><td class="num">${esc(d.number)}</td><td class="num">${esc(d.issue_date)}</td><td class="amt num">${money(d.total - d.amount_paid)}</td><td><input class="input num" data-doc="${esc(d.id)}" data-max="${d.total - d.amount_paid}" inputmode="decimal" value="${alloc[d.id] ? money(alloc[d.id]) : ''}" aria-label="المبلغ المخصص للفاتورة ${esc(d.number)}"></td></tr>`).join('')}</tbody></table></div>
      <p class="xs muted" id="asum" style="margin-top:6px"></p>` : `<p class="muted">${party ? 'لا توجد فواتير مفتوحة لهذا العميل — سيُسجَّل المبلغ دفعة على الحساب.' : 'اختر العميل لعرض فواتيره المفتوحة.'}</p>`;
    sumAlloc();
  };
  const sumAlloc = () => { const a = toHalalas($('#f-amount').value || 0), s = Object.values(alloc).reduce((x, y) => x + y, 0); const el = $('#asum');
    if (el) el.textContent = `الموزَّع ${money(s)} من ${money(Number.isFinite(a) ? a : 0)}${a > s ? ` — يبقى ${money(a - s)} دفعة على الحساب` : ''}`; };
  const autoAlloc = () => { alloc = {}; let a = toHalalas($('#f-amount').value || 0); if (!Number.isFinite(a)) a = 0;
    const mine = openDocs.filter(d => (d.party_id || '') === party).sort((x, y) => x.issue_date.localeCompare(y.issue_date));
    if (pre) mine.sort((x, y) => (y.id === pre) - (x.id === pre));
    mine.forEach(d => { const take = Math.min(a, d.total - d.amount_paid); if (take > 0) { alloc[d.id] = take; a -= take; } }); drawAlloc(); };
  $('#f-party').onchange = e => { party = e.target.value; autoAlloc(); };
  $('#f-amount').oninput = autoAlloc;
  $('#allocs').addEventListener('input', e => { const i = e.target.closest('[data-doc]'); if (!i) return; const v = toHalalas(i.value || 0); alloc[i.dataset.doc] = Number.isFinite(v) ? v : 0; sumAlloc(); });
  if (pre) { const d = openDocs.find(x => x.id === pre); if (d) { $('#f-amount').value = money(d.total - d.amount_paid); autoAlloc(); } } else drawAlloc();
  $('#rf').addEventListener('submit', async e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)), err = $('#rerr'); err.textContent = '';
    const amount = toHalalas(f.amount); if (!(amount > 0)) return err.textContent = 'أدخل المبلغ المستلم';
    const allocations = Object.entries(alloc).filter(([, v]) => v > 0).map(([document_id, amount]) => ({ document_id, amount }));
    for (const a of allocations) { const d = openDocs.find(x => x.id === a.document_id); if (a.amount > d.total - d.amount_paid) return err.textContent = `المبلغ المخصص يتجاوز المتبقي على ${d.number}`; }
    if (allocations.reduce((x, a) => x + a.amount, 0) > amount) return err.textContent = 'المبالغ الموزعة أكبر من المبلغ المستلم';
    if (!f.party_id && amount > allocations.reduce((x, a) => x + a.amount, 0)) return err.textContent = 'اختر العميل، أو خصّص المبلغ كاملاً على فواتير';
    $('[type=submit]', e.target).disabled = true;
    try { await api.createReceipt({ party_id: f.party_id || null, pay_date: f.pay_date, amount, method: f.method, reference: f.reference, allocations }); toast('تم ترحيل سند القبض');
      location.hash = pre ? '#/invoices/' + pre : '#/receipts'; } catch (x) { err.textContent = x.message; $('[type=submit]', e.target).disabled = false; } });
}

// ---------- accounts & trial balance ----------
async function accountsView() {
  shell('accounts', loading()); const [accs, tb] = await Promise.all([api.listAccounts(), api.trialBalance()]);
  const bal = Object.fromEntries(tb.map(r => [r.account_id, Number(r.balance)])), kids = {};
  accs.forEach(a => (kids[a.parent_id || 'root'] ||= []).push(a));
  const roll = a => (bal[a.id] || 0) + (kids[a.id] || []).reduce((s, k) => s + roll(k), 0);
  const sign = a => ['asset', 'expense'].includes(a.type) ? 1 : -1;
  const rows = []; const walk = (a, d) => { rows.push({ a, d }); (kids[a.id] || []).forEach(k => walk(k, d + 1)); }; (kids.root || []).forEach(a => walk(a, 0)); accs.sorted = rows.map(r => r.a);
  $('#main').innerHTML = `<div class="page-head"><h1>شجرة الحسابات</h1><span class="muted">${accs.length} حساباً</span></div>
    <p class="muted" style="margin:-8px 0 16px">الحسابات التي عليها قفل يستخدمها النظام في القيود التلقائية ولا تُحذف.</p>
    <div class="tbl-wrap"><table class="tree-tbl"><thead><tr><th>الحساب</th><th>الرمز</th><th class="amt">الرصيد</th></tr></thead><tbody>
    ${rows.map(({ a, d }) => `<tr class="${a.is_postable ? '' : 'grp'}" style="--d:${d}"><td>${esc(a.name_ar)} ${a.system_key ? `<span class="muted" title="حساب نظام">${icon('lock')}</span>` : ''}</td><td class="num muted">${esc(a.code)}</td><td class="amt num">${roll(a) ? money(roll(a) * sign(a)) : '—'}</td></tr>`).join('')}</tbody></table></div>`;
  enhanceAccounts(accs);
}
async function trialBalanceView() {
  shell('trial-balance', loading()); const tb = await api.trialBalance();
  const D = tb.reduce((a, r) => a + Number(r.debit), 0), C = tb.reduce((a, r) => a + Number(r.credit), 0);
  $('#main').innerHTML = `<div class="page-head"><h1>ميزان المراجعة</h1>${tb.length ? `<button class="btn secondary" id="csv">${icon('down')}تصدير CSV</button>` : ''}</div>
  ${tb.length ? `<div class="ok-line" style="margin-bottom:12px">${D === C ? badge(['متوازن ✓', 'b-ok']) : badge(['غير متوازن — راجع القيود', 'b-bad'])}<span class="muted xs">حتى تاريخ ${esc(riyadhToday())}</span></div>
    <div class="tbl-wrap"><table><thead><tr><th>الرمز</th><th>الحساب</th><th class="amt">مدين</th><th class="amt">دائن</th><th class="amt">رصيد مدين</th><th class="amt">رصيد دائن</th></tr></thead><tbody>
    ${tb.map(r => { const b = Number(r.balance); return `<tr><td class="num">${esc(r.code)}</td><td>${esc(r.name_ar)}</td><td class="amt num">${money(r.debit)}</td><td class="amt num">${money(r.credit)}</td><td class="amt num">${b > 0 ? money(b) : ''}</td><td class="amt num">${b < 0 ? money(-b) : ''}</td></tr>`; }).join('')}</tbody>
    <tfoot><tr><td colspan="2">المجموع</td><td class="amt num">${money(D)}</td><td class="amt num">${money(C)}</td><td class="amt num">${money(tb.reduce((a, r) => a + Math.max(Number(r.balance), 0), 0))}</td><td class="amt num">${money(tb.reduce((a, r) => a + Math.max(-Number(r.balance), 0), 0))}</td></tr></tfoot></table></div>`
  : empty('chart', 'لا توجد حركات بعد', 'يظهر الميزان بعد إصدار أول فاتورة أو سند.', `<a class="btn primary" href="#/invoices/new">${icon('plus')}فاتورة جديدة</a>`)}`;
  if ($('#csv')) $('#csv').onclick = () => { const lines = [['code', 'account', 'debit', 'credit', 'balance'], ...tb.map(r => [r.code, r.name_ar, (r.debit / 100).toFixed(2), (r.credit / 100).toFixed(2), (r.balance / 100).toFixed(2)])];
    const csv = '﻿' + lines.map(l => l.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `trial-balance-${riyadhToday()}.csv`; a.click(); };
}

// ---------- settings ----------
async function settingsView() {
  shell('settings', loading()); const o = ORG;
  $('#main').innerHTML = `<div class="page-head"><h1>الإعدادات</h1></div>
    <form class="card grid" id="sf" style="gap:20px;max-width:var(--l-form-max)" novalidate ${can('settings', 'create') ? '' : 'inert'}>
      <fieldset><legend>الشعار</legend><div class="row"><div class="logo-prev" id="lp">${o.logo_path ? `<img src="${esc(o.logo_path)}" alt="الشعار الحالي">` : icon('box')}</div>
        <div><input type="file" id="logo" accept="image/png,image/jpeg,image/svg+xml" aria-describedby="lh"><p class="help" id="lh">PNG أو JPG، حتى 300 كيلوبايت. يظهر على الفواتير وأعلى القائمة.</p>${o.logo_path ? '<button type="button" class="btn ghost sm" id="rmlogo">إزالة الشعار</button>' : ''}</div></div></fieldset>
      ${companyFields(o)}
      ${field('invoice_footer', 'نص أسفل الفاتورة', { value: o.invoice_footer || '', help: 'مثل: الحساب البنكي، الشروط والأحكام' })}
      <p class="help err" id="serr" role="alert"></p><div class="row" style="justify-content:flex-end"><button class="btn primary" type="submit">حفظ</button></div></form>
    <section class="card" style="max-width:var(--l-form-max);margin-top:24px"><h2>مكان حفظ البيانات</h2>
      <p class="muted">${api.mode === 'local' ? 'تعمل الآن في <b>وضع التجربة</b>: البيانات في هذا المتصفح فقط، ولا تنتقل لجهاز آخر.' : `متصل بالخادم (Supabase) — <span dir="ltr">${esc(cfg.url.replace('https://', ''))}</span>. بياناتك محفوظة على الخادم وتظهر من أي جهاز.`}</p>
      ${BAKED && !LOCAL_CFG ? '' : `<form id="bf" class="form-grid" novalidate>${field('url', 'عنوان مشروع Supabase', { value: cfg?.url || '', attrs: 'dir="ltr" placeholder="https://xxxx.supabase.co"' })}${field('key', 'المفتاح العام (anon key)', { value: cfg?.key || '', attrs: 'dir="ltr"' })}
      <div class="full row"><button class="btn secondary" type="submit">حفظ والاتصال</button>${LOCAL_CFG ? `<button type="button" class="btn ghost" id="bclear">${BAKED ? 'إلغاء الإعداد المحلي' : 'العودة لوضع التجربة'}</button>` : ''}</div></form>`}
      ${api.mode === 'local' ? `<hr style="border:0;border-top:1px solid var(--c-border);margin:20px 0"><h3>بيانات تجريبية</h3><p class="muted">املأ النظام بعملاء وأصناف وفواتير لكرافت لاند لتجربته بسرعة.</p>
      <div class="row"><button class="btn secondary" id="demo">تعبئة بيانات تجريبية</button><button class="btn ghost" id="wipe" style="color:var(--c-danger)">مسح كل البيانات</button></div>` : ''}</section>
    ${api.mode === 'supabase' && can('settings', 'create') ? `<section class="card" style="max-width:var(--l-form-max);margin-top:24px"><h2>المخزون</h2>
      <label class="row" style="gap:8px"><input type="checkbox" id="negstock" ${o.allow_negative_stock ? 'checked' : ''}> السماح بالبيع والصرف بأكثر من الرصيد المتوفر</label>
      <p class="help">عند إلغائه يرفض النظام أي فاتورة أو صرف أو أمر تصنيع يجعل رصيد صنف في مستودع بالسالب.</p></section>` : ''}
    ${api.mode === 'supabase' && can('users') ? `<section class="card" style="max-width:var(--l-form-max);margin-top:24px"><h2>المستخدمون والصلاحيات</h2><p class="muted">أضف المستخدمين وحدد لكل دور ما يراه وينشئه ويعتمده.</p><a class="btn secondary" href="#/users">${icon('lock')}إدارة المستخدمين والأدوار</a></section>` : ''}`;
  if ($('#negstock')) $('#negstock').onchange = async e => { try { ORG = await api.updateOrg({ allow_negative_stock: e.target.checked }); toast('تم الحفظ'); } catch (x) { fail(x); e.target.checked = !e.target.checked; } };
  let logo = o.logo_path;
  $('#logo').onchange = e => { const file = e.target.files[0]; if (!file) return; if (file.size > 300 * 1024) { toast('الملف أكبر من 300 كيلوبايت', 'bad'); e.target.value = ''; return; }
    const r = new FileReader(); r.onload = () => { logo = r.result; $('#lp').innerHTML = `<img src="${esc(logo)}" alt="الشعار الجديد">`; }; r.readAsDataURL(file); };
  if ($('#rmlogo')) $('#rmlogo').onclick = () => { logo = null; $('#lp').innerHTML = icon('box'); };
  $('#sf').addEventListener('submit', async e => { e.preventDefault(); $('#serr').textContent = '';
    try { const f = cleanCompany(Object.fromEntries(new FormData(e.target))); 
      ORG = await api.updateOrg({ ...f, logo_path: logo }); toast('تم حفظ الإعدادات'); settingsView(); } catch (x) { $('#serr').textContent = x.message; } });
  if ($('#bf')) $('#bf').addEventListener('submit', e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(f.url.trim()) || f.key.trim().length < 30) { toast('تحقق من العنوان والمفتاح', 'bad'); return; }
    localStorage.setItem('daftar-backend', JSON.stringify({ url: f.url.trim().replace(/\/$/, ''), key: f.key.trim() })); location.reload(); });
  if ($('#bclear')) $('#bclear').onclick = () => { localStorage.removeItem('daftar-backend'); location.reload(); };
  if ($('#demo')) $('#demo').onclick = async () => { try { await seedDemo(); toast('تمت تعبئة البيانات التجريبية'); location.hash = '#/dashboard'; } catch (x) { fail(x); } };
  if ($('#wipe')) $('#wipe').onclick = async () => { const b = $('#wipe'); if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = 'متأكد؟ اضغط مرة أخرى — يُحذف كل شيء'; return; } await api.resetAll(); location.hash = '#/signup'; location.reload(); };
}
async function seedDemo() {
  const havePs = await api.listParties(), haveIs = await api.listItems();
  const party = async p => havePs.find(x => x.vat_number && x.vat_number === p.vat_number) || api.saveParty(p);
  const item = async i => haveIs.find(x => x.sku === i.sku) || api.saveItem(i);
  const c1 = await party({ name: 'مؤسسة الواحة للمقاولات', kind: 'customer', vat_number: '311111111111113', city: 'جدة', district: 'الصناعية', street: 'شارع الملك فهد', building_no: '4410', postal_code: '23511', phone: '0550000001' });
  const c2 = await party({ name: 'شركة الأفق للتعدين', kind: 'customer', vat_number: '322222222222223', city: 'الرياض', district: 'السلي', street: 'طريق الخرج', building_no: '7788', postal_code: '14322', phone: '0550000002' });
  const i1 = await item({ kind: 'product', name_ar: 'كرفان مكتبي 6×3 م', sku: 'CRV-6x3', unit: 'حبة', sale_price: 5000000, tax_category: 'S', vat_rate: 15, track_stock: true, avg_cost: 3200000 });
  const i2 = await item({ kind: 'product', name_ar: 'هنجر حديد 30×20 م', sku: 'HNG-30x20', unit: 'حبة', sale_price: 16000000, tax_category: 'S', vat_rate: 15, track_stock: true, avg_cost: 11000000 });
  const i3 = await item({ kind: 'service', name_ar: 'نقل وتركيب في الموقع', sku: 'SRV-INST', unit: 'خدمة', sale_price: 350000, tax_category: 'S', vat_rate: 15, track_stock: false, avg_cost: 0 });
  const L = (it, qty, disc = 0) => ({ item_id: it.id, description: it.name_ar, qty, unit_price: it.sale_price, discount: disc, tax_category: 'S', vat_rate: 15, line_net: 0, line_vat: 0 });
  const today = riyadhToday(), back = n => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date(Date.now() - n * 864e5));
  const d1 = await api.saveDraft({ kind: 'tax_invoice', party_id: c1.id, issue_date: back(12), issue_time: '10:15:00', due_date: back(2) }, [L(i1, 2), L(i3, 2)]); await api.postSalesInvoice(d1);
  const d2 = await api.saveDraft({ kind: 'tax_invoice', party_id: c2.id, issue_date: back(5), issue_time: '12:40:00', due_date: back(-25) }, [L(i2, 1, 500000), L(i3, 1)]); await api.postSalesInvoice(d2);
  const d3 = await api.saveDraft({ kind: 'simplified_invoice', party_id: null, issue_date: today, issue_time: riyadhTime() }, [L(i3, 1)]); await api.postSalesInvoice(d3);
  const doc1 = await api.getDocument(d1); await api.createReceipt({ party_id: c1.id, pay_date: back(3), amount: 6000000, method: 'bank_transfer', reference: 'TRX-88120', allocations: [{ document_id: d1, amount: 6000000 }] });
  const doc3 = await api.getDocument(d3); await api.createReceipt({ party_id: null, pay_date: today, amount: doc3.total, method: 'cash', allocations: [{ document_id: d3, amount: doc3.total }] });
  void doc1;
}

// @@OPS@@

// ---------- router ----------
const stub = (key, title, what) => () => { shell(key, `<div class="page-head"><h1>${esc(title)}</h1></div>${empty('box', 'قيد البناء', what)}`); };
const ROUTES = [
  [/^#\/dashboard$/, dashboardView], [/^#\/invoices$/, invoicesView], [/^#\/invoices\/new$/, () => invoiceEditView(null)],
  [/^#\/invoices\/([\w-]+)\/edit$/, m => invoiceEditView(m[1])], [/^#\/invoices\/([\w-]+)$/, m => invoiceView(m[1])],
  [/^#\/customers$/, customersView], [/^#\/customers\/([\w-]+)$/, m => customerView(m[1])], [/^#\/items$/, itemsView],
  [/^#\/receipts$/, receiptsView], [/^#\/receipts\/new(\?.*)?$/, m => receiptNewView(new URLSearchParams((m[1] || '').slice(1)))],
  [/^#\/accounts$/, accountsView], [/^#\/trial-balance$/, trialBalanceView], [/^#\/settings$/, settingsView],
  ...OPS_ROUTES,
  [/^#\/purchases$/, () => { location.hash = '#/bills'; }], [/^#\/inventory$/, () => { location.hash = '#/warehouses'; }],
  ...POS_ROUTES,
  ...REPORT_ROUTES,
  ...EXT_ROUTES,
  ...EXT2_ROUTES,
  ...EXT3_ROUTES,
];
async function route() {
  const h = location.hash || '#/dashboard';
  $$('.drawer-bg').forEach(x => x.remove());
  try {
    const pm = h.match(PORTAL_RE); if (pm && api.mode === 'supabase') return portalPublicView(pm[1], pm[2]);
    const s = await api.session();
    if (!s) { recovering = false;
      if (h === '#/signup') return authView('signup'); if (h === '#/forgot' && api.mode === 'supabase') return forgotView();
      return authView(h === '#/login' ? 'login' : (LocalAPI.mode === api.mode && !localStorage.getItem('daftar-local-v1')?.includes('"email"') ? 'signup' : 'login')); }
    if (api.mode === 'supabase' && (recovering || h === '#/reset')) { if (location.hash !== '#/reset') { location.hash = '#/reset'; return; } return resetView(); }
    if (['#/login', '#/signup', '#/forgot'].includes(h)) { location.hash = '#/dashboard'; return; }
    if (!ORG) { $('#app').innerHTML = loading('جارٍ فتح حسابك…'); ORG = await api.currentOrg(); }
    if (NEW_ORG) return onboardingView();
    if (!ORG) { if (api.mode === 'supabase' && !(await api.whoami()).is_platform_admin) return noCompanyView(s.user?.email); return onboardingView(); }
    const r = ROUTES.find(([re]) => re.test(h));
    if (!r) { location.hash = '#/dashboard'; return; }
    await r[1](h.match(r[0]));
    $('#side')?.classList.remove('open'); $('#main')?.focus({ preventScroll: true }); window.scrollTo(0, 0);
    document.title = ($('#main h1')?.textContent || 'دفتر') + ' — ' + (ORG?.name_ar || '');
  } catch (e) {
    fail(e);
    if ($('#main')) $('#main').innerHTML = `<div class="card empty">${icon('alert')}<h3 style="margin:12px 0 4px">تعذّر تحميل الصفحة</h3><p class="muted">${esc(e.message)}</p><button class="btn primary" onclick="location.reload()">إعادة المحاولة</button></div>`;
    else $('#app').innerHTML = `<div class="auth"><div class="card empty">${icon('alert')}<h3>تعذّر فتح الحساب</h3><p class="muted">${esc(e.message)}</p><button class="btn primary" onclick="location.reload()">إعادة المحاولة</button></div></div>`;
  }
}
window.addEventListener('hashchange', route);
window.addEventListener('unhandledrejection', e => fail(e.reason));
pickBackend().then(route);
}
