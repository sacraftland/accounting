// =====================================================================
// Customer portal (public, read-only link per customer) and van sales trips.
// Inserted after ext2.js.
// =====================================================================
const PORTAL_RE = /^#\/p\/([0-9a-f]{64})(?:\/([\w-]+))?$/;
const portalUrl = tok => location.origin + location.pathname + '#/p/' + tok;
const DOC_NAME = { tax_invoice: 'فاتورة ضريبية', simplified_invoice: 'فاتورة مبسطة', credit_note: 'إشعار دائن', quote: 'عرض سعر', delivery_note: 'سند تسليم' };

// ---------- public portal (no sign-in) ----------
async function portalPublicView(tok, docId) {
  $('#app').innerHTML = loading('جارٍ فتح كشف الحساب…');
  let v; try { v = await api.portalView(tok); } catch (x) {
    $('#app').innerHTML = `<div class="auth"><div class="card empty">${icon('lock')}<h3 style="margin:12px 0 4px">الرابط غير صالح</h3><p class="muted">هذا الرابط غير صحيح أو أُلغي. اطلب رابطاً جديداً من المنشأة.</p></div></div>`; return; }
  const o = v.org, p = v.party, docs = v.documents, today = riyadhToday();
  const brand = `<header class="row" style="gap:12px;align-items:center;margin-bottom:20px">${o.logo_path ? `<img src="${esc(o.logo_path)}" alt="" style="width:52px;height:52px;object-fit:contain;border-radius:10px;background:#fff">` : ''}
    <div><b style="font-size:20px">${esc(o.name_ar)}</b>${o.vat_number ? `<div class="xs muted">الرقم الضريبي <span class="num">${esc(o.vat_number)}</span></div>` : ''}</div></header>`;
  document.title = 'كشف حساب — ' + o.name_ar;
  if (docId) {
    let d; try { d = await api.portalDocument(tok, docId); } catch { location.hash = '#/p/' + tok; return; }
    const ts = `${d.issue_date}T${(d.issue_time || '00:00:00').slice(0, 8)}+03:00`; let qr = '';
    if (['tax_invoice', 'simplified_invoice', 'credit_note'].includes(d.kind)) try { qr = QR.svg(QR.encode(QR.ascii(QR.zatcaTLV({ seller: o.name_ar, vatNo: o.vat_number || '', timestamp: new Date(ts).toISOString().replace('.000', ''), total: (d.total / 100).toFixed(2), vat: (d.vat_total / 100).toFixed(2) }))), 3); } catch { qr = ''; }
    $('#app').innerHTML = `<main class="portal" style="max-width:860px;margin:0 auto;padding:24px 16px"><div class="row no-print" style="justify-content:space-between;margin-bottom:12px"><a href="#/p/${esc(tok)}">${icon('chev')} كشف الحساب</a><button class="btn secondary" onclick="window.print()">${icon('down')}طباعة / PDF</button></div>
      <article class="card">${brand}<h2 style="margin:0 0 4px">${esc(DOC_NAME[d.kind] || '')} <span class="num">${esc(d.number)}</span></h2>
        <dl class="kv" style="margin-bottom:12px"><dt>التاريخ</dt><dd class="num">${esc(d.issue_date)}</dd>${d.due_date ? `<dt>الاستحقاق</dt><dd class="num">${esc(d.due_date)}</dd>` : ''}<dt>العميل</dt><dd>${esc(p.name)}${p.vat_number ? ` · <span class="num">${esc(p.vat_number)}</span>` : ''}</dd></dl>
        <div class="tbl-wrap"><table class="rep-tbl"><thead><tr><th>البيان</th><th class="amt">الكمية</th><th class="amt">السعر</th><th class="amt">الضريبة</th><th class="amt">الإجمالي</th></tr></thead><tbody>
          ${d.lines.map(l => `<tr><td style="white-space:normal">${esc(l.description)}</td><td class="amt num">${fq(l.qty)}</td><td class="amt num">${money(l.unit_price)}</td><td class="amt num">${money(l.line_vat)}</td><td class="amt num">${money(Number(l.line_net) + Number(l.line_vat))}</td></tr>`).join('')}
          <tr class="sub"><td colspan="4">الإجمالي قبل الضريبة</td><td class="amt num">${money(d.subtotal)}</td></tr><tr class="sub"><td colspan="4">ضريبة القيمة المضافة</td><td class="amt num">${money(d.vat_total)}</td></tr>
          <tr class="grand"><td colspan="4">الإجمالي</td><td class="amt num">${money(d.total)}</td></tr>${d.amount_paid ? `<tr><td colspan="4">المدفوع</td><td class="amt num">${money(d.amount_paid)}</td></tr><tr class="grand"><td colspan="4">المتبقي</td><td class="amt num">${money(d.total - d.amount_paid)}</td></tr>` : ''}</tbody></table></div>
        <div class="row" style="justify-content:space-between;align-items:flex-end;margin-top:16px;gap:16px;flex-wrap:wrap"><div>${qr}</div>${o.invoice_footer ? `<p class="xs muted" style="max-width:420px">${esc(o.invoice_footer)}</p>` : ''}</div></article></main>`;
    return;
  }
  const inv = docs.filter(d => ['tax_invoice', 'simplified_invoice'].includes(d.kind)), open = inv.filter(d => d.total - d.amount_paid > 0), overdue = open.filter(d => (d.due_date || d.issue_date) < today);
  $('#app').innerHTML = `<main class="portal" style="max-width:960px;margin:0 auto;padding:24px 16px">${brand}
    <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px"><h1 style="margin:0">كشف حساب: ${esc(p.name)}</h1><button class="btn secondary no-print" onclick="window.print()">${icon('down')}طباعة / PDF</button></div>
    <p class="muted" style="margin:4px 0 16px">كما في <span class="num">${today}</span></p>
    <div class="grid g3" style="margin-bottom:20px"><div class="card stat"><div class="label">الرصيد المستحق</div><div class="val num ${v.balance > 0 ? 'down' : ''}">${money(v.balance)}</div><div class="xs muted">ر.س${v.balance && Math.abs(v.balance - open.reduce((a, d) => a + d.total - d.amount_paid, 0)) > 0 ? ' · يشمل رصيداً سابقاً' : ''}</div></div>
      <div class="card stat"><div class="label">فواتير غير مسددة</div><div class="val num">${open.length}</div></div><div class="card stat"><div class="label">متأخرة السداد</div><div class="val num ${overdue.length ? 'down' : ''}">${overdue.length}</div></div></div>
    <section class="card" style="margin-bottom:20px"><h2 style="margin-bottom:8px">المستندات</h2>${docs.length ? `<div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>المستند</th><th>التاريخ</th><th class="m-hide">الاستحقاق</th><th class="amt">الإجمالي</th><th class="amt">المتبقي</th><th>الحالة</th></tr></thead><tbody>
      ${docs.map(d => { const rem = ['tax_invoice', 'simplified_invoice'].includes(d.kind) ? d.total - d.amount_paid : 0, late = rem > 0 && (d.due_date || d.issue_date) < today;
        return `<tr class="click" data-href="#/p/${esc(tok)}/${esc(d.id)}"><td><a href="#/p/${esc(tok)}/${esc(d.id)}">${esc(DOC_NAME[d.kind])} <span class="num">${esc(d.number)}</span></a></td><td class="num">${esc(d.issue_date)}</td><td class="num m-hide">${esc(d.due_date || '')}</td>
          <td class="amt num">${money(d.total)}</td><td class="amt num">${rem ? money(rem) : '—'}</td><td>${['tax_invoice', 'simplified_invoice'].includes(d.kind) ? badge(rem <= 0 ? ['مسددة', 'b-ok'] : late ? ['متأخرة', 'b-bad'] : d.amount_paid > 0 ? ['مسددة جزئياً', 'b-warn'] : ['غير مسددة', 'b-warn']) : ''}</td></tr>`; }).join('')}</tbody></table></div>` : '<p class="muted">لا توجد مستندات.</p>'}</section>
    ${v.payments.length ? `<section class="card"><h2 style="margin-bottom:8px">المدفوعات المستلمة</h2><div class="tbl-wrap"><table><tbody>${v.payments.map(y => `<tr><td class="num">${esc(y.number)}</td><td class="num">${esc(y.pay_date)}</td><td class="amt num">${money(y.amount)}</td></tr>`).join('')}</tbody></table></div></section>` : ''}
    <p class="xs muted" style="margin-top:24px;text-align:center">هذه الصفحة للعرض فقط ومخصصة لكم. للاستفسار تواصلوا مع ${esc(o.name_ar)}.</p></main>`;
  $$('#app tr.click').forEach(tr => tr.onclick = e => { if (!e.target.closest('a')) location.hash = tr.dataset.href; });
}

// ---------- customer page: share the portal link ----------
async function portalShare(p) {
  let tok; try { tok = await api.createPortalLink(p.id); } catch (x) { return fail(x); }
  const url = portalUrl(tok), msg = `السلام عليكم ${p.name}، هذا رابط كشف حسابكم وفواتيركم لدى ${ORG.name_ar}: ${url}`;
  const f = drawer('رابط بوابة العميل', `<p class="muted">يفتح العميل هذا الرابط بدون تسجيل دخول ويشاهد فواتيره وكشف حسابه ويطبعها. لا يستطيع تعديل أي شيء.</p>
    <div class="field"><label for="f-purl">الرابط</label><input class="input" id="f-purl" readonly dir="ltr" value="${esc(url)}" onclick="this.select()"></div>
    <div class="row" style="gap:8px;flex-wrap:wrap"><button type="button" class="btn secondary" id="pcopy">نسخ الرابط</button>${p.phone ? `<a class="btn secondary" target="_blank" rel="noopener" href="${waLink(p.phone, msg)}">إرسال واتساب</a>` : ''}
      ${p.email ? `<a class="btn secondary" href="mailto:${esc(p.email)}?subject=${encodeURIComponent('كشف حسابكم لدى ' + ORG.name_ar)}&body=${encodeURIComponent(msg)}">إرسال بريد</a>` : ''}<a class="btn ghost" target="_blank" rel="noopener" href="${esc(url)}">معاينة</a></div>
    <button type="button" class="btn ghost" id="prev2" style="color:var(--c-danger)">إلغاء الرابط</button><p class="xs muted">إلغاء الرابط يوقفه فوراً؛ يمكنك إنشاء رابط جديد في أي وقت.</p>`, async () => {}, 'تم');
  $('#pcopy', f).onclick = async () => { try { await navigator.clipboard.writeText(url); toast('نُسخ الرابط'); } catch { $('#f-purl', f).select(); document.execCommand?.('copy'); toast('نُسخ الرابط'); } };
  $('#prev2', f).onclick = async e => { if (!confirmBtn(e.target, 'اضغط مرة أخرى لإلغاء الرابط')) return; try { await api.revokePortalLink(p.id); f.closest('.drawer-bg').remove(); toast('أُلغي الرابط'); } catch (x) { fail(x); } };
}

// ---------- van sales trips ----------
async function tripsView() {
  shell('trips', loading()); const [ts, whs, emps] = await Promise.all([api.listTrips(), api.listWarehouses(), can('hr') ? api.listEmployees().catch(() => []) : []]);
  const vans = whs.filter(w => w.kind === 'van'), W = Object.fromEntries(whs.map(w => [w.id, w.name])), editable = can('inventory', 'create');
  const open = ts.filter(t => t.status === 'open'), closed = ts.filter(t => t.status === 'closed');
  $('#main').innerHTML = `<div class="page-head"><h1>رحلات المندوبين</h1>${editable ? `<button class="btn secondary" id="newvan">${icon('plus')}سيارة</button><button class="btn primary" id="newtrip">${icon('plus')}رحلة جديدة</button>` : ''}</div>
    <p class="muted" style="margin:-8px 0 16px">حمّل البضاعة على سيارة المندوب، بِع منها بنقطة البيع أو الفواتير، أرجع المتبقي، ثم أغلق الرحلة بالنقد المسلَّم — ويظهر لك أي فرق.</p>
    <div class="grid g3" style="margin-bottom:20px"><div class="card stat"><div class="label">السيارات</div><div class="val num">${vans.length}</div><div class="xs muted">${vans.map(v => esc(v.name)).join(' · ') || 'أضف سيارة أولاً'}</div></div>
      <div class="card stat"><div class="label">رحلات مفتوحة</div><div class="val num">${open.length}</div></div><div class="card stat"><div class="label">رحلات مغلقة</div><div class="val num">${closed.length}</div></div></div>
    ${ts.length ? `<div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>الرقم</th><th>التاريخ</th><th>السيارة</th><th>المندوب</th><th class="m-hide">خط السير</th><th>الحالة</th></tr></thead><tbody>
      ${ts.map(t => `<tr class="click" data-href="#/trips/${esc(t.id)}"><td class="num"><a class="rowlink" href="#/trips/${esc(t.id)}">${esc(t.number)}</a></td><td class="num">${esc(t.trip_date)}</td><td>${esc(W[t.van_warehouse_id] || '')}</td><td>${esc(t.driver_name || '—')}</td><td class="m-hide">${esc(t.route || '')}</td>
        <td>${badge(t.status === 'open' ? ['مفتوحة', 'b-warn'] : ['مغلقة', 'b-ok'])}</td></tr>`).join('')}</tbody></table></div>`
    : empty('cart', 'لا توجد رحلات بعد', vans.length ? 'افتح رحلة لسيارة المندوب لتتابع ما حُمّل وما بيع وما رجع.' : 'أضف سيارة المندوب أولاً (تُعامل كمستودع متنقل)، ثم افتح رحلة.', '')}`;
  const newVan = () => drawer('سيارة مندوب', `${field('name', 'اسم السيارة / رقم اللوحة', { req: true, help: 'مثل: هايلكس — أ ب ج 1234' })}`,
    async v => { if (!v.name?.trim()) throw new AppError('الاسم مطلوب'); await api.saveWarehouse({ name: v.name.trim(), kind: 'van' }); toast('أُضيفت السيارة'); tripsView(); });
  if ($('#newvan')) $('#newvan').onclick = newVan;
  if ($('#newtrip')) $('#newtrip').onclick = () => { if (!vans.length) return newVan();
    const busy = new Set(open.map(t => t.van_warehouse_id)), free = vans.filter(v => !busy.has(v.id));
    if (!free.length) return toast('كل السيارات لديها رحلات مفتوحة — أغلق رحلة أولاً', 'warn');
    drawer('رحلة جديدة', `${select('van', 'السيارة', free.map(v => [v.id, v.name]), free[0].id)}${select('source', 'التحميل من مستودع', whs.filter(w => w.kind !== 'van').map(w => [w.id, w.name]), whs.find(w => w.kind !== 'van')?.id)}
      ${emps.length ? select('employee_id', 'المندوب (من الموظفين)', [['', '— اكتب الاسم —'], ...emps.filter(e => e.status !== 'terminated').map(e => [e.id, e.full_name])], '') : ''}${field('driver', 'اسم المندوب', {})}
      <div class="form-grid">${field('trip_date', 'التاريخ', { type: 'date', value: riyadhToday(), req: true })}${field('route', 'خط السير', { help: 'مثل: الدمام – الخبر – الجبيل' })}</div>`,
      async v => { if (!v.employee_id && !v.driver?.trim()) throw new AppError('اختر المندوب أو اكتب اسمه');
        const id = await api.openTrip(v.van, v.source, v.employee_id || null, v.driver, v.trip_date, v.route); toast('فُتحت الرحلة'); location.hash = '#/trips/' + id; }, 'فتح الرحلة'); };
  $$('#main tr.click').forEach(tr => tr.onclick = e => { if (!e.target.closest('a')) location.hash = tr.dataset.href; });
}

async function tripView(id) {
  shell('trips', loading()); const [ts, whs, items, bal] = await Promise.all([api.listTrips(), api.listWarehouses(), api.listItems(), api.stockByWarehouse()]);
  const t = ts.find(x => x.id === id); if (!t) throw new AppError('الرحلة غير موجودة');
  const d = await api.tripData(t), W = Object.fromEntries(whs.map(w => [w.id, w.name])), I = Object.fromEntries(items.map(i => [i.id, i])), isOpen = t.status === 'open';
  const rows = {}, add = (it, k, q) => { (rows[it] ||= { load: 0, sold: 0, back: 0 })[k] += Number(q); };
  d.stock.forEach(s => s.stock_doc_lines.forEach(l => add(l.item_id, s.to_warehouse_id === t.van_warehouse_id ? 'load' : 'back', l.qty)));
  d.docs.forEach(x => x.document_lines.forEach(l => l.item_id && add(l.item_id, 'sold', (x.kind === 'credit_note' ? -1 : 1) * l.qty)));
  const vq = {}; bal.filter(b => b.warehouse_id === t.van_warehouse_id).forEach(b => vq[b.item_id] = b.qty); Object.keys(vq).forEach(k => rows[k] ||= { load: 0, sold: 0, back: 0 });
  const sales = d.docs.reduce((s, x) => s + (x.kind === 'credit_note' ? -1 : 1) * Number(x.total), 0), collected = d.docs.filter(x => x.kind !== 'credit_note').reduce((s, x) => s + Number(x.amount_paid), 0);
  const left = Object.entries(vq).filter(([, q]) => q > 0);
  $('#main').innerHTML = `<a class="crumb" href="#/trips">${icon('chev')} رحلات المندوبين</a>
    <div class="page-head"><h1>رحلة <span class="num">${esc(t.number)}</span></h1>${badge(isOpen ? ['مفتوحة', 'b-warn'] : ['مغلقة', 'b-ok'])}
      ${isOpen && can('inventory', 'create') ? `<button class="btn secondary" id="tload">${icon('plus')}تحميل بضاعة</button>` : ''}${isOpen && can('sales', 'post') ? `<button class="btn secondary" id="tpos">${icon('pos')}بيع من السيارة</button>` : ''}
      ${isOpen && left.length && can('inventory', 'create') ? '<button class="btn secondary" id="tback">إرجاع المتبقي</button>' : ''}${isOpen && can('inventory', 'post') ? '<button class="btn primary" id="tclose">إغلاق الرحلة</button>' : ''}</div>
    <div class="card" style="margin-bottom:16px"><dl class="kv"><dt>السيارة</dt><dd>${esc(W[t.van_warehouse_id])}</dd><dt>المندوب</dt><dd>${esc(t.driver_name || '—')}</dd><dt>التاريخ</dt><dd class="num">${esc(t.trip_date)}</dd>${t.route ? `<dt>خط السير</dt><dd>${esc(t.route)}</dd>` : ''}<dt>التحميل من</dt><dd>${esc(W[t.source_warehouse_id])}</dd>${t.notes ? `<dt>ملاحظات</dt><dd>${esc(t.notes)}</dd>` : ''}</dl></div>
    <div class="grid g4" style="margin-bottom:20px">${[['مبيعات الرحلة', money(sales)], ['المحصّل في الفواتير', money(collected)], ['النقد المسلَّم', t.cash_handed != null ? money(t.cash_handed) : '—'], ['الفرق', t.cash_handed != null ? money(t.cash_handed - collected) : '—']]
      .map(([k, v], i) => `<div class="card stat"><div class="label">${k}</div><div class="val num ${i === 3 && t.cash_handed != null && t.cash_handed - collected < 0 ? 'down' : ''}">${v}</div></div>`).join('')}</div>
    <section class="card" style="margin-bottom:20px"><h3 style="margin-bottom:8px">حركة البضاعة</h3>${Object.keys(rows).length ? `<div class="tbl-wrap"><table class="rep-tbl"><thead><tr><th>الصنف</th><th class="amt">المحمّل</th><th class="amt">المباع</th><th class="amt">المرتجع</th><th class="amt">المتبقي في السيارة</th><th class="amt">الفرق</th></tr></thead><tbody>
      ${Object.entries(rows).map(([it, r]) => { const rem = vq[it] || 0, diff = r.load - r.sold - r.back - rem; return `<tr><td>${esc(I[it]?.name_ar || '')}</td><td class="amt num">${fq(r.load)}</td><td class="amt num">${fq(r.sold)}</td><td class="amt num">${fq(r.back)}</td><td class="amt num"><b>${fq(rem)}</b></td><td class="amt num ${Math.abs(diff) > 1e-9 ? 'down' : ''}">${Math.abs(diff) > 1e-9 ? fq(diff) : '—'}</td></tr>`; }).join('')}</tbody></table></div>
      <p class="xs muted" style="margin-top:6px">الفرق = المحمّل − المباع − المرتجع − المتبقي. الفرق غير الصفري يعني بيعاً أو تحويلاً خارج هذه الرحلة، أو عجزاً.</p>` : '<p class="muted">لم تُحمَّل بضاعة بعد.</p>'}</section>
    <section class="card"><h3 style="margin-bottom:8px">فواتير الرحلة</h3>${d.docs.length ? `<div class="tbl-wrap"><table><tbody>${d.docs.map(x => `<tr><td><a href="#/${x.kind === 'credit_note' ? 'credit-notes' : 'invoices'}/${esc(x.id)}"><span class="num">${esc(x.number)}</span></a> ${esc(x.parties?.name || 'عميل نقدي')}</td><td class="amt num">${money(x.total)}</td><td>${badge(x.payment_status === 'paid' ? ['مدفوعة', 'b-ok'] : ['آجلة', 'b-warn'])}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">لا توجد مبيعات بعد. اضغط «بيع من السيارة» لفتح نقطة البيع على مستودع السيارة.</p>'}</section>`;
  if ($('#tpos')) $('#tpos').onclick = () => { sessionStorage.setItem('pos-wh', t.van_warehouse_id); location.hash = '#/pos'; };
  const stockItems = items.filter(i => i.track_stock), srcQ = {}; bal.filter(b => b.warehouse_id === t.source_warehouse_id).forEach(b => srcQ[b.item_id] = b.qty);
  if ($('#tload')) $('#tload').onclick = () => { let lines = [{ item_id: '', qty: '' }];
    const f = drawer('تحميل بضاعة على السيارة', `<p class="muted">من «${esc(W[t.source_warehouse_id])}» إلى «${esc(W[t.van_warehouse_id])}».</p><div id="tll"></div><button type="button" class="btn ghost sm" id="tladd">${icon('plus')}صنف</button>`,
      async () => { const real = lines.filter(l => l.item_id && Number(l.qty) > 0); if (!real.length) throw new AppError('أضف صنفاً وكمية');
        const sid = await api.saveStockDoc({ kind: 'transfer', doc_date: riyadhToday(), from_warehouse_id: t.source_warehouse_id, to_warehouse_id: t.van_warehouse_id, note: 'تحميل رحلة ' + t.number }, real.map(l => ({ item_id: l.item_id, qty: Number(l.qty) })));
        await api.postStockDoc(sid); toast('حُمّلت البضاعة'); tripView(id); }, 'تحميل');
    const draw = () => { $('#tll', f).innerHTML = lines.map((l, i) => `<div class="row" style="gap:8px;margin-bottom:8px" data-i="${i}"><select class="input" data-k="item_id" aria-label="الصنف" style="flex:2">${optList(stockItems.map(s => [s.id, `${s.name_ar} (متوفر ${fq(srcQ[s.id] || 0)})`]), l.item_id, '— اختر —')}</select>
      <input class="input num" data-k="qty" inputmode="decimal" placeholder="الكمية" value="${esc(l.qty)}" style="flex:1" aria-label="الكمية"></div>`).join(''); };
    $('#tll', f).addEventListener('input', e => { const r = e.target.closest('[data-i]'); if (r) lines[r.dataset.i][e.target.dataset.k] = e.target.dataset.k === 'qty' ? toLatin(e.target.value) : e.target.value; });
    $('#tll', f).addEventListener('change', e => { const r = e.target.closest('[data-i]'); if (r) lines[r.dataset.i][e.target.dataset.k] = e.target.value; });
    $('#tladd', f).onclick = () => { lines.push({ item_id: '', qty: '' }); draw(); }; draw(); };
  if ($('#tback')) $('#tback').onclick = async e => { if (!confirmBtn(e.target, `اضغط مرة أخرى لإرجاع ${left.length} صنف`)) return; e.target.disabled = true;
    try { const sid = await api.saveStockDoc({ kind: 'transfer', doc_date: riyadhToday(), from_warehouse_id: t.van_warehouse_id, to_warehouse_id: t.source_warehouse_id, note: 'إرجاع رحلة ' + t.number }, left.map(([it, q]) => ({ item_id: it, qty: q })));
      await api.postStockDoc(sid); toast('أُرجع المتبقي للمستودع'); tripView(id); } catch (x) { fail(x); e.target.disabled = false; } };
  if ($('#tclose')) $('#tclose').onclick = () => { const f = drawer('إغلاق الرحلة', `${left.length ? `<p class="note warn">ما زال في السيارة ${left.length} صنف — أرجعها أولاً أو أبقها للرحلة القادمة.</p>` : ''}
      <dl class="kv"><dt>المحصّل في الفواتير</dt><dd class="num">${money(collected)}</dd></dl>${field('cash', 'النقد الذي سلّمه المندوب', { type: 'money', value: money(collected), req: true })}<p class="muted" id="tdiff"></p>${field('notes', 'ملاحظات', {})}`,
    async v => { const c = toHalalas(v.cash); if (!(c >= 0)) throw new AppError('مبلغ غير صحيح'); await api.closeTrip(id, c, v.notes); toast('أُغلقت الرحلة'); tripView(id); }, 'إغلاق');
    const upd = () => { const c = toHalalas($('#f-cash', f).value || 0); $('#tdiff', f).textContent = Number.isFinite(c) ? (c === collected ? 'مطابق ✓' : `الفرق: ${money(c - collected)} ${c < collected ? '(عجز)' : '(زيادة)'}`) : ''; };
    $('#f-cash', f).oninput = upd; upd(); };
}

const EXT3_ROUTES = [
  [/^#\/trips$/, gate('trips', 'رحلات المندوبين', 'inventory|sales', tripsView)],
  [/^#\/trips\/([\w-]+)$/, gate('trips', 'رحلات المندوبين', 'inventory|sales', m => tripView(m[1]))],
];
