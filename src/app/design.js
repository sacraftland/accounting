// =====================================================================
// Printed-invoice design (templates, colors, logo, stamp, signature, bank
// details, terms) and the workshop display screen. Inserted after theme.js.
// =====================================================================
const INV_DEFAULT = { template: 'classic', color: 'brand', show_logo: true, logo_pos: 'start', show_stamp: true, show_signature: true, signer_name: '', signer_title: '', bank_name: '', iban: '', account_name: '', terms: '' };
const invSet = () => ({ ...INV_DEFAULT, ...(ORG?.invoice_settings || {}) });

// style every printed document (.paper) by the company's design
function decoratePaper(el, s = invSet(), o = ORG) {
  if (!o || el.dataset.deco === '1') return; el.dataset.deco = '1';
  const brand = hex2rgb(o.brand_color) ? o.brand_color : '#4f6b3a', pa = s.color === 'black' ? '#111111' : brand;
  el.classList.add('tpl-' + s.template); if (!s.show_logo) el.classList.add('nologo'); if (s.logo_pos === 'center') el.classList.add('logo-center');
  el.style.setProperty('--pa', pa); el.style.setProperty('--pa-soft', mix(pa, '#ffffff', 0.88)); el.style.setProperty('--pa-on', contrast(pa, '#ffffff') >= 4.5 ? '#ffffff' : '#111111');
  const bank = [s.bank_name && `<div>البنك: <b>${esc(s.bank_name)}</b></div>`, s.account_name && `<div>اسم الحساب: ${esc(s.account_name)}</div>`, s.iban && `<div>الآيبان: <span class="num" dir="ltr">${esc(s.iban)}</span></div>`].filter(Boolean).join('');
  const stamp = s.show_stamp && o.stamp_path ? `<img class="p-stamp" src="${esc(o.stamp_path)}" alt="ختم ${esc(o.name_ar)}">` : '';
  const sig = s.show_signature && (o.signature_path || s.signer_name) ? `<div class="p-sig">${o.signature_path ? `<img src="${esc(o.signature_path)}" alt="التوقيع">` : '<div style="height:40px"></div>'}<div class="p-sigline">${esc(s.signer_name || '')}${s.signer_title ? `<br><span>${esc(s.signer_title)}</span>` : ''}</div></div>` : '';
  if (!bank && !s.terms && !stamp && !sig) return;
  el.insertAdjacentHTML('beforeend', `<div class="paper-extra">${bank || s.terms ? `<div class="p-info">${bank ? `<div class="p-bank"><b>بيانات التحويل البنكي</b>${bank}</div>` : ''}${s.terms ? `<div class="p-terms"><b>الشروط والأحكام</b><div>${esc(s.terms).replace(/\n/g, '<br>')}</div></div>` : ''}</div>` : '<div></div>'}
    ${stamp || sig ? `<div class="p-sign">${stamp}${sig}</div>` : ''}</div>`);
}
new MutationObserver(ms => { if (!ORG) return; for (const m of ms) for (const n of m.addedNodes) { if (n.nodeType !== 1) continue; if (n.matches?.('.paper')) decoratePaper(n); n.querySelectorAll?.('.paper').forEach(p => decoratePaper(p)); } })
  .observe(document.documentElement, { childList: true, subtree: true });

const samplePaper = () => `<article class="paper" aria-label="معاينة الفاتورة"><div class="hd"><div>${ORG.logo_path ? `<img src="${esc(ORG.logo_path)}" alt="الشعار" style="max-height:56px;max-width:160px;display:block;margin-bottom:8px">` : ''}
    <b style="font-size:18px">${esc(ORG.name_ar)}</b><br>${ORG.vat_number ? `الرقم الضريبي: <span class="num">${esc(ORG.vat_number)}</span><br>` : ''}${esc([ORG.street, ORG.city].filter(Boolean).join('، '))}</div>
    <div style="text-align:end"><b style="font-size:18px">فاتورة ضريبية<br>Tax Invoice</b><br>رقم الفاتورة: <span class="num">INV-00025</span><br>التاريخ: <span class="num">${riyadhToday()}</span></div></div>
  <p style="margin:0 0 12px"><b>العميل:</b> مؤسسة البر للرحلات — الرقم الضريبي <span class="num">311111111111113</span></p>
  <table><thead><tr><th>#</th><th>الوصف</th><th>الكمية</th><th class="amt">السعر</th><th class="amt">الضريبة</th><th class="amt">الإجمالي</th></tr></thead><tbody>
    <tr><td class="num">1</td><td>كرفان 8 متر كامل التجهيز</td><td class="num">1</td><td class="amt num">60,000.00</td><td class="amt num">9,000.00</td><td class="amt num">69,000.00</td></tr>
    <tr><td class="num">2</td><td>تركيب ونقل</td><td class="num">1</td><td class="amt num">1,500.00</td><td class="amt num">225.00</td><td class="amt num">1,725.00</td></tr></tbody></table>
  <div style="display:flex;justify-content:flex-end;margin-top:16px"><div style="width:min(300px,100%)"><div style="display:flex;justify-content:space-between">الإجمالي قبل الضريبة<span class="num">61,500.00</span></div>
    <div style="display:flex;justify-content:space-between">ضريبة القيمة المضافة<span class="num">9,225.00</span></div><div class="p-total" style="display:flex;justify-content:space-between;font-weight:700;margin-top:6px;padding-top:6px">الإجمالي (ر.س)<span class="num">70,725.00</span></div></div></div>
  ${ORG.invoice_footer ? `<p class="xs" style="margin-top:12px">${esc(ORG.invoice_footer)}</p>` : ''}</article>`;

async function invoiceDesignView() {
  shell('invoice-design', loading()); if (!can('settings', 'create')) { location.hash = '#/settings'; return; }
  const s = invSet(); let stamp = ORG.stamp_path || null, sig = ORG.signature_path || null;
  const T = [['classic', 'كلاسيكي', 'خطوط واضحة وترويسة بسيطة'], ['modern', 'عصري', 'ترويسة ملوّنة بلون الشركة'], ['minimal', 'هادئ', 'بدون إطار، خطوط خفيفة']];
  const ck = (n, l, v) => `<label class="row" style="gap:8px"><input type="checkbox" name="${n}" ${v ? 'checked' : ''}> ${l}</label>`;
  const img = (id, label, src, help) => `<div class="field"><span class="lbl">${label}</span><div class="row" style="gap:10px;align-items:center"><div class="logo-prev" id="${id}p">${src ? `<img src="${esc(src)}" alt="${label}">` : icon('file')}</div>
    <div><input type="file" id="${id}" accept="image/png,image/jpeg,image/svg+xml" aria-label="${label}"><p class="help">${help}</p>${src ? `<button type="button" class="btn ghost sm" id="${id}x">إزالة</button>` : ''}</div></div></div>`;
  $('#main').innerHTML = `<a class="crumb" href="#/settings">${icon('chev')} الإعدادات</a><div class="page-head"><h1>تصميم الفاتورة المطبوعة</h1></div>
    <p class="muted" style="margin:-8px 0 16px">يطبَّق على كل المستندات المطبوعة: الفواتير، عروض الأسعار، سندات التسليم، الإشعارات وأوامر الشراء.</p>
    <div class="grid g2" style="align-items:start;grid-template-columns:minmax(300px,420px) 1fr"><form class="card grid" id="idf" style="gap:16px" novalidate>
      <div class="field"><span class="lbl">القالب</span><div class="ptype-pick">${T.map(([k, t, d]) => `<label class="ptype ${s.template === k ? 'on' : ''}"><input type="radio" name="template" value="${k}" ${s.template === k ? 'checked' : ''}><b>${t}</b><span class="xs muted">${d}</span></label>`).join('')}</div></div>
      <div class="field"><span class="lbl">لون الفاتورة</span><div class="seg">${[['brand', 'لون الشركة'], ['black', 'أسود']].map(([k, t]) => `<label class="${s.color === k ? 'on' : ''}"><input type="radio" name="color" value="${k}" ${s.color === k ? 'checked' : ''}>${t}</label>`).join('')}</div>
        <span class="help">لون الشركة يُغيَّر من «المظهر ← لون الشركة الافتراضي».</span></div>
      <fieldset><legend>الشعار</legend>${ck('show_logo', 'إظهار الشعار', s.show_logo)}<div class="seg" style="margin-top:6px">${[['start', 'في الجانب'], ['center', 'في المنتصف']].map(([k, t]) => `<label class="${s.logo_pos === k ? 'on' : ''}"><input type="radio" name="logo_pos" value="${k}" ${s.logo_pos === k ? 'checked' : ''}>${t}</label>`).join('')}</div>
        ${!ORG.logo_path ? '<p class="help">لم يُرفع شعار بعد — ارفعه من <a href="#/settings">الإعدادات</a>.</p>' : ''}</fieldset>
      <fieldset><legend>الختم والتوقيع</legend>${ck('show_stamp', 'إظهار الختم', s.show_stamp)}${img('stampf', 'صورة الختم', stamp, 'PNG بخلفية شفافة يفضَّل، حتى 300 كيلوبايت')}
        ${ck('show_signature', 'إظهار التوقيع', s.show_signature)}${img('sigf', 'صورة التوقيع', sig, 'وقّع على ورقة بيضاء وصوّرها، أو ارفع PNG شفاف')}
        <div class="form-grid">${field('signer_name', 'اسم المفوَّض بالتوقيع', { value: s.signer_name })}${field('signer_title', 'المسمى', { value: s.signer_title, help: 'مثل: المدير العام' })}</div></fieldset>
      <fieldset><legend>بيانات التحويل البنكي</legend><div class="form-grid">${field('bank_name', 'البنك', { value: s.bank_name, help: 'مثل: مصرف الراجحي' })}${field('account_name', 'اسم الحساب', { value: s.account_name })}</div>
        ${field('iban', 'الآيبان', { value: s.iban, attrs: 'dir="ltr" maxlength="34" placeholder="SA…"' })}</fieldset>
      <div class="field"><label for="f-terms">الشروط والأحكام</label><textarea class="input" id="f-terms" name="terms" rows="4" style="height:auto;padding:8px 12px" placeholder="مثل: الدفعة المقدمة 50% غير مستردة — مدة التنفيذ 30 يوماً من تاريخ الاعتماد — الضمان سنة على الهيكل">${esc(s.terms)}</textarea></div>
      <p class="help err" id="iderr" role="alert"></p><div class="row" style="justify-content:flex-end"><button class="btn primary" type="submit">حفظ التصميم</button></div></form>
      <section aria-label="معاينة"><div class="row" style="justify-content:space-between;margin-bottom:8px"><h3 style="margin:0">معاينة</h3><span class="xs muted">تتحدث مع كل تغيير</span></div><div id="idprev"></div></section></div>`;
  const collect = () => { const f = new FormData($('#idf')); return { template: f.get('template'), color: f.get('color'), logo_pos: f.get('logo_pos'), show_logo: !!f.get('show_logo'), show_stamp: !!f.get('show_stamp'), show_signature: !!f.get('show_signature'),
    signer_name: (f.get('signer_name') || '').trim(), signer_title: (f.get('signer_title') || '').trim(), bank_name: (f.get('bank_name') || '').trim(), account_name: (f.get('account_name') || '').trim(), iban: toLatin(f.get('iban') || '').replace(/\s/g, '').toUpperCase(), terms: (f.get('terms') || '').trim() }; };
  const prev = () => { $$('#idf .ptype, #idf .seg label').forEach(l => l.classList.toggle('on', !!$('input', l)?.checked)); $('#idprev').innerHTML = samplePaper(); const p = $('#idprev .paper'); p.dataset.deco = ''; decoratePaper(p, collect(), { ...ORG, stamp_path: stamp, signature_path: sig }); };
  $('#idf').addEventListener('input', prev); $('#idf').addEventListener('change', prev);
  const upload = (id, set) => { $('#' + id).onchange = e => { const file = e.target.files[0]; if (!file) return; if (file.size > 300 * 1024) { toast('الملف أكبر من 300 كيلوبايت', 'bad'); e.target.value = ''; return; }
    const r = new FileReader(); r.onload = () => { set(r.result); $('#' + id + 'p').innerHTML = `<img src="${esc(r.result)}" alt="">`; prev(); }; r.readAsDataURL(file); };
    if ($('#' + id + 'x')) $('#' + id + 'x').onclick = () => { set(null); $('#' + id + 'p').innerHTML = icon('file'); prev(); }; };
  upload('stampf', v => stamp = v); upload('sigf', v => sig = v);
  $('#idf').onsubmit = async e => { e.preventDefault(); const v = collect(); $('#iderr').textContent = '';
    if (v.iban && !/^SA\d{22}$/.test(v.iban)) return $('#iderr').textContent = 'الآيبان السعودي يبدأ بـ SA ويتكون من 24 خانة';
    $('[type=submit]', e.target).disabled = true;
    try { ORG = await api.updateOrg({ invoice_settings: v, stamp_path: stamp, signature_path: sig }); toast('حُفظ تصميم الفاتورة'); } catch (x) { $('#iderr').textContent = x.message; } finally { $('[type=submit]', e.target).disabled = false; } };
  prev();
}

// ---------- workshop display (TV) ----------
let DISPLAY_TIMER = null;
async function displayView() {
  clearInterval(DISPLAY_TIMER);
  const draw = async () => {
    if (!location.hash.startsWith('#/display')) { clearInterval(DISPLAY_TIMER); return; }
    const today = riyadhToday(), [ts, ccs, ws] = await Promise.all([api.listTasks().catch(() => []), api.listCostCenters().catch(() => []), api.listWorkers().catch(() => [])]);
    const W = Object.fromEntries(ws.map(w => [w.id, w.full_name])), C = Object.fromEntries(ccs.map(c => [c.id, c]));
    const open = ts.filter(t => t.status !== 'done' && !C[t.cost_center_id]?.is_template), late = open.filter(t => t.due_date && t.due_date < today), now = open.filter(t => !late.includes(t) && (t.status === 'doing' || (t.start_date && t.start_date <= today) || t.due_date === today));
    const pj = ccs.filter(c => c.status === 'active' && c.project_type !== 'internal');
    const prog = c => { const t = ts.filter(x => x.cost_center_id === c.id); return t.length ? Math.round(t.filter(x => x.status === 'done').length / t.length * 100) : 0; };
    const task = (t, cls) => `<li class="${cls}"><b>${esc(t.title)}</b><span>${esc(C[t.cost_center_id]?.name || '')}</span><span class="w">${esc((t.employee_ids || []).map(e => W[e]).filter(Boolean).join('، ') || '—')}</span>${t.due_date ? `<span class="d num">${esc(t.due_date)}</span>` : ''}</li>`;
    let hijri = ''; try { hijri = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date()); } catch { hijri = ''; }
    $('#app').innerHTML = `<div class="tv"><header><div class="row" style="gap:14px;align-items:center">${ORG?.logo_path ? `<img src="${esc(ORG.logo_path)}" alt="">` : ''}<h1>${esc(ORG?.name_ar || '')} — لوحة الورشة</h1></div>
        <div class="tv-clock"><b class="num" id="tvclock"></b><span>${esc(hijri)} · <span class="num">${today}</span></span></div>
        <div class="tv-ctl"><button class="btn secondary sm" id="tvfull">ملء الشاشة</button><a class="btn ghost sm" href="#/dashboard">خروج</a></div></header>
      <main class="tv-grid"><section><h2>المهام <span class="num">${now.length + late.length}</span></h2><ul class="tv-tasks">${late.map(t => task(t, 'late')).join('')}${now.map(t => task(t, t.status === 'doing' ? 'doing' : '')).join('') || (late.length ? '' : '<li class="empty">لا توجد مهام لليوم ✓</li>')}</ul></section>
        <section><h2>المشاريع <span class="num">${pj.length}</span></h2><ul class="tv-proj">${pj.map(c => { const p = prog(c), d = c.due_date ? daysTo(c.due_date) : null; return `<li><div class="row" style="justify-content:space-between"><b>${esc(c.name)}</b><span class="num ${d != null && d < 0 ? 'late' : ''}">${d == null ? '' : d < 0 ? `متأخر ${-d} يوم` : `باقي ${d} يوم`}</span></div>
          <div class="tv-bar"><i style="width:${p}%"></i></div><span class="num">${p}%</span></li>`; }).join('') || '<li class="empty">لا توجد مشاريع نشطة</li>'}</ul></section></main>
      <footer>يتحدث تلقائياً كل دقيقة · آخر تحديث <span class="num">${new Date().toLocaleTimeString('ar-SA-u-nu-latn', { hour: '2-digit', minute: '2-digit' })}</span></footer></div>`;
    const tick = () => { const el = $('#tvclock'); if (el) el.textContent = new Date().toLocaleTimeString('ar-SA-u-nu-latn', { hour: '2-digit', minute: '2-digit' }); }; tick();
    $('#tvfull').onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.().catch(() => toast('المتصفح لا يسمح بملء الشاشة', 'warn'));
  };
  await draw(); DISPLAY_TIMER = setInterval(() => draw().catch(() => {}), 60000);
}

const DESIGN_ROUTES = [
  [/^#\/invoice-design$/, gate('invoice-design', 'تصميم الفاتورة', 'settings', invoiceDesignView)],
  [/^#\/display$/, gate('display', 'لوحة الورشة', 'accounting|manufacturing|hr|inventory', displayView)],
];
