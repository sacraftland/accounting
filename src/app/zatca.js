// ---------- ZATCA phase 2: link with Fatoora (Edge Function "zatca") ----------
const ZENV = { sandbox: 'بيئة المطورين (تجريبية)', simulation: 'بيئة المحاكاة', production: 'الإنتاج (الربط الفعلي)' };
const zChecks = list => `<table class="table" style="margin-top:8px"><thead><tr><th>المستند</th><th>النتيجة</th><th>ملاحظات الهيئة</th></tr></thead><tbody>${(list || []).map(c =>
  `<tr><td>${esc(c.name)}</td><td>${badge(c.errors?.length ? ['مرفوض', 'b-danger'] : c.warnings?.length ? ['مقبول مع ملاحظات', 'b-warn'] : ['مقبول', 'b-ok'])}</td>
   <td class="xs">${esc([...(c.errors || []), ...(c.warnings || [])].join(' — ') || '—')}</td></tr>`).join('')}</tbody></table>`;

async function zatcaView() {
  shell('zatca', loading());
  const owner = !!ORG._owner, [{ devices }, branches] = await Promise.all([api.zatca('devices').catch(() => ({ devices: [] })), api.listBranches()]);
  const live = devices.find(d => d.environment === 'production' && d.status === 'production');
  const bname = id => (branches.find(b => b.id === id) || {}).name || '—';
  $('#main').innerHTML = `<div class="page-head"><h1>الربط مع هيئة الزكاة (المرحلة الثانية)</h1></div>
    <section class="card" style="margin-bottom:16px"><h3 style="margin:0 0 6px">الحالة</h3>
      <p style="margin:0">${live ? badge(['مربوط فعلياً مع منصة فاتورة', 'b-ok']) : devices.length ? badge(['مربوط تجريبياً فقط', 'b-info']) : badge(['غير مربوط', 'b-draft'])}</p>
      <p class="muted" style="margin:8px 0 0">الفواتير الضريبية (B2B) تُعتمد من الهيئة قبل تسليمها للعميل، والمبسطة (B2C) تُبلَّغ خلال 24 ساعة. مفتاح التوقيع محفوظ في الخادم فقط ولا يظهر في المتصفح ولا في النسخ الاحتياطية.</p></section>
    <section class="card" style="margin-bottom:16px"><h3 style="margin:0 0 6px">اختبار الربط</h3>
      <p class="muted" style="margin:0 0 10px">يجرب مع بيئة المطورين عند الهيئة: يطلب شهادة تجريبية ويرسل 6 مستندات (ضريبية ومبسطة ودائن ومدين) ويعرض رد الهيئة. لا يحفظ شيئاً ولا يمس بياناتك.</p>
      <button class="btn secondary" id="zst">${icon('check')}اختبار الربط الآن</button><div id="zstr"></div></section>
    <section class="card" style="margin-bottom:16px"><h3 style="margin:0 0 6px">الأجهزة المربوطة</h3>
      ${devices.length ? `<table class="table"><thead><tr><th>الفرع</th><th>البيئة</th><th>عدد الفواتير</th><th>آخر خطأ</th><th>منذ</th></tr></thead><tbody>${devices.map(d =>
        `<tr><td>${esc(bname(d.branch_id))}</td><td>${esc(ZENV[d.environment] || d.environment)}</td><td class="num">${d.last_icv}</td><td class="xs">${esc((d.last_error || '—').slice(0, 120))}</td><td class="num">${esc(String(d.created_at).slice(0, 10))}</td></tr>`).join('')}</tbody></table>` : '<p class="muted" style="margin:0">لا يوجد جهاز مربوط بعد.</p>'}</section>
    ${owner ? `<section class="card grid" style="gap:12px"><h3 style="margin:0">ربط جهاز (فرع)</h3>
      <p class="muted" style="margin:0">للإنتاج: ادخل fatoora.zatca.gov.sa بحساب المنشأة ← «ربط وحدة/جهاز جديد» ← «إنشاء رمز OTP»، والصقه هنا خلال ساعة. للتجربة اختر بيئة المطورين بدون رمز.</p>
      <div class="form-grid">${select('zenv', 'البيئة', Object.entries(ZENV), 'sandbox')}
        ${select('zbr', 'الفرع', branches.map(b => [b.id, b.name]))}
        ${field('zotp', 'رمز OTP من منصة فاتورة', { attrs: 'inputmode="numeric" autocomplete="one-time-code" dir="ltr"', help: 'غير مطلوب لبيئة المطورين' })}</div>
      <p class="help err" id="zerr" role="alert"></p>
      <div class="row" style="justify-content:flex-end"><button class="btn primary" id="zgo">ربط</button></div><div id="zgor"></div></section>` : ''}`;
  $('#zst').onclick = async e => { e.target.disabled = true; $('#zstr').innerHTML = loading();
    try { const r = await api.zatca('selftest'); $('#zstr').innerHTML = `<p style="margin:10px 0 0">${r.ok ? badge(['نجح الاختبار — الهيئة قبلت المستندات وأصدرت شهادة', 'b-ok']) : badge(['لم ينجح', 'b-danger']) + ' <span class="xs">' + esc(r.step || '') + ' ' + esc(JSON.stringify(r.response || '').slice(0, 300)) + '</span>'}</p>${zChecks(r.checks)}`; }
    catch (x) { $('#zstr').innerHTML = `<p class="help err">${esc(x.message)}</p>`; } finally { e.target.disabled = false; } };
  if ($('#zgo')) $('#zgo').onclick = async e => { const env = $('#f-zenv').value, otp = $('#f-zotp').value.trim(); $('#zerr').textContent = '';
    if (env !== 'sandbox' && !/^\d{6}$/.test(otp)) return $('#zerr').textContent = 'رمز OTP من 6 أرقام مطلوب';
    if (env === 'production' && !e.target.dataset.sure) { e.target.dataset.sure = 1; e.target.textContent = 'ربط فعلي — كل فاتورة بعدها تُرسل للهيئة. اضغط مرة أخرى للتأكيد'; return; }
    e.target.disabled = true; $('#zgor').innerHTML = loading();
    try { const r = await api.zatca('onboard', { environment: env, branch_id: $('#f-zbr').value, otp });
      if (r.ok) { toast('تم الربط'); zatcaView(); } else { $('#zgor').innerHTML = `<p class="help err">لم يكتمل الربط (${esc(r.step || '')}) ${esc(JSON.stringify(r.response || '').slice(0, 300))}</p>${zChecks(r.checks)}`; } }
    catch (x) { $('#zerr').textContent = x.message; $('#zgor').innerHTML = ''; } finally { e.target.disabled = false; delete e.target.dataset.sure; e.target.textContent = 'ربط'; } };
}
// send one posted invoice / note to ZATCA from its page
async function zatcaSubmit(d, btn) {
  btn.disabled = true; const t = btn.textContent; btn.textContent = 'جارٍ الإرسال للهيئة…';
  try { const r = await api.zatca('submit', { document_id: d.id });
    toast(r.status === 'cleared' ? 'اعتمدتها الهيئة' : r.status === 'reported' ? 'تم إبلاغ الهيئة' : r.status === 'warning' ? 'قبلتها الهيئة مع ملاحظات' : r.retry ? 'تعذّر الوصول للهيئة — أعد المحاولة لاحقاً' : 'رفضتها الهيئة — راجع الملاحظات');
    route(); }
  catch (x) { toast(x.message); btn.disabled = false; btn.textContent = t; }
}
const ZATCA_ROUTES = [[/^#\/zatca$/, gate('zatca', 'الربط مع هيئة الزكاة', 'settings', zatcaView)]];
