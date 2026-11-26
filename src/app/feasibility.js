// =====================================================================
// Feasibility studies: formula-based (unit margin, break-even, payback,
// cash flow, NPV, IRR, three scenarios). Every input number keeps its
// source — pulled from past projects / products / company overheads,
// typed by hand, or imported from an AI reply the user pasted back.
// Printed report uses the company's invoice design. Inserted after design.js.
// =====================================================================
const FS_KIND = { product: ['منتج أو مشروع جديد', 'b-info'], investment: ['استثمار (مكينة، توسعة…)', 'b-warn'] };
const FS_STATUS = { draft: ['مسودة', 'b-draft'], approved: ['معتمدة', 'b-ok'], rejected: ['مرفوضة', 'b-bad'] };
const FS_SRC = { manual: 'يدوي', history: 'من السجل', ai: 'ذكاء اصطناعي' };
const FS_SCEN = [['real', 'واقعي', 'fs1'], ['pess', 'متشائم', 'fs2'], ['opt', 'متفائل', 'fs3']];
const fsEditable = () => can('feasibility', 'create');
const fsN = (v = 0, src = 'manual', ref) => ({ v, src, ...(ref ? { ref } : {}) });
const fsDefaults = kind => ({
  desc: '', market: '', price_mode: 'mine',
  market_price: fsN(), my_price: fsN(), volume: fsN(1), growth: fsN(0),
  materials: fsN(), labor: fsN(), other_var: fsN(), income: fsN(), opex: fsN(),
  fixed: kind === 'investment' ? [{ name: 'صيانة وتأمين', ...fsN() }] : [{ name: 'إيجار الورشة (حصة المشروع)', ...fsN() }, { name: 'كهرباء وماء', ...fsN() }, { name: 'رواتب إدارية', ...fsN() }, { name: 'تسويق', ...fsN() }],
  capex: kind === 'investment' ? [{ name: 'سعر الأصل / المكينة', ...fsN() }, { name: 'نقل وتركيب وتدريب', ...fsN() }] : [{ name: 'معدات وأدوات', ...fsN() }, { name: 'رأس مال عامل (مواد أول دفعة)', ...fsN() }],
  salvage: fsN(), months: kind === 'investment' ? 60 : 24, discount: 10, zakat: 2.5,
  scen: { real: { price: 0, volume: 0, cost: 0 }, opt: { price: 5, volume: 20, cost: -5 }, pess: { price: -10, volume: -30, cost: 15 } },
});
// merge stored inputs over defaults so older studies always have every key
const fsInputs = s => { const d = fsDefaults(s.kind), i = s.inputs || {}; const o = { ...d, ...i, scen: { ...d.scen, ...(i.scen || {}) } };
  for (const k of Object.keys(d)) if (d[k] && typeof d[k] === 'object' && 'v' in d[k]) o[k] = { ...d[k], ...(i[k] || {}) };
  o.fixed = Array.isArray(i.fixed) ? i.fixed : d.fixed; o.capex = Array.isArray(i.capex) ? i.capex : d.capex; return o; };
const fsNum = x => { if (x == null || x === '') return null; const n = Number(toLatin(String(x)).replace(/[,٬\s]/g, '')); return Number.isFinite(n) ? n : null; };
const fsPct = x => x == null || !Number.isFinite(x) ? '—' : (x * 100).toLocaleString('en-US', { maximumFractionDigits: 1 }) + '٪';
const fsMonths = m => m == null ? 'لا يسترد خلال المدة' : m < 1 ? 'أقل من شهر' : `${m.toLocaleString('en-US', { maximumFractionDigits: 1 })} شهر`;
const fsSum = rows => rows.reduce((s, r) => s + (Number(r.v) || 0), 0);

// ---------- the formulas ----------
function feasCalc(I, kind, sc = { price: 0, volume: 0, cost: 0 }) {
  const fp = 1 + (sc.price || 0) / 100, fv = 1 + (sc.volume || 0) / 100, fc = 1 + (sc.cost || 0) / 100;
  const g = (I.growth.v || 0) / 100, N = Math.max(1, Math.min(120, Math.round(I.months) || 24)), z = Math.max(0, I.zakat || 0) / 100;
  const inv = kind === 'investment';
  const price = (I.price_mode === 'market' ? I.market_price.v : I.my_price.v) * fp, unit = (I.materials.v + I.labor.v + I.other_var.v) * fc, vol = Math.max(0, I.volume.v * fv);
  const fixed = fsSum(I.fixed) * fc, capex = fsSum(I.capex), contribution = inv ? null : price - unit;
  const flows = []; let cum = -capex, payback = null;
  for (let m = 1; m <= N; m++) {
    const gm = Math.pow(1 + g, m - 1), R = inv ? I.income.v * fp * fv * gm : price * vol * gm, V = inv ? I.opex.v * fc : unit * vol * gm;
    const P = R - V - fixed; let net = P > 0 ? P * (1 - z) : P; if (m === N) net += I.salvage.v || 0;
    const prev = cum; cum += net; if (payback == null && cum >= 0 && capex > 0) payback = net > 0 ? m - 1 + (-prev / net) : m;
    flows.push({ m, R, V, F: fixed, net, cum });
  }
  if (capex <= 0 && flows[0]?.net > 0) payback = 0;
  const r = Math.pow(1 + Math.max(0, I.discount || 0) / 100, 1 / 12) - 1;
  const npvAt = x => flows.reduce((s, f) => s + f.net / Math.pow(1 + x, f.m), -capex);
  let irr = null;
  if (capex > 0) { let lo = -0.99, hi = 1, flo = npvAt(lo), fhi = npvAt(hi);
    if (flo * fhi < 0) { for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2, fm = npvAt(mid); if (flo * fm <= 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; } } irr = Math.pow(1 + (lo + hi) / 2, 12) - 1; } }
  const total = flows.reduce((s, f) => s + f.net, 0), f1 = flows[0];
  return { price, unit, contribution, cm: !inv && price > 0 ? contribution / price : null, vol, fixed, capex, N,
    be: !inv && contribution > 0 ? fixed / contribution : null, beNever: !inv && contribution <= 0,
    m1: f1, margin: f1.R > 0 ? (f1.R - f1.V - f1.F) / f1.R : null, payback, npv: npvAt(r), irr, total, roi: capex > 0 ? (total - capex) / capex : null, flows };
}
const fsVerdict = (real, pess) => real.npv > 0 && real.payback != null ? (pess.npv > 0 ? ['مجدية', 'b-ok', 'مربحة حتى في السيناريو المتشائم.'] : ['مجدية بحذر', 'b-warn', 'مربحة في الواقعي، لكنها تخسر في المتشائم — راجع المخاطر.'])
  : real.npv > 0 ? ['مجدية بحذر', 'b-warn', 'القيمة الحالية موجبة لكن الاسترداد يتجاوز مدة الدراسة.'] : ['غير مجدية بالأرقام الحالية', 'b-bad', 'صافي القيمة الحالية سالب — جرّب سعراً أعلى أو تكلفة أقل.'];
const fsAll = (I, kind) => Object.fromEntries(FS_SCEN.map(([k]) => [k, feasCalc(I, kind, I.scen[k])]));

// cumulative cash for the three scenarios (one axis, thin lines, legend + native tooltip per month)
function fsChart(R) {
  const W = 640, H = 220, pl = 8, pr = 64, pt = 12, pb = 26, N = R.real.flows.length;
  const series = FS_SCEN.map(([k, t, cls]) => ({ t, cls, v: [-R[k].capex, ...R[k].flows.map(f => f.cum)] }));
  const all = series.flatMap(s => s.v), mx = Math.max(1, ...all), mn = Math.min(0, ...all);
  const x = i => W - pr - (W - pl - pr) * (i / N), y = v => pt + (H - pt - pb) * (mx - v) / (mx - mn || 1);
  const ticks = [mn, 0, mx].filter((v, i, a) => a.indexOf(v) === i);
  const step = Math.max(1, Math.ceil(N / 8));
  return `<div class="fs-legend" aria-hidden="true">${series.map(s => `<span><i class="${s.cls}"></i>${s.t}</span>`).join('')}</div>
  <svg viewBox="0 0 ${W} ${H}" class="chart fs-chart" role="img" aria-label="النقد التراكمي حسب الشهر لثلاثة سيناريوهات">
    ${ticks.map(t => `<line x1="${pl}" x2="${W - pr}" y1="${y(t)}" y2="${y(t)}" class="${t === 0 ? 'zero' : 'grid'}"/><text x="${W - pr + 6}" y="${y(t) + 4}" class="tick">${Math.round(t / 100).toLocaleString('en-US')}</text>`).join('')}
    ${series.map(s => `<polyline class="${s.cls}" fill="none" points="${s.v.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>`).join('')}
    ${Array.from({ length: N + 1 }, (_, i) => `<rect class="hit" x="${(x(i) - (W - pl - pr) / N / 2).toFixed(1)}" y="${pt}" width="${((W - pl - pr) / N).toFixed(1)}" height="${H - pt - pb}"><title>${i === 0 ? 'البداية' : 'الشهر ' + i}: ${series.map(s => `${s.t} ${money(s.v[i])}`).join(' · ')}</title></rect>`).join('')}
    ${Array.from({ length: N + 1 }, (_, i) => i).filter(i => i % step === 0).map(i => `<text x="${x(i)}" y="${H - 8}" class="tick" text-anchor="middle">${i}</text>`).join('')}
  </svg><p class="xs muted" style="margin:2px 0 0">النقد التراكمي بالريال — المحور الأفقي بالأشهر. حيث يعبر الخط الصفر يكون الاسترداد.</p>`;
}

// ---------- list ----------
async function feasibilityView() {
  shell('feasibility', loading());
  const list = await api.listStudies();
  const rows = list.map(s => { const I = fsInputs(s), R = fsAll(I, s.kind); return { s, R, v: fsVerdict(R.real, R.pess) }; });
  $('#main').innerHTML = `<div class="page-head"><h1>دراسات الجدوى</h1>${fsEditable() ? `<button class="btn primary" id="newfs">${icon('plus')}دراسة جديدة</button>` : ''}</div>
    <p class="muted" style="margin:-8px 0 16px">احسب هامش الربح ونقطة التعادل ومدة الاسترداد والتدفق النقدي قبل ما تبدأ. كل رقم تختار مصدره: من مشاريعك السابقة، أو تكتبه بنفسك، أو تجيبه من الذكاء الاصطناعي.</p>
    ${rows.length ? `<div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>الدراسة</th><th class="m-hide">النوع</th><th>النتيجة</th><th class="amt">صافي القيمة الحالية</th><th class="m-hide">الاسترداد</th><th class="m-hide">الحالة</th></tr></thead><tbody>
      ${rows.map(({ s, R, v }) => `<tr class="click" data-href="#/feasibility/${esc(s.id)}"><td style="white-space:normal"><a class="rowlink" href="#/feasibility/${esc(s.id)}"><b>${esc(s.name)}</b></a><br><span class="xs muted num">${esc(String(s.updated_at || '').slice(0, 10))}</span></td>
        <td class="m-hide">${badge(FS_KIND[s.kind] || FS_KIND.product)}</td><td>${badge(v)}</td><td class="amt num ${R.real.npv < 0 ? 'down' : ''}">${money(R.real.npv)}</td>
        <td class="m-hide">${fsMonths(R.real.payback)}</td><td class="m-hide">${badge(FS_STATUS[s.status] || FS_STATUS.draft)}</td></tr>`).join('')}</tbody></table></div>`
    : empty('chart', 'لا توجد دراسات بعد', 'ابدأ بدراسة لمنتج جديد (مثل كرفان بمقاس جديد) أو استثمار (مثل مكينة قص ليزر). تقدر تبدأ من مشروع سابق عشان تتعبأ التكاليف تلقائياً.', fsEditable() ? `<button class="btn primary" id="newfs2">${icon('plus')}دراسة جديدة</button>` : '')}`;
  ['#newfs', '#newfs2'].forEach(s => { if ($(s)) $(s).onclick = () => newStudyDrawer(list); });
}

async function newStudyDrawer(studies) {
  const [ccs, items] = await Promise.all([api.listCostCenters().catch(() => []), api.listItems().catch(() => [])]);
  const pj = ccs.filter(c => c.project_type !== 'internal').sort((a, b) => (a.status === 'closed' ? 0 : 1) - (b.status === 'closed' ? 0 : 1));
  const prods = items.filter(i => i.kind === 'product');
  const form = drawer('دراسة جدوى جديدة', `${field('name', 'اسم الدراسة', { req: true, attrs: 'maxlength="200" placeholder="مثل: كرفان سحب 7 متر — فئة اقتصادية"' })}
    <div class="field"><span class="lbl">نوع الدراسة</span><div class="ptype-pick">${Object.entries(FS_KIND).map(([k, [t]], i) => `<label class="ptype ${i ? '' : 'on'}"><input type="radio" name="kind" value="${k}" ${i ? '' : 'checked'}><b>${t}</b><span class="xs muted">${k === 'product' ? 'سعر بيع × كمية، وتكلفة لكل وحدة' : 'مبلغ تستثمره وعائد أو توفير شهري'}</span></label>`).join('')}</div></div>
    ${select('start', 'ابدأ من', [['blank', 'دراسة فارغة'], ...(pj.length ? [['cc', 'مشروع سابق — تُعبأ التكاليف منه']] : []), ...(prods.length ? [['item', 'منتج — تُعبأ تكلفته وسعره']] : []), ...(studies.length ? [['copy', 'نسخة من دراسة سابقة']] : [])], 'blank')}
    <div id="nsx"></div>`, async v => {
      const kind = v.kind === 'investment' ? 'investment' : 'product'; let inputs = fsDefaults(kind), ai_notes = null;
      if (v.start === 'copy' && v.copy) { const src = studies.find(s => s.id === v.copy); inputs = fsInputs({ ...src, kind }); ai_notes = src.ai_notes; }
      if (v.start === 'cc' && v.cc) fsApplyProject(inputs, await api.projectHistory(v.cc), ['my_price', 'materials', 'labor', 'other_var']);
      if (v.start === 'item' && v.item) fsApplyItem(inputs, await api.itemHistory(v.item), ['my_price', 'materials', 'volume']);
      const row = await api.saveStudy({ name: v.name.trim() || 'دراسة جديدة', kind, inputs, ai_notes }); location.hash = '#/feasibility/' + row.id;
    }, 'إنشاء الدراسة');
  const sub = () => { const s = $('[name=start]', form).value;
    $('#nsx', form).innerHTML = s === 'cc' ? select('cc', 'المشروع', pj.map(c => [c.id, `${c.name} (${c.code})${c.status === 'closed' ? ' — منتهي' : ''}`])) + '<p class="help">يُقسم إجمالي المواد والأجور والتكاليف الأخرى على كمية المشروع (وحدة واحدة لمشاريع العملاء).</p>'
      : s === 'item' ? select('item', 'المنتج', prods.map(i => [i.id, i.name_ar])) : s === 'copy' ? select('copy', 'الدراسة', studies.map(x => [x.id, x.name])) : ''; };
  $('[name=start]', form).onchange = sub;
  $$('.ptype', form).forEach(l => l.onclick = () => setTimeout(() => $$('.ptype', form).forEach(x => x.classList.toggle('on', $('input', x).checked))));
}

// history → inputs (per unit)
function fsApplyProject(I, h, keys) {
  const q = h.qty > 0 ? h.qty : 1, ref = `${h.name}${q > 1 ? ` ÷ ${fq(q)} وحدة` : ''}`;
  const val = { my_price: h.revenue / q, materials: h.materials / q, labor: h.labor / q, other_var: h.other / q };
  keys.forEach(k => { if (val[k] != null && (k !== 'my_price' || h.revenue > 0)) I[k] = fsN(Math.round(val[k]), 'history', ref); });
}
function fsApplyItem(I, h, keys) {
  const val = { my_price: h.avg_price ?? h.list_price, materials: h.avg_cost, volume: h.sold_qty > 0 ? Math.round(h.sold_qty / 12 * 100) / 100 : null };
  const why = { my_price: h.avg_price != null ? 'متوسط سعر البيع آخر 12 شهر' : 'سعر البيع في بطاقة المنتج', materials: 'متوسط التكلفة في المخزون', volume: 'متوسط المبيع الشهري آخر 12 شهر' };
  keys.forEach(k => { if (val[k] != null && val[k] > 0) I[k] = fsN(k === 'volume' ? val[k] : Math.round(val[k]), 'history', `${h.name} — ${why[k]}`); });
}

// ---------- editor ----------
let FS_SAVE = null;
async function studyView(id) {
  shell('feasibility', loading());
  const s = await api.getStudy(id), ed = fsEditable(), inv = s.kind === 'investment';
  const I = fsInputs(s); let notes = s.ai_notes || '', status = s.status, name = s.name, dirty = false;
  const save = async () => { clearTimeout(FS_SAVE); FS_SAVE = null; if (!dirty || !ed) return; dirty = false; const st = $('#fssave');
    if (st) st.textContent = 'جارٍ الحفظ…';
    try { await api.saveStudy({ id, name, kind: s.kind, inputs: I, ai_notes: notes || null, status }); if ($('#fssave')) $('#fssave').textContent = 'محفوظ ✓'; }
    catch (e) { dirty = true; if ($('#fssave')) $('#fssave').textContent = 'تعذّر الحفظ'; fail(e); } };
  const touch = () => { if (!ed) return; dirty = true; if ($('#fssave')) $('#fssave').textContent = 'تغييرات غير محفوظة…'; clearTimeout(FS_SAVE); FS_SAVE = setTimeout(save, 1200); };
  const leave = () => { if (!location.hash.startsWith('#/feasibility/' + id) || location.hash.endsWith('/print')) { window.removeEventListener('hashchange', leave); save(); } };
  window.addEventListener('hashchange', leave);

  const srcSel = (key, label, opts = ['manual', 'history', 'ai'], cur) => `<select class="fs-src" data-src="${key}" aria-label="مصدر: ${esc(label)}" ${ed ? '' : 'disabled'}>${opts.map(o => `<option value="${o}" ${o === cur ? 'selected' : ''}>${FS_SRC[o]}</option>`).join('')}</select>`;
  const mIn = v => v ? String(Math.round(v) / 100) : '0';
  const nf = (key, label, { unit = 'ر.س', pct = false, qty = false, help = '', hist = true } = {}) => { const o = I[key];
    return `<div class="field fs-f"><label for="fs-${key}">${esc(label)}</label><div class="fs-in"><input class="input num" id="fs-${key}" data-k="${key}" data-t="${pct ? 'pct' : qty ? 'qty' : 'money'}" inputmode="decimal" value="${esc(pct || qty ? String(o.v ?? 0) : mIn(o.v))}" ${ed ? '' : 'readonly'}>
      <span class="fs-unit">${pct ? '٪' : esc(unit)}</span>${srcSel(key, label, hist ? ['manual', 'history', 'ai'] : ['manual', 'ai'], o.src)}</div>
      <span class="help fs-ref" id="ref-${key}">${o.ref ? 'المصدر: ' + esc(o.ref) : esc(help)}</span></div>`; };
  const rows = (list, which) => `<div class="fs-rows" id="rows-${which}">${I[list].map((r, i) => `<div class="fs-row"><input class="input" data-row="${which}:${i}:name" value="${esc(r.name)}" aria-label="البند" maxlength="120" ${ed ? '' : 'readonly'}>
      <div class="fs-in"><input class="input num" data-row="${which}:${i}:v" inputmode="decimal" value="${esc(mIn(r.v))}" aria-label="مبلغ ${esc(r.name)}" ${ed ? '' : 'readonly'}><span class="fs-unit">ر.س</span>
      ${srcSel(`${which}:${i}`, r.name, which === 'fixed' ? ['manual', 'history', 'ai'] : ['manual', 'ai'], r.src || 'manual')}</div>
      ${ed ? `<button type="button" class="btn ghost icon sm" data-del="${which}:${i}" aria-label="حذف ${esc(r.name)}">${icon('trash')}</button>` : ''}${r.ref ? `<span class="help fs-ref">المصدر: ${esc(r.ref)}</span>` : ''}</div>`).join('')}
    ${ed ? `<button type="button" class="btn ghost sm" data-add="${which}">${icon('plus')}إضافة بند</button>` : ''}</div>`;

  const draw = () => {
    $('#main').innerHTML = `<a class="crumb" href="#/feasibility">${icon('chev')} دراسات الجدوى</a>
    <div class="page-head"><h1>${esc(name)}</h1><div class="row" style="gap:8px;flex-wrap:wrap">
      <span class="xs muted" id="fssave" aria-live="polite">${ed ? 'محفوظ ✓' : 'عرض فقط'}</span>
      <a class="btn secondary" href="#/feasibility/${esc(id)}/print">${icon('down')}التقرير للطباعة</a>
      ${ed ? `<button class="btn secondary" id="aiout">تصدير للذكاء الاصطناعي</button><button class="btn secondary" id="aiin">استيراد رد الذكاء الاصطناعي</button>` : ''}</div></div>
    <div class="fs-grid"><form class="grid" id="fsf" style="gap:16px" novalidate onsubmit="return false">
      <section class="card grid" style="gap:12px"><h3 style="margin:0">الوصف</h3>
        <div class="form-grid">${field('fsname', 'اسم الدراسة', { value: name, attrs: `maxlength="200" ${ed ? '' : 'readonly'}` })}
          <div class="field"><label for="fs-status">الحالة</label><select class="input" id="fs-status" ${ed ? '' : 'disabled'}>${Object.entries(FS_STATUS).map(([k, [t]]) => `<option value="${k}" ${k === status ? 'selected' : ''}>${t}</option>`).join('')}</select></div></div>
        <div class="field"><label for="fs-desc">وصف ${inv ? 'الاستثمار' : 'المنتج أو المشروع'}</label><textarea class="input" id="fs-desc" rows="2" style="height:auto;padding:8px 12px" maxlength="1500" ${ed ? '' : 'readonly'} placeholder="${inv ? 'مثل: مكينة قص بلازما CNC لتقليل الهدر وتسريع القص' : 'مثل: كرفان سحب 7×2.4 متر، عزل ساندوتش 50 مم، غرفة + حمام'}">${esc(I.desc)}</textarea><span class="help">يُستخدم في التقرير وفي النص المرسل للذكاء الاصطناعي.</span></div>
        ${field('fsmarket', 'السوق المستهدف', { value: I.market, attrs: `maxlength="300" ${ed ? '' : 'readonly'} placeholder="مثل: هواة الرحلات والمخيمات في المنطقة الوسطى"` })}</section>
      <section class="card grid" style="gap:12px"><h3 style="margin:0">${inv ? 'العائد الشهري' : 'الإيرادات'}</h3>
        ${inv ? nf('income', 'الإيراد الإضافي أو التوفير الشهري', { hist: false, help: 'مثل: ربح الطلبات الجديدة أو ما توفره من أجور وهدر كل شهر' }) : `
        <div class="field"><span class="lbl">سعر البيع المعتمد في الحساب</span><div class="seg">${[['mine', 'سعري المقترح'], ['market', 'سعر السوق']].map(([k, t]) => `<label class="${I.price_mode === k ? 'on' : ''}"><input type="radio" name="price_mode" value="${k}" ${I.price_mode === k ? 'checked' : ''} ${ed ? '' : 'disabled'}>${t}</label>`).join('')}</div></div>
        <div class="form-grid">${nf('my_price', 'سعري المقترح للوحدة (قبل الضريبة)')}${nf('market_price', 'متوسط سعر السوق للوحدة', { help: 'من أسعار المنافسين، أو اطلبه من الذكاء الاصطناعي' })}</div>
        <p class="help" id="pcmp"></p>
        ${nf('volume', 'الكمية المتوقع بيعها شهرياً', { qty: true, unit: 'وحدة', help: 'يقبل الكسور: 0.5 = وحدة كل شهرين' })}`}
        ${nf('growth', 'النمو الشهري المتوقع', { pct: true, hist: false, help: 'اتركه 0 إذا لا تتوقع نمو' })}</section>
      ${inv ? `<section class="card grid" style="gap:12px"><h3 style="margin:0">تكاليف التشغيل</h3>${nf('opex', 'تكاليف تشغيل شهرية إضافية', { hist: false, help: 'كهرباء المكينة، مستهلكات، مشغّل…' })}</section>` : `
      <section class="card grid" style="gap:12px"><div class="row" style="justify-content:space-between"><h3 style="margin:0">تكلفة الوحدة</h3>${ed ? '<button type="button" class="btn ghost sm" id="fshist">من مشروع سابق أو منتج</button>' : ''}</div>
        <div class="form-grid">${nf('materials', 'المواد')}${nf('labor', 'العمالة والأجور')}</div>${nf('other_var', 'تكاليف أخرى لكل وحدة', { help: 'ورش خارجية، نقل، تركيب…' })}</section>`}
      <section class="card grid" style="gap:12px"><div class="row" style="justify-content:space-between"><h3 style="margin:0">التكاليف الثابتة الشهرية</h3>${ed ? '<button type="button" class="btn ghost sm" id="fsoh">من مصاريف الشركة الفعلية</button>' : ''}</div>
        <p class="help" style="margin:0">ضع حصة هذا ${inv ? 'الاستثمار' : 'المشروع'} فقط من المصاريف العامة.</p>${rows('fixed', 'fixed')}</section>
      <section class="card grid" style="gap:12px"><h3 style="margin:0">الاستثمار المبدئي</h3>${rows('capex', 'capex')}${nf('salvage', 'القيمة المتبقية في نهاية المدة', { hist: false, help: 'مثل: سعر بيع المكينة مستعملة. اتركها 0 إذا لا شيء' })}</section>
      <section class="card grid" style="gap:12px"><h3 style="margin:0">إعدادات الحساب</h3><div class="form-grid" style="grid-template-columns:repeat(3,1fr)">
        ${field('months', 'مدة الدراسة (أشهر)', { value: I.months, attrs: `inputmode="numeric" ${ed ? '' : 'readonly'}` })}${field('discount', 'معدل الخصم السنوي ٪', { value: I.discount, help: 'العائد اللي تبيه كحد أدنى', attrs: `inputmode="decimal" ${ed ? '' : 'readonly'}` })}${field('zakat', 'الزكاة أو الضريبة ٪', { value: I.zakat, attrs: `inputmode="decimal" ${ed ? '' : 'readonly'}` })}</div></section>
      <section class="card"><h3 style="margin:0 0 8px">السيناريوهات</h3><p class="help" style="margin:0 0 8px">نسبة التغيير عن الأرقام أعلاه. مثال المتشائم: السعر −10٪، الكمية −30٪، التكاليف +15٪.</p>
        <div class="tbl-wrap"><table class="list-tbl fs-scen"><thead><tr><th></th>${FS_SCEN.map(([, t, c]) => `<th><i class="sw ${c}"></i>${t}</th>`).join('')}</tr></thead><tbody>
        ${[['price', inv ? 'العائد' : 'السعر'], ['volume', inv ? 'الطلب' : 'الكمية'], ['cost', 'التكاليف']].map(([f, t]) => `<tr><td>${t} ٪</td>${FS_SCEN.map(([k, tt]) => `<td><input class="input num" data-scen="${k}:${f}" inputmode="decimal" value="${esc(I.scen[k][f])}" aria-label="${tt} — ${t}" ${ed ? '' : 'readonly'}></td>`).join('')}</tr>`).join('')}</tbody></table></div></section>
      <section class="card"><div class="row" style="justify-content:space-between"><h3 style="margin:0">التحليل المكتوب</h3>${notes && ed ? '<button type="button" class="btn ghost sm" id="clrnotes">حذف</button>' : ''}</div>
        ${notes ? `<div class="fs-notes">${esc(notes).replace(/\n/g, '<br>')}</div><p class="help">مستورد من الذكاء الاصطناعي — راجعه قبل الاعتماد. يظهر في التقرير المطبوع.</p>` : `<p class="muted" style="margin:8px 0 0">لا يوجد. اضغط «تصدير للذكاء الاصطناعي» واطلب «كتابة نص الدراسة»، ثم استورد الرد.</p>`}</section>
    </form><aside class="fs-res card" id="fsres" aria-live="polite"></aside></div>`;
    bind(); results();
  };

  const results = () => {
    const R = fsAll(I, s.kind), r = R.real, v = fsVerdict(r, R.pess);
    if ($('#pcmp')) { const a = I.my_price.v, b = I.market_price.v; $('#pcmp').textContent = a > 0 && b > 0 ? (a < b ? `سعرك أقل من السوق بـ ${fsPct((b - a) / b)}` : a > b ? `سعرك أعلى من السوق بـ ${fsPct((a - b) / b)}` : 'سعرك يساوي سعر السوق') : ''; }
    const k = (t, val, sub = '', cls = '') => `<div class="fs-k"><span>${t}</span><b class="num ${cls}">${val}</b>${sub ? `<span class="xs muted">${sub}</span>` : ''}</div>`;
    $('#fsres').innerHTML = `<div class="row" style="justify-content:space-between;align-items:center"><h3 style="margin:0">النتيجة (الواقعي)</h3>${badge(v)}</div><p class="xs muted" style="margin:4px 0 12px">${v[2]}</p>
      <div class="fs-kpis">${inv ? '' : k('هامش الوحدة', money(r.contribution), r.cm == null ? '' : fsPct(r.cm) + ' من السعر', r.contribution < 0 ? 'down' : '')}
        ${inv ? '' : k('نقطة التعادل', r.be == null ? (r.beNever ? 'لا تتحقق' : '—') : `${r.be.toLocaleString('en-US', { maximumFractionDigits: 2 })} وحدة/شهر`, r.be == null ? (r.beNever ? 'السعر أقل من تكلفة الوحدة' : 'لا توجد تكاليف ثابتة') : `≈ ${money(r.be * r.price)} ر.س مبيعات`, r.beNever ? 'down' : '')}
        ${k('صافي ربح الشهر الأول', money(r.m1.R - r.m1.V - r.m1.F), r.margin == null ? '' : 'هامش ' + fsPct(r.margin), r.m1.R - r.m1.V - r.m1.F < 0 ? 'down' : '')}
        ${k('مدة الاسترداد', fsMonths(r.payback), r.capex > 0 ? `لاستثمار ${money(r.capex)} ر.س` : 'بدون استثمار مبدئي', r.payback == null ? 'down' : '')}
        ${k('صافي القيمة الحالية', money(r.npv), `بخصم ${I.discount || 0}٪ سنوياً على ${r.N} شهر`, r.npv < 0 ? 'down' : '')}
        ${k('معدل العائد الداخلي', r.irr == null ? '—' : fsPct(r.irr), 'سنوي', r.irr != null && r.irr < (I.discount || 0) / 100 ? 'down' : '')}
        ${k('العائد على الاستثمار', r.roi == null ? '—' : fsPct(r.roi), `صافي ${money(r.total)} ر.س خلال المدة`, r.roi != null && r.roi < 0 ? 'down' : '')}</div>
      <h4 style="margin:16px 0 6px">مقارنة السيناريوهات</h4>
      <div class="tbl-wrap"><table class="list-tbl fs-cmp"><thead><tr><th></th>${FS_SCEN.map(([, t, c]) => `<th><i class="sw ${c}"></i>${t}</th>`).join('')}</tr></thead><tbody>
        ${[['ربح الشهر الأول', x => money(x.m1.R - x.m1.V - x.m1.F)], ['الاسترداد', x => fsMonths(x.payback)], ['صافي القيمة الحالية', x => money(x.npv)], ['العائد الداخلي', x => x.irr == null ? '—' : fsPct(x.irr)]]
          .map(([t, f]) => `<tr><td>${t}</td>${FS_SCEN.map(([kk]) => `<td class="num">${f(R[kk])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      ${fsChart(R)}
      <details style="margin-top:10px"><summary>التدفق النقدي الشهري (الواقعي)</summary><div class="tbl-wrap" style="max-height:320px;overflow:auto"><table class="list-tbl"><thead><tr><th>الشهر</th><th class="amt">الإيراد</th><th class="amt">التكاليف</th><th class="amt">الصافي</th><th class="amt">التراكمي</th></tr></thead><tbody>
        <tr><td>البداية</td><td></td><td class="amt num">${money(r.capex)}</td><td class="amt num down">${money(-r.capex)}</td><td class="amt num">${money(-r.capex)}</td></tr>
        ${r.flows.map(f => `<tr><td class="num">${f.m}</td><td class="amt num">${money(f.R)}</td><td class="amt num">${money(f.V + f.F)}</td><td class="amt num ${f.net < 0 ? 'down' : ''}">${money(f.net)}</td><td class="amt num ${f.cum < 0 ? 'down' : ''}">${money(f.cum)}</td></tr>`).join('')}</tbody></table></div></details>`;
  };

  const bind = () => {
    if (!ed) return;
    const f = $('#fsf');
    f.addEventListener('input', e => { const t = e.target;
      if (t.dataset.k) { const n = fsNum(t.value) ?? 0, o = I[t.dataset.k]; o.v = t.dataset.t === 'money' ? Math.round(n * 100) : n; o.src = 'manual'; delete o.ref;
        const sel = $(`[data-src="${t.dataset.k}"]`); if (sel) sel.value = 'manual'; const rf = $('#ref-' + t.dataset.k); if (rf) rf.textContent = ''; }
      else if (t.dataset.row) { const [w, i, p] = t.dataset.row.split(':'), r = I[w][+i]; if (p === 'name') r.name = t.value; else { r.v = Math.round((fsNum(t.value) ?? 0) * 100); r.src = 'manual'; delete r.ref; const sel = $(`[data-src="${w}:${i}"]`); if (sel) sel.value = 'manual'; } }
      else if (t.dataset.scen) { const [k, p] = t.dataset.scen.split(':'); I.scen[k][p] = fsNum(t.value) ?? 0; }
      else if (t.id === 'f-fsname') name = t.value.trim() || name;
      else if (t.id === 'fs-desc') I.desc = t.value; else if (t.id === 'f-fsmarket') I.market = t.value;
      else if (t.id === 'f-months') I.months = Math.max(1, Math.min(120, Math.round(fsNum(t.value) || 1)));
      else if (t.id === 'f-discount') I.discount = fsNum(t.value) ?? 0; else if (t.id === 'f-zakat') I.zakat = fsNum(t.value) ?? 0;
      touch(); results(); });
    f.addEventListener('change', e => { const t = e.target;
      if (t.name === 'price_mode') { I.price_mode = t.value; $$('.seg label', f).forEach(l => l.classList.toggle('on', !!$('input', l)?.checked)); touch(); results(); }
      else if (t.id === 'fs-status') { status = t.value; touch(); }
      else if (t.dataset.src) { const key = t.dataset.src, cur = key.includes(':') ? (I[key.split(':')[0]][+key.split(':')[1]].src || 'manual') : I[key].src; const want = t.value; t.value = cur;
        if (want === 'manual') { if (key.includes(':')) { const [w, i] = key.split(':'); I[w][+i].src = 'manual'; delete I[w][+i].ref; } else { I[key].src = 'manual'; delete I[key].ref; } t.value = 'manual'; touch(); draw(); }
        else if (want === 'history') key.startsWith('fixed') ? overheadDrawer() : histDrawer(key);
        else if (want === 'ai') aiOut([key.startsWith('fixed') || key.startsWith('capex') ? 'fixed' : ['market_price', 'my_price', 'income'].includes(key) ? 'price' : key === 'volume' ? 'volume' : 'costs']); } });
    f.addEventListener('click', e => { const a = e.target.closest('[data-add]'), d = e.target.closest('[data-del]');
      if (a) { I[a.dataset.add].push({ name: 'بند جديد', ...fsN() }); touch(); draw(); $(`[data-row="${a.dataset.add}:${I[a.dataset.add].length - 1}:name"]`)?.select(); }
      if (d) { const [w, i] = d.dataset.del.split(':'); I[w].splice(+i, 1); touch(); draw(); } });
    $('#fshist') && ($('#fshist').onclick = () => histDrawer());
    $('#fsoh').onclick = overheadDrawer;
    $('#aiout').onclick = () => aiOut(); $('#aiin').onclick = aiIn;
    $('#clrnotes') && ($('#clrnotes').onclick = () => { notes = ''; touch(); draw(); });
  };

  // pull per-unit numbers from a past project or a product
  const histDrawer = async focus => {
    const [ccs, items] = await Promise.all([api.listCostCenters().catch(() => []), api.listItems().catch(() => [])]);
    const pj = ccs.filter(c => c.project_type !== 'internal'), prods = items.filter(i => i.kind === 'product');
    if (!pj.length && !prods.length) return toast('لا توجد مشاريع أو منتجات سابقة بعد', 'warn');
    let H = null, T = null, mode = pj.length ? 'cc' : 'item';
    const LBL = { my_price: 'سعري المقترح', market_price: 'سعر السوق', materials: 'المواد', labor: 'العمالة والأجور', other_var: 'تكاليف أخرى', volume: 'الكمية الشهرية' };
    const form = drawer('أرقام من السجل', `<div class="seg">${[['cc', 'مشروع سابق', pj.length], ['item', 'منتج', prods.length]].filter(x => x[2]).map(([k, t]) => `<label class="${k === mode ? 'on' : ''}"><input type="radio" name="hm" value="${k}" ${k === mode ? 'checked' : ''}>${t}</label>`).join('')}</div>
      <div id="hpick"></div><div id="hprev"></div>`, async () => {
      if (!H) throw new Error('اختر مشروعاً أو منتجاً');
      const keys = $$('[name^=ap_]:checked', form).map(x => x.name.slice(3)); if (!keys.length) throw new Error('اختر رقماً واحداً على الأقل');
      if (mode === 'cc') fsApplyProject(I, H, keys.filter(k => k !== 'market_price')); else fsApplyItem(I, H, keys);
      if (keys.includes('market_price') && T?.my_price.src === 'history') I.market_price = fsN(T.my_price.v, 'history', T.my_price.ref);
      touch(); draw(); toast('طُبّقت الأرقام من السجل'); }, 'تطبيق المحدد');
    const preview = async () => { const id = $('[name=hsrc]', form)?.value; if (!id) return; $('#hprev', form).innerHTML = loading();
      H = mode === 'cc' ? await api.projectHistory(id) : await api.itemHistory(id);
      const tmp = T = fsDefaults('product'); mode === 'cc' ? fsApplyProject(tmp, H, ['my_price', 'materials', 'labor', 'other_var']) : fsApplyItem(tmp, H, ['my_price', 'materials', 'volume']);
      const ks = Object.keys(LBL).filter(k => tmp[k].src === 'history');
      $('#hprev', form).innerHTML = ks.length ? `${mode === 'cc' ? `<p class="help">إجمالي المشروع: إيراد ${money(H.revenue)} · مواد ${money(H.materials)} · أجور ${money(H.labor)}${H.hours ? ` (${fq(H.hours)} ساعة)` : ''} · أخرى ${money(H.other)} — مقسوم على ${fq(H.qty > 0 ? H.qty : 1)} وحدة.</p>` : ''}
        <div class="grid" style="gap:6px">${ks.map(k => `<label class="row" style="gap:8px"><input type="checkbox" name="ap_${k}" ${!focus || focus === k ? 'checked' : ''}> ${LBL[k]}: <b class="num">${k === 'volume' ? fq(tmp[k].v) + ' وحدة' : money(tmp[k].v)}</b></label>`).join('')}
          ${tmp.my_price.src === 'history' ? `<label class="row" style="gap:8px"><input type="checkbox" name="ap_market_price" ${focus === 'market_price' ? 'checked' : ''}> استخدم سعر البيع كسعر السوق أيضاً</label>` : ''}</div>`
        : '<p class="muted">لا توجد أرقام مرحّلة لهذا الاختيار بعد.</p>'; };
    const pick = () => { mode = $('[name=hm]:checked', form)?.value || mode; H = null; $$('.seg label', form).forEach(l => l.classList.toggle('on', !!$('input', l)?.checked));
      $('#hpick', form).innerHTML = select('hsrc', mode === 'cc' ? 'المشروع' : 'المنتج', [['', '— اختر —'], ...(mode === 'cc' ? pj.map(c => [c.id, `${c.name} (${c.code})${c.status === 'closed' ? ' — منتهي' : ''}`]) : prods.map(i => [i.id, i.name_ar]))]);
      $('#hprev', form).innerHTML = ''; $('[name=hsrc]', form).onchange = () => preview().catch(fail); };
    $$('[name=hm]', form).forEach(x => x.onchange = pick); pick();
  };

  // company overheads (last 12 months, not charged to projects) → fixed rows, with this study's share
  const overheadDrawer = async () => {
    const oh = await api.overheadHistory();
    if (!oh.length) return toast('لا توجد مصاريف عامة مرحّلة في آخر 12 شهر', 'warn');
    drawer('من مصاريف الشركة الفعلية', `<p class="help" style="margin:0">متوسط شهري لآخر 12 شهر للمصاريف غير المحمّلة على مشاريع. حدد البنود ونسبة ما يتحمله هذا ${inv ? 'الاستثمار' : 'المشروع'} منها.</p>
      <div class="tbl-wrap"><table class="list-tbl"><thead><tr><th></th><th>البند</th><th class="amt">متوسط شهري</th><th>الحصة ٪</th></tr></thead><tbody>
      ${oh.map((a, i) => `<tr><td><input type="checkbox" name="oh_${i}" aria-label="${esc(a.name)}"></td><td>${esc(a.name)}</td><td class="amt num">${money(a.monthly)}</td><td><input class="input num" name="sh_${i}" value="100" inputmode="decimal" style="width:80px" aria-label="حصة ${esc(a.name)}"></td></tr>`).join('')}</tbody></table></div>
      <label class="row" style="gap:8px"><input type="checkbox" name="replace"> استبدال البنود الحالية الفارغة (قيمتها 0)</label>`, async v => {
      const add = oh.map((a, i) => v['oh_' + i] ? { name: a.name, v: Math.round(a.monthly * Math.max(0, Math.min(100, fsNum(v['sh_' + i]) ?? 100)) / 100), src: 'history', ref: `متوسط آخر 12 شهر${(fsNum(v['sh_' + i]) ?? 100) < 100 ? ` × ${fsNum(v['sh_' + i])}٪` : ''}` } : null).filter(Boolean);
      if (!add.length) throw new Error('اختر بنداً واحداً على الأقل');
      if (v.replace) I.fixed = I.fixed.filter(r => r.v); I.fixed.push(...add); touch(); draw(); toast(`أُضيف ${add.length} بند`); }, 'إضافة');
  };

  // ---------- AI: export a ready prompt with the numbers, import the reply ----------
  const TOPICS = inv ? [['price', 'تقدير العائد الشهري الواقعي'], ['costs', 'مراجعة تكاليف التشغيل'], ['fixed', 'مراجعة التكاليف الثابتة والاستثمار'], ['scen', 'نسب السيناريوهات المناسبة'], ['risks', 'المخاطر والتوصيات'], ['narrative', 'كتابة نص دراسة الجدوى كاملاً']]
    : [['price', 'متوسط سعر السوق ونطاقه'], ['volume', 'حجم الطلب الشهري المتوقع'], ['costs', 'مراجعة تكلفة المواد والعمالة للوحدة'], ['fixed', 'مراجعة التكاليف الثابتة والاستثمار'], ['scen', 'نسب السيناريوهات المناسبة'], ['risks', 'المخاطر والتوصيات'], ['narrative', 'كتابة نص دراسة الجدوى كاملاً']];
  const prompt = (topics, anon) => {
    const sr = o => o.src === 'history' ? (anon ? ' (من سجلاتنا الفعلية)' : ` (من سجلاتنا: ${o.ref || ''})`) : o.src === 'ai' ? ' (تقدير سابق من الذكاء الاصطناعي)' : '';
    const m = o => `${(o.v / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })} ريال${sr(o)}`;
    const R = feasCalc(I, s.kind, I.scen.real);
    const L = [`أنت مستشار دراسات جدوى خبير في السوق السعودي.${anon ? '' : ` الشركة: ${ORG?.name_ar || ''}، مصنع كرفانات وهياكل حديدية.`}`,
      `أعمل دراسة جدوى ${inv ? 'لاستثمار' : 'لمنتج أو مشروع جديد'}: ${I.desc || (anon ? 'منتج جديد' : name)}`, I.market ? `السوق المستهدف: ${I.market}` : '', '', 'الأرقام الحالية (بالريال السعودي، قبل ضريبة القيمة المضافة):'];
    if (inv) L.push(`- العائد أو التوفير الشهري: ${m(I.income)}`, `- تكاليف التشغيل الشهرية: ${m(I.opex)}`);
    else L.push(`- سعري المقترح للوحدة: ${m(I.my_price)}`, `- متوسط سعر السوق: ${I.market_price.v ? m(I.market_price) : 'غير معروف'}`, `- الكمية المتوقعة شهرياً: ${I.volume.v} وحدة${sr(I.volume)}`,
      `- تكلفة الوحدة: مواد ${m(I.materials)}، عمالة ${m(I.labor)}، أخرى ${m(I.other_var)}`);
    L.push(`- النمو الشهري: ${I.growth.v}٪`, `- التكاليف الثابتة الشهرية: ${I.fixed.map(r => `${r.name} ${(r.v / 100).toLocaleString('en-US')}`).join('، ') || 'لا شيء'}`,
      `- الاستثمار المبدئي: ${I.capex.map(r => `${r.name} ${(r.v / 100).toLocaleString('en-US')}`).join('، ') || 'لا شيء'}`, `- مدة الدراسة ${I.months} شهر، معدل الخصم ${I.discount}٪ سنوياً، الزكاة ${I.zakat}٪`,
      `- النتيجة الحالية بالمعادلات: صافي ربح الشهر الأول ${money(R.m1.R - R.m1.V - R.m1.F)}، الاسترداد ${fsMonths(R.payback)}، صافي القيمة الحالية ${money(R.npv)}`, '', 'المطلوب:');
    TOPICS.filter(([k]) => topics.includes(k)).forEach(([, t], i) => L.push(`${i + 1}. ${t}`));
    const keys = []; const add = (k, d) => keys.push(`  "${k}": ${d}`);
    if (topics.includes('price')) { if (inv) add('monthly_income', 'رقم بالريال'); else { add('market_price', 'رقم بالريال لمتوسط سعر الوحدة'); add('price_min', 'رقم'); add('price_max', 'رقم'); } }
    if (topics.includes('volume') && !inv) { add('monthly_volume', 'عدد الوحدات شهرياً'); add('growth_pct', 'نسبة النمو الشهري'); }
    if (topics.includes('costs')) { if (inv) add('monthly_opex', 'رقم بالريال'); else { add('materials_per_unit', 'رقم'); add('labor_per_unit', 'رقم'); add('other_per_unit', 'رقم'); } }
    if (topics.includes('fixed')) { add('fixed_monthly', '[{"name": "البند", "amount": رقم}]'); add('capex', '[{"name": "البند", "amount": رقم}]'); }
    if (topics.includes('scen')) add('scenarios', '{"optimistic": {"price": نسبة, "volume": نسبة, "cost": نسبة}, "realistic": {...}, "pessimistic": {...}}');
    if (topics.includes('risks')) { add('risks', '["خطر 1", "خطر 2"]'); add('recommendations', '["توصية 1"]'); }
    if (topics.includes('narrative')) add('narrative', '"نص الدراسة بالعربي: الملخص، السوق، المنافسة، التكاليف، الخلاصة"');
    L.push('', 'مهم: أرجع ردك كاملاً في كتلة JSON واحدة داخل ```json بالمفاتيح التالية فقط. الأرقام بالريال بدون فواصل أو عملة، والنِّسب أرقام فقط (مثل -10). أي مفتاح لا تعرفه اجعله null:', '```json', '{', keys.join(',\n'), '}', '```');
    return L.filter((x, i) => x !== '' || L[i - 1] !== '').join('\n');
  };
  const aiOut = (pre = ['price', 'risks']) => {
    const form = drawer('تصدير للذكاء الاصطناعي', `<p class="help" style="margin:0">انسخ النص والصقه في ChatGPT أو Claude أو Gemini من حسابك — مجاناً. ثم الصق رده هنا عبر «استيراد رد الذكاء الاصطناعي».</p>
      <fieldset><legend>وش تبي منه؟</legend>${TOPICS.map(([k, t]) => `<label class="row" style="gap:8px"><input type="checkbox" name="t_${k}" ${pre.includes(k) ? 'checked' : ''}> ${t}</label>`).join('')}</fieldset>
      <label class="row" style="gap:8px"><input type="checkbox" name="anon" checked> إخفاء اسم الشركة وأسماء المشاريع (يُرسل الوصف والأرقام فقط)</label>
      <div class="field"><label for="aitxt">النص الجاهز</label><textarea class="input num" id="aitxt" rows="12" readonly style="height:auto;padding:8px 12px;font-size:12px;direction:rtl"></textarea></div>
      <button type="button" class="btn secondary" id="aidl">${icon('down')}تحميل كملف</button>`, async () => {
      const t = $('#aitxt', form).value; try { await navigator.clipboard.writeText(t); toast('نُسخ النص — الصقه في برنامج الذكاء الاصطناعي'); } catch { $('#aitxt', form).select(); document.execCommand?.('copy'); toast('نُسخ النص'); } }, 'نسخ النص');
    const gen = () => { const topics = TOPICS.map(([k]) => k).filter(k => $(`[name=t_${k}]`, form).checked); $('#aitxt', form).value = prompt(topics.length ? topics : ['price'], $('[name=anon]', form).checked); };
    form.addEventListener('change', gen); gen();
    $('#aidl', form).onclick = () => { const b = new Blob([$('#aitxt', form).value], { type: 'text/markdown;charset=utf-8' }), a = document.createElement('a');
      a.href = URL.createObjectURL(b); a.download = `دراسة-جدوى-${(I.desc || name).slice(0, 30).replace(/[\\/:*?"<>|]/g, '')}.md`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
  };
  const parseAI = txt => { const m = txt.match(/```(?:json)?\s*([\s\S]*?)```/i); let raw = m ? m[1] : txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1);
    try { const j = JSON.parse(raw.trim()); if (!j || typeof j !== 'object' || Array.isArray(j)) return null; return { j, rest: m ? txt.replace(m[0], '').trim() : '' }; } catch { return null; } };
  const aiIn = () => {
    let P = null;
    const form = drawer('استيراد رد الذكاء الاصطناعي', `<p class="help" style="margin:0">الصق رد الذكاء الاصطناعي كاملاً، أو ارفع ملفه. ستراجع كل اقتراح قبل تطبيقه — لا يتغيّر أي رقم بدون موافقتك.</p>
      <div class="field"><label for="aiin-t">الرد</label><textarea class="input" id="aiin-t" rows="7" style="height:auto;padding:8px 12px;font-size:12px" placeholder="الصق هنا…"></textarea></div>
      <div class="row" style="gap:8px;flex-wrap:wrap"><input type="file" id="aiin-f" accept=".json,.txt,.md,text/plain,application/json" aria-label="ملف الرد"><button type="button" class="btn secondary sm" id="aiin-r">قراءة الرد</button></div>
      <div id="aiin-p"></div>`, async () => {
      if (!P) throw new Error('اضغط «قراءة الرد» أولاً');
      let n = 0; const ref = 'اقتراح الذكاء الاصطناعي';
      for (const x of P.nums) if ($(`[name=a_${x.k}]`, form)?.checked) { I[x.k] = fsN(x.v, 'ai', x.ref || ref); n++; }
      for (const w of ['fixed', 'capex']) if (P[w] && $(`[name=a_${w}]`, form)?.checked) { I[w] = P[w].map(r => ({ ...r, src: 'ai', ref })); n++; }
      if (P.scen && $('[name=a_scen]', form)?.checked) { Object.assign(I.scen, P.scen); n++; }
      if (P.notes && $('[name=a_notes]', form)?.checked) { notes = P.notes; n++; }
      if (!n) throw new Error('لم تختر أي اقتراح');
      touch(); draw(); toast(`طُبّق ${n} اقتراح من الذكاء الاصطناعي`); }, 'تطبيق المحدد');
    $('#aiin-f', form).onchange = e => { const f = e.target.files[0]; if (!f) return; if (f.size > 200 * 1024) { toast('الملف أكبر من 200 كيلوبايت', 'bad'); return; } f.text().then(t => { $('#aiin-t', form).value = t; read(); }); };
    const read = () => { const r = parseAI($('#aiin-t', form).value || ''), box = $('#aiin-p', form);
      if (!r) { P = null; box.innerHTML = '<p class="help err">ما قدرت أقرأ JSON من الرد. تأكد إنك نسخت الرد كاملاً مع كتلة ```json.</p>'; return; }
      const j = r.j, mn = x => { const n = fsNum(x); return n != null && n >= 0 && n < 1e10 ? n : null; }, pc = x => { const n = fsNum(x); return n != null && n > -100 && n < 1000 ? n : null; };
      const M = inv ? [['monthly_income', 'income', 'العائد الشهري'], ['monthly_opex', 'opex', 'تكاليف التشغيل']] : [['market_price', 'market_price', 'سعر السوق'], ['monthly_volume', 'volume', 'الكمية الشهرية'], ['materials_per_unit', 'materials', 'المواد للوحدة'], ['labor_per_unit', 'labor', 'العمالة للوحدة'], ['other_per_unit', 'other_var', 'تكاليف أخرى للوحدة']];
      P = { nums: [] };
      for (const [jk, k, t] of M) { const v = mn(j[jk]); if (v == null) continue; const isQty = k === 'volume';
        P.nums.push({ k, t, v: isQty ? v : Math.round(v * 100), cur: I[k].v, qty: isQty, ref: k === 'market_price' && mn(j.price_min) != null && mn(j.price_max) != null ? `النطاق المقترح ${fq(mn(j.price_min))} إلى ${fq(mn(j.price_max))} ريال` : null }); }
      if (pc(j.growth_pct) != null) P.nums.push({ k: 'growth', t: 'النمو الشهري ٪', v: pc(j.growth_pct), cur: I.growth.v, pct: true });
      const arr = a => Array.isArray(a) ? a.filter(x => x && typeof x === 'object').slice(0, 20).map(x => ({ name: String(x.name || 'بند').slice(0, 120), v: Math.round((mn(x.amount) ?? 0) * 100) })).filter(x => x.v > 0) : null;
      P.fixed = arr(j.fixed_monthly); P.capex = arr(j.capex); if (!P.fixed?.length) P.fixed = null; if (!P.capex?.length) P.capex = null;
      if (j.scenarios && typeof j.scenarios === 'object') { const sc = {}; for (const [jk, k] of [['optimistic', 'opt'], ['realistic', 'real'], ['pessimistic', 'pess']]) { const o = j.scenarios[jk]; if (o && typeof o === 'object') sc[k] = { price: pc(o.price) ?? 0, volume: pc(o.volume) ?? 0, cost: pc(o.cost) ?? 0 }; } if (Object.keys(sc).length) P.scen = sc; }
      const list = (t, a) => Array.isArray(a) && a.length ? `\n\n${t}:\n` + a.slice(0, 15).map(x => '- ' + String(x).slice(0, 400)).join('\n') : '';
      const nar = typeof j.narrative === 'string' && j.narrative.trim() ? j.narrative.trim() : r.rest;
      P.notes = ((nar || '') + list('المخاطر', j.risks) + list('التوصيات', j.recommendations)).trim().slice(0, 38000) || null;
      const fmt = x => x.pct ? x.v + '٪' : x.qty ? fq(x.v) + ' وحدة' : money(x.v), fc = x => x.pct ? x.cur + '٪' : x.qty ? fq(x.cur) : money(x.cur);
      const any = P.nums.length || P.fixed || P.capex || P.scen || P.notes;
      box.innerHTML = any ? `<h4 style="margin:4px 0">الاقتراحات</h4><div class="tbl-wrap"><table class="list-tbl"><thead><tr><th></th><th>البند</th><th class="amt">الحالي</th><th class="amt">المقترح</th></tr></thead><tbody>
        ${P.nums.map(x => `<tr><td><input type="checkbox" name="a_${x.k}" checked aria-label="${x.t}"></td><td>${x.t}${x.ref ? `<br><span class="xs muted">${esc(x.ref)}</span>` : ''}</td><td class="amt num">${fc(x)}</td><td class="amt num"><b>${fmt(x)}</b></td></tr>`).join('')}
        ${['fixed', 'capex'].filter(w => P[w]).map(w => `<tr><td><input type="checkbox" name="a_${w}" aria-label="${w}"></td><td>استبدال ${w === 'fixed' ? 'التكاليف الثابتة' : 'الاستثمار المبدئي'} بـ ${P[w].length} بنود<br><span class="xs muted">${esc(P[w].map(r => r.name).join('، '))}</span></td><td class="amt num">${money(fsSum(I[w]))}</td><td class="amt num"><b>${money(fsSum(P[w]))}</b></td></tr>`).join('')}
        ${P.scen ? `<tr><td><input type="checkbox" name="a_scen" aria-label="السيناريوهات"></td><td>نسب السيناريوهات</td><td></td><td class="xs">${Object.entries(P.scen).map(([k, o]) => `${FS_SCEN.find(x => x[0] === k)[1]}: ${o.price}/${o.volume}/${o.cost}`).join(' · ')}</td></tr>` : ''}
        ${P.notes ? `<tr><td><input type="checkbox" name="a_notes" checked aria-label="التحليل المكتوب"></td><td colspan="3">حفظ التحليل المكتوب في الدراسة (${P.notes.length.toLocaleString('en-US')} حرف)${notes ? ' — يستبدل الحالي' : ''}</td></tr>` : ''}</tbody></table></div>` : '<p class="muted">الرد ما فيه أرقام أو نص يمكن استخدامه.</p>';
      if (!any) P = null; };
    $('#aiin-r', form).onclick = read;
  };

  draw();
}

// ---------- printed report (uses the company's invoice design) ----------
async function studyPrintView(id) {
  shell('feasibility', loading());
  const s = await api.getStudy(id), I = fsInputs(s), inv = s.kind === 'investment', R = fsAll(I, s.kind), r = R.real, v = fsVerdict(r, R.pess);
  const src = o => `<span class="xs">${FS_SRC[o.src] || 'يدوي'}${o.ref ? ' — ' + esc(o.ref) : ''}</span>`;
  const line = (t, o, fmt = money) => `<tr><td>${t}</td><td class="amt num">${fmt(o.v)}</td><td>${src(o)}</td></tr>`;
  const years = []; for (let y = 0; y < Math.ceil(r.flows.length / 12); y++) { const fl = r.flows.slice(y * 12, y * 12 + 12); years.push({ y: y + 1, R: fl.reduce((a, f) => a + f.R, 0), C: fl.reduce((a, f) => a + f.V + f.F, 0), net: fl.reduce((a, f) => a + f.net, 0), cum: fl.at(-1).cum }); }
  $('#main').innerHTML = `<div class="no-print"><a class="crumb" href="#/feasibility/${esc(id)}">${icon('chev')} ${esc(s.name)}</a><div class="page-head"><h1>تقرير دراسة الجدوى</h1><button class="btn primary" onclick="window.print()">${icon('down')}طباعة / PDF</button></div></div>
  <article class="paper fs-paper"><div class="hd"><div>${ORG.logo_path ? `<img src="${esc(ORG.logo_path)}" alt="الشعار" style="max-height:56px;max-width:160px;display:block;margin-bottom:8px">` : ''}<b style="font-size:18px">${esc(ORG.name_ar)}</b>${ORG.cr_number ? `<br>س.ت: <span class="num">${esc(ORG.cr_number)}</span>` : ''}</div>
    <div style="text-align:end"><b style="font-size:18px">دراسة جدوى</b><br>${esc(s.name)}<br>التاريخ: <span class="num">${riyadhToday()}</span><br>${badge(FS_STATUS[s.status] || FS_STATUS.draft)}</div></div>
    ${I.desc ? `<p><b>الوصف:</b> ${esc(I.desc)}</p>` : ''}${I.market ? `<p><b>السوق المستهدف:</b> ${esc(I.market)}</p>` : ''}
    <h3>الخلاصة: ${esc(v[0])}</h3><p>${esc(v[2])}</p>
    <table><tbody>${inv ? '' : `<tr><td>سعر البيع المعتمد</td><td class="amt num">${money(r.price)}</td></tr><tr><td>تكلفة الوحدة</td><td class="amt num">${money(r.unit)}</td></tr><tr><td>هامش الوحدة</td><td class="amt num">${money(r.contribution)} (${fsPct(r.cm)})</td></tr>
      <tr><td>نقطة التعادل</td><td class="amt num">${r.be == null ? (r.beNever ? 'لا تتحقق' : '—') : r.be.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' وحدة شهرياً'}</td></tr>`}
      <tr><td>صافي ربح الشهر الأول</td><td class="amt num">${money(r.m1.R - r.m1.V - r.m1.F)}</td></tr><tr><td>الاستثمار المبدئي</td><td class="amt num">${money(r.capex)}</td></tr><tr><td>مدة الاسترداد</td><td class="amt">${fsMonths(r.payback)}</td></tr>
      <tr><td>صافي القيمة الحالية (خصم ${I.discount}٪، ${r.N} شهر)</td><td class="amt num">${money(r.npv)}</td></tr><tr><td>معدل العائد الداخلي السنوي</td><td class="amt num">${r.irr == null ? '—' : fsPct(r.irr)}</td></tr><tr><td>العائد على الاستثمار</td><td class="amt num">${r.roi == null ? '—' : fsPct(r.roi)}</td></tr></tbody></table>
    <h3>السيناريوهات</h3><table><thead><tr><th></th>${FS_SCEN.map(([k, t]) => `<th>${t}<br><span class="xs">${I.scen[k].price}٪ / ${I.scen[k].volume}٪ / ${I.scen[k].cost}٪</span></th>`).join('')}</tr></thead><tbody>
      ${[['ربح الشهر الأول', x => money(x.m1.R - x.m1.V - x.m1.F)], ['الاسترداد', x => fsMonths(x.payback)], ['صافي القيمة الحالية', x => money(x.npv)], ['العائد الداخلي', x => x.irr == null ? '—' : fsPct(x.irr)]].map(([t, f]) => `<tr><td>${t}</td>${FS_SCEN.map(([k]) => `<td class="num">${f(R[k])}</td>`).join('')}</tr>`).join('')}</tbody></table>
    <p class="xs">نسب السيناريو: السعر / الكمية / التكاليف مقارنة بالأرقام الأساسية.</p>
    <div class="fs-print-chart">${fsChart(R)}</div>
    <h3>الافتراضات ومصدر كل رقم</h3><table><thead><tr><th>البند</th><th class="amt">القيمة (ر.س)</th><th>المصدر</th></tr></thead><tbody>
      ${inv ? line('العائد أو التوفير الشهري', I.income) + line('تكاليف التشغيل الشهرية', I.opex)
        : line('سعري المقترح للوحدة', I.my_price) + line('متوسط سعر السوق', I.market_price) + line('الكمية الشهرية', I.volume, fq) + line('المواد للوحدة', I.materials) + line('العمالة للوحدة', I.labor) + line('تكاليف أخرى للوحدة', I.other_var)}
      ${line('النمو الشهري ٪', I.growth, x => x + '٪')}
      ${I.fixed.map(x => line('ثابت شهري: ' + esc(x.name), x)).join('')}${I.capex.map(x => line('استثمار: ' + esc(x.name), x)).join('')}${I.salvage.v ? line('القيمة المتبقية', I.salvage) : ''}
      <tr><td>مدة الدراسة</td><td class="amt num">${I.months} شهر</td><td></td></tr><tr><td>معدل الخصم السنوي</td><td class="amt num">${I.discount}٪</td><td></td></tr><tr><td>الزكاة أو الضريبة</td><td class="amt num">${I.zakat}٪</td><td></td></tr></tbody></table>
    <h3>التدفق النقدي السنوي (الواقعي)</h3><table><thead><tr><th>السنة</th><th class="amt">الإيرادات</th><th class="amt">التكاليف</th><th class="amt">الصافي</th><th class="amt">التراكمي</th></tr></thead><tbody>
      ${years.map(y => `<tr><td class="num">${y.y}</td><td class="amt num">${money(y.R)}</td><td class="amt num">${money(y.C)}</td><td class="amt num">${money(y.net)}</td><td class="amt num">${money(y.cum)}</td></tr>`).join('')}</tbody></table>
    ${s.ai_notes ? `<h3>التحليل المكتوب</h3><p class="xs">أُعد بمساعدة الذكاء الاصطناعي وراجعته الإدارة.</p><div class="fs-notes">${esc(s.ai_notes).replace(/\n/g, '<br>')}</div>` : ''}
  </article>`;
}

const FEAS_ROUTES = [
  [/^#\/feasibility$/, gate('feasibility', 'دراسات الجدوى', 'feasibility', feasibilityView)],
  [/^#\/feasibility\/([\w-]+)\/print$/, m => gate('feasibility', 'دراسات الجدوى', 'feasibility', studyPrintView)(m[1])],
  [/^#\/feasibility\/([\w-]+)$/, m => gate('feasibility', 'دراسات الجدوى', 'feasibility', studyView)(m[1])],
];
window.__fs = { fsDefaults, feasCalc };   // exposed for the formula tests
