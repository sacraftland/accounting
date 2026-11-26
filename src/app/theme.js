// =====================================================================
// Appearance (per user, synced to the account; company default color by
// whoever may edit settings) and a customizable dashboard.
// Loaded before app.js code runs its first route (inserted after projects.js).
// =====================================================================
const UI_KEY = 'daftar-ui-prefs';
const THEME_DEFAULT = { mode: 'light', sidebar: 'dark', size: 'normal', density: 'comfortable', radius: 'medium', accent: '' };
const ACCENTS = [['#4f6b3a', 'زيتوني'], ['#2563a8', 'أزرق'], ['#13795b', 'زمردي'], ['#8a2c3b', 'عنابي'], ['#8a5a2b', 'بني'], ['#c2571a', 'برتقالي'], ['#5b4b9a', 'بنفسجي'], ['#3d4752', 'فحمي']];
const DASH_WIDGETS = [['approvals', 'بانتظار اعتمادك'], ['kpis', 'المؤشرات الرئيسية'], ['quick', 'اختصارات سريعة'], ['calendar', 'التنبيهات والتقويم'], ['insights', 'الإيرادات والمصروفات'],
  ['projects', 'المشاريع النشطة'], ['top', 'أعلى أرصدة العملاء والموردين'], ['invoices', 'آخر الفواتير']];
const DASH_DEFAULT = { order: DASH_WIDGETS.map(w => w[0]), hidden: ['quick'] };
let UI = (() => { try { return JSON.parse(localStorage.getItem(UI_KEY) || 'null') || {}; } catch { return {}; } })();
const uiTheme = () => ({ ...THEME_DEFAULT, ...(UI.theme || {}) });
const uiDash = () => { const d = { ...DASH_DEFAULT, ...(UI.dash || {}) }; const known = DASH_WIDGETS.map(w => w[0]);
  return { order: [...d.order.filter(k => known.includes(k)), ...known.filter(k => !d.order.includes(k))], hidden: d.hidden.filter(k => known.includes(k)) }; };
async function saveUI(patch) { UI = { ...UI, ...patch }; try { localStorage.setItem(UI_KEY, JSON.stringify(UI)); } catch { /* private mode */ }
  if (api.mode === 'supabase') try { await api.client.auth.updateUser({ data: { ui_prefs: UI } }); } catch { /* offline: kept locally */ } }
async function loadUI() { if (api.mode !== 'supabase') return; try { const u = (await api.client.auth.getUser()).data.user, p = u?.user_metadata?.ui_prefs;
  if (p && typeof p === 'object') { UI = p; localStorage.setItem(UI_KEY, JSON.stringify(UI)); } } catch { /* keep the cached copy */ } }

// ---- color helpers ----
const hex2rgb = h => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return null; const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const rgb2hex = c => '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => { const x = hex2rgb(a), y = hex2rgb(b); return rgb2hex(x.map((v, i) => v + (y[i] - v) * t)); };
const lum = h => { const c = hex2rgb(h).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const safeAccent = (h, bg) => { let c = h; for (let i = 0; i < 12 && contrast(c, bg) < 4.5; i++) c = mix(c, lum(bg) > 0.5 ? '#000000' : '#ffffff', 0.12); return c; };

function applyTheme() {
  const t = uiTheme(), root = document.documentElement, set = (k, v) => root.style.setProperty(k, v);
  const dark = t.mode === 'dark' || (t.mode === 'auto' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = dark ? 'dark' : 'light';
  ['--c-bg', '--c-surface', '--c-surface-2', '--c-border', '--c-border-input', '--c-text', '--c-text-muted', '--c-danger-soft', '--c-success-soft', '--c-warning-soft', '--c-info-soft', '--c-danger', '--c-success', '--c-warning', '--c-info', '--sh-card'].forEach(k => root.style.removeProperty(k));
  if (dark) { [['--c-bg', '#181512'], ['--c-surface', '#221e1a'], ['--c-surface-2', '#2d2823'], ['--c-border', '#3d362f'], ['--c-border-input', '#7d705f'], ['--c-text', '#f1ebe1'], ['--c-text-muted', '#b9ad9c'],
    ['--c-danger', '#f08a7c'], ['--c-success', '#8fd19a'], ['--c-warning', '#f0c46a'], ['--c-info', '#8cc4e6'],
    ['--c-danger-soft', '#3d2420'], ['--c-success-soft', '#21321f'], ['--c-warning-soft', '#3a2f17'], ['--c-info-soft', '#1d2f3a'], ['--sh-card', '0 1px 2px rgba(0,0,0,.4)']].forEach(([k, v]) => set(k, v)); }
  const bg = dark ? '#221e1a' : '#fffdf9', base = hex2rgb(t.accent) ? t.accent : hex2rgb(ORG?.brand_color) ? ORG.brand_color : '#4f6b3a';
  const acc = safeAccent(dark ? mix(base, '#ffffff', 0.25) : base, bg);
  set('--c-accent', acc); set('--c-accent-hover', mix(acc, dark ? '#ffffff' : '#000000', 0.15)); set('--c-accent-soft', mix(acc, bg, dark ? 0.78 : 0.86));
  set('--c-on-accent', contrast(acc, '#ffffff') >= 4.5 ? '#ffffff' : '#1b1711');
  const side = t.sidebar === 'light' ? (dark ? '#221e1a' : '#efe8dc') : t.sidebar === 'accent' ? mix(base, '#000000', 0.45) : (dark ? '#100e0c' : '#2f2a24');
  const sideText = lum(side) > 0.35 ? '#2b241c' : '#f3ece0';
  set('--c-sidebar', side); set('--c-on-sidebar', sideText); set('--c-on-sidebar-muted', mix(sideText, side, 0.35));
  const f = { small: 0.92, normal: 1, large: 1.12, xlarge: 1.25 }[t.size] || 1;
  [['xs', 12, 18], ['sm', 14, 22], ['base', 16, 26], ['lg', 20, 30], ['xl', 28, 38], ['display', 40, 52]].forEach(([k, s, l]) => { set(`--fs-${k}`, Math.round(s * f) + 'px'); set(`--lh-${k}`, Math.round(l * f) + 'px'); });
  const r = { sharp: [2, 4, 6], medium: [6, 10, 16], round: [10, 16, 24] }[t.radius] || [6, 10, 16]; set('--r-sm', r[0] + 'px'); set('--r-md', r[1] + 'px'); set('--r-lg', r[2] + 'px');
  root.dataset.density = t.density;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', side);
}
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (uiTheme().mode === 'auto') applyTheme(); });
applyTheme();

// ---------- appearance page ----------
async function appearanceView() {
  shell('appearance', loading()); await loadUI(); applyTheme();
  const t = uiTheme(), canOrg = api.mode === 'supabase' && can('settings', 'create'), orgColor = hex2rgb(ORG?.brand_color) ? ORG.brand_color : '#4f6b3a';
  const seg = (name, label, opts, val) => `<div class="field"><span class="lbl">${esc(label)}</span><div class="seg" role="radiogroup" aria-label="${esc(label)}">${opts.map(([v, tx]) => `<label class="${v === val ? 'on' : ''}"><input type="radio" name="${name}" value="${v}" ${v === val ? 'checked' : ''}>${tx}</label>`).join('')}</div></div>`;
  $('#main').innerHTML = `<div class="page-head"><h1>المظهر</h1><button class="btn ghost" id="aprst">استعادة الافتراضي</button></div>
    <p class="muted" style="margin:-8px 0 16px">خصّص شكل النظام لك — يُحفظ على حسابك ويظهر على كل أجهزتك. التغيير يظهر فوراً.</p>
    <div class="grid g2" style="align-items:start"><form class="card grid" id="apf" style="gap:18px" novalidate>
      <div class="field"><span class="lbl">لون الواجهة</span><div class="swatches">${[['', 'لون الشركة', orgColor], ...ACCENTS.map(([c, n]) => [c, n, c])].map(([v, n, c]) => `<label class="sw ${(t.accent || '') === v ? 'on' : ''}" title="${esc(n)}"><input type="radio" name="accent" value="${v}" ${(t.accent || '') === v ? 'checked' : ''}><i style="background:${c}"></i><span class="xs">${esc(n)}</span></label>`).join('')}
        <label class="sw ${t.accent && !ACCENTS.some(a => a[0] === t.accent) ? 'on' : ''}" title="لون مخصص"><input type="radio" name="accent" value="custom" ${t.accent && !ACCENTS.some(a => a[0] === t.accent) ? 'checked' : ''}><input type="color" id="apcol" value="${esc(hex2rgb(t.accent) ? t.accent : orgColor)}" aria-label="لون مخصص"><span class="xs">مخصص</span></label></div>
        <span class="help">يُعدَّل اللون تلقائياً إن كان فاتحاً جداً ليبقى النص مقروءاً.</span></div>
      ${seg('mode', 'الوضع', [['light', '☀ فاتح'], ['dark', '☾ داكن'], ['auto', 'حسب الجهاز']], t.mode)}
      ${seg('sidebar', 'القائمة الجانبية', [['dark', 'داكنة'], ['light', 'فاتحة'], ['accent', 'بلون الواجهة']], t.sidebar)}
      ${seg('size', 'حجم الخط', [['small', 'صغير'], ['normal', 'عادي'], ['large', 'كبير'], ['xlarge', 'كبير جداً']], t.size)}
      ${seg('density', 'المسافات', [['comfortable', 'مريحة'], ['compact', 'مضغوطة']], t.density)}
      ${seg('radius', 'الحواف', [['sharp', 'حادة'], ['medium', 'متوسطة'], ['round', 'دائرية']], t.radius)}
      ${canOrg ? `<div class="note"><b>لون الشركة الافتراضي</b> — يراه كل المستخدمين الذين لم يختاروا لوناً لأنفسهم، ويظهر على الفواتير المطبوعة.
        <div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap"><input type="color" id="orgcol" value="${esc(orgColor)}" aria-label="لون الشركة"><button type="button" class="btn secondary sm" id="orgsave">اعتماده للشركة</button></div></div>` : ''}
      <p class="xs muted" id="apsaved" role="status"></p></form>
      <section class="card ap-prev" aria-label="معاينة"><h3 style="margin-bottom:12px">معاينة</h3>
        <div class="grid g2" style="gap:10px;margin-bottom:12px"><div class="card stat"><div class="label">مبيعات هذا الشهر</div><div class="val num">48,500.00</div><div class="xs muted">12 فاتورة</div></div><div class="card stat"><div class="label">الربح</div><div class="val num">9,120.00</div></div></div>
        <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:12px"><button type="button" class="btn primary">${icon('plus')}فاتورة جديدة</button><button type="button" class="btn secondary">سند قبض</button>${badge(['مدفوعة', 'b-ok'])}${badge(['متأخرة', 'b-bad'])}${badge(['مسودة', 'b-draft'])}</div>
        <div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>الرقم</th><th>العميل</th><th class="amt">الإجمالي</th></tr></thead><tbody><tr><td class="num"><a href="#/appearance">INV-00012</a></td><td>مؤسسة البر</td><td class="amt num">11,500.00</td></tr><tr><td class="num"><a href="#/appearance">INV-00011</a></td><td>عميل نقدي</td><td class="amt num">2,300.00</td></tr></tbody></table></div>
        <div class="field" style="margin-top:12px"><label for="appin">حقل إدخال</label><input class="input" id="appin" placeholder="اكتب هنا…"></div></section></div>`;
  const collect = () => { const f = new FormData($('#apf')); let accent = f.get('accent'); if (accent === 'custom') accent = $('#apcol').value;
    return { mode: f.get('mode'), sidebar: f.get('sidebar'), size: f.get('size'), density: f.get('density'), radius: f.get('radius'), accent: accent || '' }; };
  let timer; const live = async () => { $$('#apf .seg label, #apf .sw').forEach(l => l.classList.toggle('on', !!$('input[type=radio]', l)?.checked));
    UI = { ...UI, theme: collect() }; applyTheme(); clearTimeout(timer); timer = setTimeout(async () => { await saveUI({ theme: UI.theme }); $('#apsaved').textContent = 'حُفظ ✓'; }, 400); };
  $('#apf').addEventListener('change', live); $('#apcol').addEventListener('input', () => { $('#apf [name=accent][value=custom]').checked = true; live(); });
  $('#aprst').onclick = async () => { await saveUI({ theme: { ...THEME_DEFAULT } }); applyTheme(); appearanceView(); toast('استُعيد المظهر الافتراضي'); };
  if ($('#orgsave')) $('#orgsave').onclick = async e => { e.target.disabled = true; try { ORG = await api.updateOrg({ brand_color: $('#orgcol').value }); applyTheme(); toast('اعتُمد لون الشركة'); } catch (x) { fail(x); } e.target.disabled = false; };
}

// ---------- dashboard customization ----------
function dashCustomize() {
  let d = uiDash(); const N = Object.fromEntries(DASH_WIDGETS);
  const f = drawer('تخصيص لوحة التحكم', `<p class="muted">اختر الأقسام التي تظهر لك ورتّبها. يُحفظ على حسابك.</p><ol class="dash-cfg" id="dcfg"></ol>
    <button type="button" class="btn ghost sm" id="dreset">الترتيب الافتراضي</button>`, async () => { await saveUI({ dash: d }); toast('حُفظت لوحة التحكم'); dashboardView(); }, 'حفظ');
  const draw = () => { $('#dcfg', f).innerHTML = d.order.map((k, i) => `<li data-k="${k}"><label class="row" style="gap:8px;flex:1"><input type="checkbox" ${d.hidden.includes(k) ? '' : 'checked'} aria-label="إظهار ${esc(N[k])}"> ${esc(N[k])}</label>
    <button type="button" class="btn ghost icon sm" data-up ${i ? '' : 'disabled'} aria-label="أعلى">▲</button><button type="button" class="btn ghost icon sm" data-dn ${i < d.order.length - 1 ? '' : 'disabled'} aria-label="أسفل">▼</button></li>`).join(''); };
  $('#dcfg', f).addEventListener('click', e => { const li = e.target.closest('li'); if (!li) return; const i = d.order.indexOf(li.dataset.k);
    if (e.target.closest('[data-up]') && i > 0) { [d.order[i - 1], d.order[i]] = [d.order[i], d.order[i - 1]]; draw(); }
    if (e.target.closest('[data-dn]') && i < d.order.length - 1) { [d.order[i + 1], d.order[i]] = [d.order[i], d.order[i + 1]]; draw(); } });
  $('#dcfg', f).addEventListener('change', e => { const li = e.target.closest('li'); if (!li) return; const k = li.dataset.k; d.hidden = e.target.checked ? d.hidden.filter(x => x !== k) : [...d.hidden, k]; });
  $('#dreset', f).onclick = () => { d = { order: [...DASH_DEFAULT.order], hidden: [...DASH_DEFAULT.hidden] }; draw(); };
  draw();
}
async function dashQuick() {
  const L = [['sales', 'create', '#/invoices/new', 'file', 'فاتورة جديدة'], ['sales', 'post', '#/pos', 'pos', 'نقطة البيع'], ['sales', 'create', '#/receipts/new', 'receipt', 'سند قبض'], ['sales', 'create', '#/quotes/new', 'file', 'عرض سعر'],
    ['purchases', 'create', '#/bills/new', 'cart', 'فاتورة مشتريات'], ['purchases', 'create', '#/payments/new', 'receipt', 'سند صرف'], ['expenses', 'create', '#/expenses', 'receipt', 'مصروف'],
    ['manufacturing', 'create', '#/mfg/new', 'gear', 'أمر تصنيع'], ['inventory', 'create', '#/stock/new', 'box', 'حركة مخزون'], ['accounting', 'create', '#/projects', 'box', 'المشاريع'], ['hr', 'create', '#/attendance', 'users', 'الحضور'], ['reports', 'view', '#/reports/pl', 'chart', 'قائمة الدخل']]
    .filter(([m, a]) => can(m, a));
  return L.length ? `<section class="quick-grid" style="margin-bottom:24px">${L.map(([, , h, ic, t]) => `<a class="card quick" href="${h}">${icon(ic)}<span>${t}</span></a>`).join('')}</section>` : '';
}
async function dashProjects() {
  if (api.mode !== 'supabase' || !(can('accounting') || can('manufacturing') || can('reports'))) return '';
  const [ccs, pl, ts] = await Promise.all([api.listCostCenters(), api.projectPl('2000-01-01', riyadhToday()).catch(() => []), api.listTasks().catch(() => [])]);
  const act = ccs.filter(c => c.status === 'active' && c.project_type !== 'internal').slice(0, 6); if (!act.length) return '';
  const P = Object.fromEntries(pl.map(r => [r.id, r])), today = riyadhToday();
  return `<section class="card" style="margin-bottom:24px"><div class="row" style="justify-content:space-between"><h2 style="margin:0">المشاريع النشطة</h2><a class="xs" href="#/projects">كل المشاريع ←</a></div>
    <div class="tbl-wrap" style="margin-top:10px"><table class="list-tbl"><thead><tr><th>المشروع</th><th class="m-hide">التسليم</th><th>الإنجاز</th><th class="amt">الربح</th></tr></thead><tbody>
    ${act.map(c => { const t = ts.filter(x => x.cost_center_id === c.id), done = t.filter(x => x.status === 'done').length, r = P[c.id] || { revenue: 0, cogs: 0, expenses: 0 }, pr = r.revenue - r.cogs - r.expenses, late = c.due_date && c.due_date < today;
      return `<tr class="click" data-href="#/projects/${esc(c.id)}"><td><a class="rowlink" href="#/projects/${esc(c.id)}">${esc(c.name)}</a></td><td class="num m-hide ${late ? 'down' : ''}">${esc(c.due_date || '—')}${late ? ' ⚠' : ''}</td>
        <td>${t.length ? `<div class="bar"><i style="width:${(done / t.length * 100).toFixed(0)}%"></i></div><span class="xs muted num">${done}/${t.length}</span>` : '<span class="xs muted">—</span>'}</td><td class="amt num ${pr < 0 ? 'down' : ''}">${money(pr)}</td></tr>`; }).join('')}</tbody></table></div></section>`;
}

const THEME_ROUTES = [[/^#\/appearance$/, appearanceView]];
