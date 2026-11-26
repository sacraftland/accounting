// =====================================================================
// Operations screens: permissions, purchases, quotes & returns, vouchers,
// expenses, journal entries, warehouses & stock, manufacturing, users.
// (Inserted into app.js by build.py — shares its helpers and state.)
// =====================================================================

// ---------- permissions ----------
const MODULES = [['sales', 'المبيعات'], ['purchases', 'المشتريات'], ['expenses', 'المصروفات'], ['inventory', 'المخزون'], ['manufacturing', 'التصنيع'],
  ['accounting', 'المحاسبة والقيود'], ['reports', 'التقارير'], ['hr', 'الموارد البشرية'], ['settings', 'إعدادات المنشأة'], ['users', 'المستخدمون والصلاحيات']];
const ACTIONS = [['view', 'عرض'], ['create', 'إنشاء وتعديل'], ['post', 'اعتماد وترحيل']];
const can = (m, a = 'view') => { const p = ORG?.perms; if (api.mode !== 'supabase' || !p || p._owner) return true;
  return a === 'view' ? ['view', 'create', 'post'].some(x => p[m]?.includes(x)) : !!p[m]?.includes(a); };
const fq = n => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 4 });
const serverOnly = (key, title) => { shell(key, `<div class="page-head"><h1>${esc(title)}</h1></div>${empty('lock', 'تعمل هذه الوحدة عند الربط بالخادم', 'وضع التجربة يغطي الفواتير والسندات فقط. اربط النظام بـ Supabase من الإعدادات.')}`); };
const denied = (key, title) => { shell(key, `<div class="page-head"><h1>${esc(title)}</h1></div>${empty('lock', 'ليست لديك صلاحية', 'اطلب من مدير النظام إضافة هذه الصلاحية لدورك.')}`); };
const gate = (key, title, module, fn) => async (...a) => { if (api.mode !== 'supabase') return serverOnly(key, title); if (!module.split('|').some(m => can(m))) return denied(key, title); return fn(...a); };
const optList = (rows, val, blank) => (blank ? `<option value="">${esc(blank)}</option>` : '') + rows.map(([v, t]) => `<option value="${esc(v)}"${String(v) === String(val ?? '') ? ' selected' : ''}>${esc(t)}</option>`).join('');
const acctOpts = (accs, val, blank) => optList(accs.map(a => [a.id, `${a.code} — ${a.name_ar}`]), val, blank);
const payAccts = accs => accs.filter(a => a.is_postable && (['cash', 'bank', 'card_clearing', 'custody'].includes(a.system_key) || (a.type === 'asset' && /^110/.test(a.code))));
const expAccts = accs => [...accs.filter(a => a.is_postable && a.type === 'expense' && !['cogs', 'stock_variance'].includes(a.system_key)), ...accs.filter(a => a.code === '1501')];
const ccField = (ccs, val, label = 'المشروع / مركز التكلفة') => ccs?.filter(c => c.status !== 'closed' || c.id === val).length ? `<div class="field"><label for="f-cost_center_id">${label}</label><select class="input" id="f-cost_center_id" name="cost_center_id">${optList(ccs.filter(c => c.status !== 'closed' || c.id === val).map(c => [c.id, `${c.code} — ${c.name}`]), val, '— بدون —')}</select></div>` : '';
const statusBadge = d => d.status === 'draft' ? (d.submitted_at ? badge(['بانتظار الاعتماد', 'b-warn']) : badge(['مسودة', 'b-draft'])) : d.status === 'void' ? badge(['ملغى', 'b-bad']) : badge(['مرحّل', 'b-ok']);
const confirmBtn = (btn, label = 'اضغط مرة أخرى للتأكيد') => { if (btn.dataset.sure) return true; btn.dataset.sure = 1; btn.textContent = label; setTimeout(() => { delete btn.dataset.sure; }, 4000); return false; };
const onBusy = async (btns, fn) => { btns.forEach(b => b.disabled = true); try { await fn(); } catch (x) { fail(x); btns.forEach(b => b.disabled = false); throw x; } };

// ---------- document types (everything except sales invoices, which keep their own screens) ----------
const DOCS = {
  quotes: { kinds: [['quote', 'عرض سعر']], module: 'sales', side: 'customer', title: 'عروض الأسعار', one: 'عرض سعر', paper: 'عرض سعر<br>Quotation', prefix: 'QUO',
    price: 'sale_price', postLabel: 'إصدار العرض', issue: true, dueLabel: 'صالح حتى', convert: [['tax_invoice', 'تحويل لفاتورة ضريبية'], ['simplified_invoice', 'تحويل لفاتورة مبسطة']] },
  'credit-notes': { kinds: [['credit_note', 'إشعار دائن']], module: 'sales', side: 'customer', title: 'الإشعارات الدائنة', one: 'إشعار دائن', paper: 'إشعار دائن<br>Credit Note',
    price: 'sale_price', postLabel: 'ترحيل الإشعار', needsSource: 'من صفحة الفاتورة: «إصدار إشعار دائن»', stock: true, qr: true },
  bills: { kinds: [['purchase_bill', 'فاتورة مشتريات']], module: 'purchases', side: 'supplier', title: 'فواتير المشتريات', one: 'فاتورة مشتريات', paper: 'فاتورة مشتريات<br>Purchase Invoice',
    price: 'avg_cost', postLabel: 'ترحيل الفاتورة', accounts: true, landed: true, stock: true, payNow: true, dueLabel: 'تاريخ الاستحقاق', supplierRef: true },
  'purchase-orders': { kinds: [['purchase_order', 'أمر شراء']], module: 'purchases', side: 'supplier', title: 'أوامر الشراء', one: 'أمر شراء', paper: 'أمر شراء<br>Purchase Order',
    price: 'avg_cost', postLabel: 'إصدار الأمر', issue: true, accounts: true, stock: true, dueLabel: 'تاريخ التسليم', convert: [['purchase_bill', 'تحويل لفاتورة مشتريات']] },
  'purchase-returns': { kinds: [['purchase_return', 'إشعار مدين (مرتجع)']], module: 'purchases', side: 'supplier', title: 'مرتجعات المشتريات', one: 'إشعار مدين', paper: 'إشعار مدين — مرتجع مشتريات<br>Debit Note',
    price: 'avg_cost', postLabel: 'ترحيل المرتجع', needsSource: 'من صفحة فاتورة المشتريات: «إرجاع للمورد»', accounts: true, stock: true },
};
const KIND_ROUTE = { tax_invoice: 'invoices', simplified_invoice: 'invoices', quote: 'quotes', credit_note: 'credit-notes', purchase_bill: 'bills', purchase_order: 'purchase-orders', purchase_return: 'purchase-returns' };
const KIND_NAME = { tax_invoice: 'فاتورة ضريبية', simplified_invoice: 'فاتورة مبسطة', quote: 'عرض سعر', credit_note: 'إشعار دائن', purchase_bill: 'فاتورة مشتريات', purchase_order: 'أمر شراء', purchase_return: 'مرتجع مشتريات' };
const docLink = d => `#/${KIND_ROUTE[d.kind]}/${d.id}`;

async function docListView(key) {
  const c = DOCS[key]; shell(key, loading());
  const docs = await api.listDocuments(c.kinds.map(k => k[0]));
  let tab = sessionStorage.getItem('tab-' + key) || 'all';
  const sets = { all: docs, draft: docs.filter(d => d.status === 'draft' && !d.submitted_at), pending: docs.filter(d => d.status === 'draft' && d.submitted_at),
    open: docs.filter(d => d.status === 'posted' && d.payment_status !== 'paid'), posted: docs.filter(d => d.status === 'posted') };
  const tabs = [['all', 'الكل'], ['pending', 'بانتظار الاعتماد'], ['draft', 'مسودات'], ...(c.issue || c.needsSource ? [['posted', c.issue ? 'مُصدرة' : 'مرحّلة']] : [['open', 'غير مسددة'], ['posted', 'مرحّلة']])];
  const render = () => {
    const f = sets[tab] || docs;
    $('#main').innerHTML = `<div class="page-head"><h1>${esc(c.title)}</h1>${can(c.module, 'create') && !c.needsSource ? `<a class="btn primary" href="#/${key}/new">${icon('plus')}${esc(c.one)} جديد</a>` : ''}</div>
      ${c.needsSource ? `<p class="note" style="margin-bottom:16px">يُنشأ ${esc(c.one)} ${esc(c.needsSource)} — فيُنسخ أصنافها وتعدّل الكميات المرتجعة.</p>` : ''}
      <div class="tabs" role="tablist">${tabs.map(([k, t]) => `<button role="tab" aria-selected="${tab === k}" class="${tab === k ? 'on' : ''}" data-tab="${k}">${t} <span class="muted num">(${(sets[k] || docs).length})</span></button>`).join('')}</div>
      ${f.length ? `<div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>الرقم</th><th>${c.side === 'supplier' ? 'المورد' : 'العميل'}</th><th>التاريخ</th><th class="amt">الإجمالي</th><th>الحالة</th></tr></thead><tbody>
        ${f.map(d => `<tr class="click" data-href="#/${key}/${esc(d.id)}"><td><a class="rowlink num" href="#/${key}/${esc(d.id)}">${esc(d.number || 'مسودة')}</a></td><td class="m-sub" style="white-space:normal">${esc(d.party_name)}</td>
          <td class="num m-hide">${esc(d.issue_date)}</td><td class="amt num">${d.status === 'draft' ? '—' : money(d.total)}</td>
          <td>${d.status === 'posted' && !c.issue && d.kind === 'purchase_bill' ? badge(PAY[d.payment_status]) : statusBadge(d)}</td></tr>`).join('')}</tbody></table></div>`
      : empty('file', docs.length ? 'لا شيء هنا' : `لا توجد ${c.title} بعد`, docs.length ? 'جرّب تبويباً آخر.' : (c.needsSource ? `يُنشأ ${c.one} ${c.needsSource}.` : `أنشئ أول ${c.one}.`),
          !docs.length && can(c.module, 'create') && !c.needsSource ? `<a class="btn primary" href="#/${key}/new">${icon('plus')}${esc(c.one)} جديد</a>` : '')}`;
    $$('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; sessionStorage.setItem('tab-' + key, tab); render(); });
  };
  render();
}

async function docEditView(key, id) {
  const c = DOCS[key]; shell(key, loading());
  if (!id && c.needsSource) { location.hash = '#/' + key; return; }
  const [parties, items, whs, accs, existing, ccs] = await Promise.all([api.listParties(c.side), api.listItems(), api.listWarehouses(),
    c.accounts || c.payNow ? api.listAccounts() : [], id ? api.getDocument(id) : null, api.listCostCenters()]);
  if (existing && existing.status !== 'draft') { location.hash = '#/' + key + '/' + id; return; }
  if (!can(c.module, 'create')) { location.hash = '#/' + key + (id ? '/' + id : ''); return; }
  const landed = existing && c.landed ? await api.listLanded(existing.id) : [];
  const doc = existing || { kind: c.kinds[0][0], party_id: '', issue_date: riyadhToday(), due_date: '', note: '', warehouse_id: whs[0]?.id };
  const blank = () => ({ item_id: '', account_id: '', description: '', qty: 1, unit_price: 0, discount: 0, tax_category: 'S', vat_rate: 15 });
  let lines = existing?.lines?.length ? existing.lines.map(l => ({ item_id: l.item_id || '', account_id: l.account_id || '', description: l.description, qty: Number(l.qty), unit_price: l.unit_price, discount: l.discount || 0, tax_category: l.tax_category, vat_rate: Number(l.vat_rate) })) : [blank()];
  let lc = landed.map(x => ({ description: x.description, amount: x.amount }));
  const itemById = Object.fromEntries(items.map(i => [i.id, i]));
  const lineAccts = accs.filter(a => a.is_postable && ['expense', 'asset'].includes(a.type));
  const canPost = can(c.module, 'post');
  $('#main').innerHTML = `<a class="crumb" href="#/${key}">${icon('chev')} ${esc(c.title)}</a>
    <div class="page-head"><h1>${existing ? 'تعديل مسودة — ' + esc(c.one) : esc(c.one) + ' جديد'}</h1>${existing ? statusBadge(existing) : ''}</div>
    ${existing?.source ? `<p class="note" style="margin-bottom:16px">${esc(c.one)} على <a href="${docLink(existing.source)}" class="num">${esc(existing.source.number)}</a> — عدّل الكميات لتطابق ما أُرجع فعلاً، واحذف ما لم يُرجع.</p>` : ''}
    ${!parties.length && c.side === 'supplier' ? `<p class="note warn" style="margin-bottom:16px">لا يوجد موردون بعد. <a href="#/suppliers">أضف مورداً</a>.</p>` : ''}
    <form class="card" id="docf" novalidate>
      <div class="grid g3" style="margin-bottom:16px">
        ${c.kinds.length > 1 ? select('kind', 'النوع', c.kinds, doc.kind) : ''}
        <div class="field"><label for="f-party">${c.side === 'supplier' ? 'المورد' : 'العميل'}${c.side === 'supplier' ? ' <span aria-hidden="true" style="color:var(--c-danger)">*</span>' : ''}</label>
          <select class="input" id="f-party" name="party_id" ${existing?.source ? 'disabled' : ''}>${optList(parties.map(p => [p.id, p.name]), doc.party_id, c.side === 'supplier' ? '— اختر المورد —' : '— عميل نقدي —')}</select>
          ${existing?.source ? '' : `<a href="#" class="xs" id="qparty">+ ${c.side === 'supplier' ? 'مورد' : 'عميل'} جديد</a>`}</div>
        ${field('issue_date', 'التاريخ', { type: 'date', value: doc.issue_date, req: true })}
        ${c.dueLabel ? field('due_date', c.dueLabel, { type: 'date', value: doc.due_date || '' }) : ''}
        ${ccField(ccs, doc.cost_center_id)}
        ${c.stock && whs.length > 1 ? select('warehouse_id', 'المستودع', whs.map(w => [w.id, w.name]), doc.warehouse_id || whs[0]?.id) : `<input type="hidden" name="warehouse_id" value="${esc(doc.warehouse_id || whs[0]?.id || '')}">`}
      </div>
      <div class="tbl-wrap editor editor-lines"><table><thead><tr><th style="width:32px">#</th><th style="min-width:170px">الصنف</th>${c.accounts ? '<th style="min-width:170px">الحساب <span class="xs muted">(للبنود غير المخزنية)</span></th>' : ''}<th style="min-width:160px">الوصف</th><th style="width:90px">الكمية</th><th style="width:120px">السعر</th><th style="width:100px">الخصم</th><th style="width:120px">الضريبة</th><th class="amt" style="width:120px">الإجمالي</th><th style="width:44px"></th></tr></thead><tbody id="lines"></tbody></table></div>
      <button type="button" class="btn ghost sm" style="margin-top:8px" id="addl">${icon('plus')}إضافة سطر</button>
      ${c.landed ? `<fieldset style="margin-top:20px"><legend>تكاليف الشحن والجمارك والتخليص <span class="xs muted">— تُوزَّع على تكلفة الأصناف المخزنية حسب القيمة</span></legend><div id="lcs"></div>
        <button type="button" class="btn ghost sm" id="addlc">${icon('plus')}إضافة تكلفة</button></fieldset>` : ''}
      <div class="totals" aria-live="polite"><div><span class="muted">المجموع قبل الضريبة</span><span class="num" id="tSub"></span></div><div><span class="muted">ضريبة القيمة المضافة</span><span class="num" id="tVat"></span></div><div class="grand"><span>الإجمالي</span><span class="num" id="tTot"></span></div></div>
      ${c.payNow ? `<div class="card" style="background:var(--c-bg);margin:12px 0"><label class="row" style="gap:8px"><input type="checkbox" id="paynow" name="paynow"> سُدّدت الآن — أنشئ سند صرف بالإجمالي عند الترحيل</label>
        <div id="payw" hidden style="margin-top:8px">${select('pay_account', 'دُفعت من', payAccts(accs).map(a => [a.id, `${a.code} — ${a.name_ar}`]), payAccts(accs).find(a => a.system_key === 'bank')?.id)}</div></div>` : ''}
      ${field('note', c.supplierRef ? 'ملاحظات / رقم فاتورة المورد' : 'ملاحظات', { value: doc.note || '' })}
      <p class="help err" id="ierr" role="alert"></p>
      <div class="row" style="justify-content:flex-end;margin-top:16px;flex-wrap:wrap">${existing ? '<button type="button" class="btn ghost" id="deld" style="color:var(--c-danger)">حذف المسودة</button>' : ''}<a class="btn ghost" href="#/${key}">إلغاء</a>
        <button type="button" class="btn secondary" id="saved">حفظ كمسودة</button>
        ${!canPost && !c.issue ? '<button type="button" class="btn secondary" id="submitd">إرسال للاعتماد</button>' : ''}
        ${canPost || c.issue ? `<button class="btn primary" type="submit">${esc(c.postLabel)}</button>` : ''}</div>
    </form>`;
  const itemOpts = sel => `<option value="">— بدون صنف —</option>` + items.map(i => `<option value="${esc(i.id)}"${i.id === sel ? ' selected' : ''}>${esc(i.name_ar)}${i.sku ? ' · ' + esc(i.sku) : ''}</option>`).join('');
  const drawLines = () => {
    $('#lines').innerHTML = lines.map((l, i) => { const it = itemById[l.item_id], stocked = it?.track_stock;
      return `<tr data-i="${i}"><td class="num muted m-hide">${i + 1}</td>
      <td data-l="الصنف"><select class="input" data-k="item_id" aria-label="الصنف — سطر ${i + 1}">${itemOpts(l.item_id)}</select>${it?.track_stock ? `<span class="xs muted">المتاح: <span class="num">${fq(it.on_hand)}</span> ${esc(it.unit)}</span>` : ''}</td>
      ${c.accounts ? `<td data-l="الحساب">${stocked ? '<span class="xs muted">مخزون</span>' : `<select class="input" data-k="account_id" aria-label="الحساب — سطر ${i + 1}">${acctOpts(lineAccts, l.account_id, '— مصروفات أخرى —')}</select>`}</td>` : ''}
      <td data-l="الوصف"><input class="input" data-k="description" value="${esc(l.description)}" aria-label="الوصف — سطر ${i + 1}"></td>
      <td data-l="الكمية"><input class="input num" data-k="qty" inputmode="decimal" value="${esc(l.qty)}" aria-label="الكمية"></td>
      <td data-l="السعر (قبل الضريبة)"><input class="input num" data-k="unit_price" inputmode="decimal" value="${esc(money(l.unit_price))}" aria-label="السعر قبل الضريبة"></td>
      <td data-l="الخصم"><input class="input num" data-k="discount" inputmode="decimal" value="${esc(l.discount ? money(l.discount) : '')}" aria-label="الخصم" placeholder="0.00"></td>
      <td data-l="الضريبة"><select class="input" data-k="tax_category" aria-label="نوع الضريبة">${Object.entries(TAXCAT).map(([k, t]) => `<option value="${k}"${k === l.tax_category ? ' selected' : ''}>${t}</option>`).join('')}</select></td>
      <td class="amt num line-total" data-l="الإجمالي" data-total></td>
      <td><button type="button" class="btn ghost icon sm" data-del aria-label="حذف السطر ${i + 1}">${icon('trash')}</button></td></tr>`; }).join('');
    totals();
  };
  const drawLc = () => { if (!$('#lcs')) return; $('#lcs').innerHTML = lc.map((x, i) => `<div class="row" data-c="${i}" style="margin-bottom:8px"><input class="input" data-ck="description" value="${esc(x.description)}" placeholder="مثل: شحن بحري، جمارك" aria-label="وصف التكلفة" style="flex:2">
    <input class="input num" data-ck="amount" inputmode="decimal" value="${x.amount ? esc(money(x.amount)) : ''}" placeholder="0.00" aria-label="المبلغ" style="flex:1"><button type="button" class="btn ghost icon sm" data-cdel aria-label="حذف التكلفة">${icon('trash')}</button></div>`).join(''); };
  const totals = () => { let s = 0, v = 0; lines.forEach((l, i) => { const k = lineCalc(l); const ok = Number.isFinite(k.net); s += ok ? k.net : 0; v += ok ? k.vat : 0;
      const cell = $(`tr[data-i="${i}"] [data-total]`); if (cell) cell.textContent = ok ? money(k.net + k.vat) : '—'; });
    $('#tSub').textContent = money(s); $('#tVat').textContent = money(v); $('#tTot').textContent = money(s + v) + ' ر.س'; };
  $('#lines').addEventListener('input', e => { const tr = e.target.closest('tr'), k = e.target.dataset.k; if (!tr || !k) return; const l = lines[tr.dataset.i];
    if (k === 'qty') l.qty = num(e.target.value); else if (k === 'unit_price' || k === 'discount') l[k] = toHalalas(e.target.value || 0); else if (k === 'description') l.description = e.target.value; totals(); });
  $('#lines').addEventListener('change', e => { const tr = e.target.closest('tr'), k = e.target.dataset.k; if (!tr) return; const l = lines[tr.dataset.i];
    if (k === 'item_id') { l.item_id = e.target.value; const it = itemById[l.item_id];
      if (it) { l.description = it.name_ar; l.unit_price = Math.round(Number(it[c.price]) || 0); l.tax_category = it.tax_category; l.vat_rate = it.tax_category === 'S' ? 15 : 0; if (it.track_stock) l.account_id = ''; } drawLines(); }
    if (k === 'account_id') l.account_id = e.target.value;
    if (k === 'tax_category') { l.tax_category = e.target.value; l.vat_rate = l.tax_category === 'S' ? 15 : 0; totals(); } });
  $('#lines').addEventListener('click', e => { if (e.target.closest('[data-del]')) { lines.splice(e.target.closest('tr').dataset.i, 1); if (!lines.length) lines.push(blank()); drawLines(); } });
  $('#addl').onclick = () => { lines.push(blank()); drawLines(); $(`tr[data-i="${lines.length - 1}"] select`).focus(); };
  if ($('#lcs')) { $('#addlc').onclick = () => { lc.push({ description: '', amount: 0 }); drawLc(); };
    $('#lcs').addEventListener('input', e => { const r = e.target.closest('[data-c]'); if (!r) return; const x = lc[r.dataset.c]; if (e.target.dataset.ck === 'amount') x.amount = toHalalas(e.target.value || 0); else x.description = e.target.value; });
    $('#lcs').addEventListener('click', e => { if (e.target.closest('[data-cdel]')) { lc.splice(e.target.closest('[data-c]').dataset.c, 1); drawLc(); } }); }
  if ($('#paynow')) $('#paynow').onchange = e => $('#payw').hidden = !e.target.checked;
  if ($('#qparty')) $('#qparty').onclick = e => { e.preventDefault(); partyDrawer(null, async p => { toast('تمت الإضافة'); parties.push(p); $('#f-party').innerHTML = optList(parties.map(x => [x.id, x.name]), p.id, c.side === 'supplier' ? '— اختر المورد —' : '— عميل نقدي —'); }, c.side); };
  const validate = () => { const err = []; if (!$('#f-issue_date').value) err.push('التاريخ مطلوب');
    if (c.side === 'supplier' && !$('#f-party').value) err.push('اختر المورد');
    const real = lines.filter(l => l.description?.trim() || l.item_id);
    if (!real.length) err.push('أضف سطراً واحداً على الأقل');
    real.forEach((l, i) => { if (!l.description?.trim()) err.push(`السطر ${i + 1}: الوصف مطلوب`); if (!(l.qty > 0)) err.push(`السطر ${i + 1}: الكمية يجب أن تكون أكبر من صفر`);
      if (!Number.isFinite(l.unit_price) || l.unit_price < 0) err.push(`السطر ${i + 1}: السعر غير صحيح`); if (!Number.isFinite(l.discount) || l.discount < 0 || l.discount > Math.round(l.qty * l.unit_price)) err.push(`السطر ${i + 1}: الخصم غير صحيح`); });
    lc.forEach((x, i) => { if (!(x.amount > 0) || !x.description.trim()) err.push(`تكلفة الشحن ${i + 1}: الوصف والمبلغ مطلوبان`); });
    return { err, real }; };
  const save = async mode => { const { err, real } = validate(); $('#ierr').textContent = err.join(' · '); if (err.length) return;
    const btns = $$('#docf button'); btns.forEach(b => b.disabled = true);
    try {
      const f = Object.fromEntries(new FormData($('#docf')));
      const d = { ...(existing ? { id: existing.id } : {}), kind: f.kind || c.kinds[0][0], party_id: existing?.source ? existing.party_id : (f.party_id || null), issue_date: f.issue_date,
        issue_time: riyadhTime(), due_date: f.due_date || null, note: f.note, warehouse_id: f.warehouse_id || null, branch_id: existing?.branch_id || null, related_document_id: existing?.related_document_id || null, cost_center_id: f.cost_center_id || null };
      const newId = await api.saveDraft(d, real.map(l => ({ ...l, item_id: l.item_id || null, account_id: itemById[l.item_id]?.track_stock ? null : (l.account_id || null), discount: l.discount || 0 })));
      if (c.landed) await api.saveLanded(newId, lc.filter(x => x.amount > 0));
      if (mode === 'submit') { await api.submitForApproval('documents', newId); toast('أُرسل للاعتماد'); }
      else if (mode === 'post') { await api.postDocument(d.kind, newId); toast(c.issue ? 'تم الإصدار' : 'تم الترحيل وتسجيل القيد');
        if (c.payNow && f.paynow) { const posted = await api.getDocument(newId);
          await api.createReceipt({ kind: 'payment', party_id: posted.party_id, pay_date: posted.issue_date, amount: posted.total, method: 'bank_transfer', cash_account_id: f.pay_account, reference: 'سداد ' + posted.number, allocations: [{ document_id: newId, amount: posted.total }] });
          toast('أُنشئ سند الصرف'); } }
      else toast('تم حفظ المسودة');
      location.hash = '#/' + key + '/' + newId + (mode === 'draft' ? '/edit' : '');
      if (mode === 'draft' && existing) docEditView(key, newId);
    } catch (x) { fail(x); $('#ierr').textContent = x.message; btns.forEach(b => b.disabled = false); } };
  $('#docf').addEventListener('submit', e => { e.preventDefault(); save('post'); });
  $('#saved').onclick = () => save('draft');
  if ($('#submitd')) $('#submitd').onclick = () => save('submit');
  if (existing) $('#deld').onclick = async e => { if (!confirmBtn(e.target)) return; await api.deleteDraft(existing.id); toast('حُذفت المسودة'); location.hash = '#/' + key; };
  drawLines(); drawLc();
}

function docPaper(d, title, qrSvg) {
  const o = ORG, p = d.party;
  const addr = x => [x?.building_no && 'مبنى ' + x.building_no, x?.street, x?.district, x?.city, x?.postal_code].filter(Boolean).map(esc).join('، ');
  return `<article class="paper" aria-label="${esc(KIND_NAME[d.kind])}">
    <div class="hd"><div>${o.logo_path ? `<img src="${esc(o.logo_path)}" alt="شعار ${esc(o.name_ar)}" style="max-height:56px;max-width:160px;display:block;margin-bottom:8px">` : ''}
      <b style="font-size:18px">${esc(o.name_ar)}</b><br>${o.vat_number ? `الرقم الضريبي: <span class="num">${esc(o.vat_number)}</span><br>` : ''}${addr(o)}</div>
      <div style="text-align:end"><b style="font-size:18px">${title}</b><br>الرقم: <span class="num">${esc(d.number || 'مسودة')}</span><br>التاريخ: <span class="num">${esc(d.issue_date)}</span>
        ${d.due_date ? `<br>${d.kind === 'quote' ? 'صالح حتى' : d.kind === 'purchase_order' ? 'التسليم' : 'الاستحقاق'}: <span class="num">${esc(d.due_date)}</span>` : ''}${d.source ? `<br>المرجع: <span class="num">${esc(d.source.number)}</span>` : ''}</div></div>
    <p style="margin:0 0 12px"><b>${['purchase_bill', 'purchase_order', 'purchase_return'].includes(d.kind) ? 'المورد' : 'العميل'}:</b> ${esc(p?.name || 'عميل نقدي')}${p?.vat_number ? ` — الرقم الضريبي <span class="num">${esc(p.vat_number)}</span>` : ''}${addr(p) ? `<br>${addr(p)}` : ''}</p>
    <div style="overflow-x:auto"><table><thead><tr><th>#</th><th>الوصف</th><th>الكمية</th><th class="amt">السعر</th><th class="amt">الخصم</th><th class="amt">قبل الضريبة</th><th class="amt">الضريبة</th><th class="amt">الإجمالي</th></tr></thead>
      <tbody>${d.lines.map((l, i) => `<tr><td class="num">${i + 1}</td><td style="white-space:normal">${esc(l.description)}</td><td class="num">${fq(l.qty)}</td><td class="amt num">${money(l.unit_price)}</td><td class="amt num">${l.discount ? money(l.discount) : '—'}</td>
        <td class="amt num">${money(l.line_net || lineCalc(l).net)}</td><td class="amt num">${money(l.line_vat || lineCalc(l).vat)}</td><td class="amt num">${money((l.line_net || lineCalc(l).net) + (l.line_vat || lineCalc(l).vat))}</td></tr>`).join('')}</tbody></table></div>
    <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin-top:16px;flex-wrap:wrap"><div>${qrSvg || ''}</div>
      <div style="width:min(300px,100%)"><div style="display:flex;justify-content:space-between">الإجمالي قبل الضريبة<span class="num">${money(d.subtotal)}</span></div>
        <div style="display:flex;justify-content:space-between">ضريبة القيمة المضافة<span class="num">${money(d.vat_total)}</span></div>
        <div style="display:flex;justify-content:space-between;font-weight:700;border-top:2px solid #000;margin-top:6px;padding-top:6px">الإجمالي (ر.س)<span class="num">${money(d.total)}</span></div>
        ${d.kind === 'purchase_bill' && d.amount_paid ? `<div style="display:flex;justify-content:space-between">المسدد<span class="num">${money(d.amount_paid)}</span></div><div style="display:flex;justify-content:space-between;font-weight:700">المتبقي<span class="num">${money(d.total - d.amount_paid)}</span></div>` : ''}</div></div>
    ${d.note ? `<p style="margin-top:12px">${esc(d.note)}</p>` : ''}${o.invoice_footer && ['quote', 'credit_note'].includes(d.kind) ? `<p style="margin-top:12px;color:#444;font-size:12px">${esc(o.invoice_footer)}</p>` : ''}
  </article>`;
}

function journalCard(d) {
  if (!d.entry || !can('accounting')) return '';
  return `<section class="card"><h3 style="margin-bottom:8px">القيد المحاسبي <span class="muted xs">(رقم <a class="num" href="#/journal/${esc(d.entry.id)}">${esc(d.entry.number)}</a>)</span></h3>
    <div class="tbl-wrap"><table><thead><tr><th>الحساب</th><th class="amt">مدين</th><th class="amt">دائن</th></tr></thead><tbody>
    ${d.journal.map(l => `<tr><td><span class="num muted">${esc(l.code)}</span> ${esc(l.name_ar)}</td><td class="amt num">${l.debit ? money(l.debit) : ''}</td><td class="amt num">${l.credit ? money(l.credit) : ''}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td>المجموع</td><td class="amt num">${money(d.journal.reduce((a, l) => a + Number(l.debit), 0))}</td><td class="amt num">${money(d.journal.reduce((a, l) => a + Number(l.credit), 0))}</td></tr></tfoot></table></div></section>`;
}
const relatedCard = d => (d.related?.length ? `<section class="card"><h3 style="margin-bottom:8px">مستندات مرتبطة</h3><ul style="margin:0;padding-inline-start:18px">
  ${d.related.map(r => `<li><a href="${docLink(r)}">${esc(KIND_NAME[r.kind])} <span class="num">${esc(r.number || 'مسودة')}</span></a> ${r.status === 'draft' ? badge(['مسودة', 'b-draft']) : ''}${r.total ? ` — <span class="num">${money(r.total)}</span>` : ''}</li>`).join('')}</ul></section>` : '');

async function docView(key, id) {
  const c = DOCS[key]; shell(key, loading());
  const d = await api.getDocument(id);
  if (d.status === 'draft' && can(c.module, 'create')) { location.hash = '#/' + key + '/' + id + '/edit'; return; }
  let qrSvg = '';
  if (c.qr && d.status === 'posted') { try { const ts = `${d.issue_date}T${(d.issue_time || '00:00:00').slice(0, 8)}+03:00`;
    qrSvg = QR.svg(QR.encode(QR.ascii(QR.zatcaTLV({ seller: ORG.name_ar, vatNo: ORG.vat_number || '', timestamp: new Date(ts).toISOString().replace('.000', ''), total: (d.total / 100).toFixed(2), vat: (d.vat_total / 100).toFixed(2) }))), 3); } catch { qrSvg = ''; } }
  const open = d.total - d.amount_paid, actions = [];
  if (d.status === 'posted' && c.convert && can(DOCS[KIND_ROUTE[c.convert[0][0]]]?.module || 'sales', 'create'))
    c.convert.forEach(([t, label]) => actions.push(`<button class="btn primary" data-conv="${t}">${esc(label)}</button>`));
  if (d.status === 'posted' && d.kind === 'purchase_bill') {
    if (open > 0 && can('purchases', 'create')) actions.push(`<a class="btn primary" href="#/payments/new?party=${esc(d.party_id)}&doc=${esc(d.id)}">${icon('receipt')}سند صرف</a>`);
    if (can('purchases', 'create')) actions.push(`<button class="btn secondary" data-conv="purchase_return">إرجاع للمورد</button>`); }
  if (d.status === 'draft' && d.submitted_at && can(c.module, 'post')) actions.push(`<button class="btn primary" id="approve">اعتماد وترحيل</button>`);
  $('#main').innerHTML = `<a class="crumb no-print" href="#/${key}">${icon('chev')} ${esc(c.title)}</a>
    <div class="page-head no-print"><h1><span class="num">${esc(d.number || 'مسودة')}</span></h1>${d.kind === 'purchase_bill' && d.status === 'posted' ? badge(PAY[d.payment_status]) : statusBadge(d)}
      <button class="btn secondary" onclick="window.print()">${icon('down')}طباعة / PDF</button>${actions.join('')}</div>
    ${d.source ? `<p class="note no-print" style="margin-bottom:16px">مرتبط بـ <a href="${docLink(d.source)}">${esc(KIND_NAME[d.source.kind])} <span class="num">${esc(d.source.number)}</span></a></p>` : ''}
    ${docPaper(d, c.paper, qrSvg)}
    <div class="grid g2 no-print" style="margin-top:24px">${journalCard(d)}${relatedCard(d)}
      ${d.kind === 'purchase_bill' ? `<section class="card"><h3 style="margin-bottom:8px">السداد</h3>${d.payments.length ? `<div class="tbl-wrap"><table><thead><tr><th>السند</th><th>التاريخ</th><th class="amt">المبلغ</th></tr></thead><tbody>
        ${d.payments.map(a => `<tr><td class="num">${esc(a.payment?.number)}</td><td class="num">${esc(a.payment?.pay_date)}</td><td class="amt num">${money(a.amount)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">لم يُسجَّل سداد بعد.</p>'}</section>` : ''}</div>`;
  $$('[data-conv]').forEach(b => b.onclick = async () => { b.disabled = true;
    try { const nid = await api.convertDocument(d.id, b.dataset.conv); toast('أُنشئت مسودة — راجعها ثم رحّلها'); location.hash = '#/' + KIND_ROUTE[b.dataset.conv] + '/' + nid + '/edit'; } catch (x) { fail(x); b.disabled = false; } });
  if ($('#approve')) $('#approve').onclick = async e => { e.target.disabled = true; try { await api.postDocument(d.kind, d.id); toast('تم الاعتماد والترحيل'); docView(key, id); } catch (x) { fail(x); e.target.disabled = false; } };
}
const docRoutes = key => [
  [new RegExp(`^#\\/${key}$`), gate(key, DOCS[key].title, DOCS[key].module, () => docListView(key))],
  [new RegExp(`^#\\/${key}\\/new$`), gate(key, DOCS[key].title, DOCS[key].module, () => docEditView(key, null))],
  [new RegExp(`^#\\/${key}\\/([\\w-]+)\\/edit$`), gate(key, DOCS[key].title, DOCS[key].module, m => docEditView(key, m[1]))],
  [new RegExp(`^#\\/${key}\\/([\\w-]+)$`), gate(key, DOCS[key].title, DOCS[key].module, m => docView(key, m[1]))]];

// ---------- suppliers ----------
async function suppliersView() {
  shell('suppliers', loading()); const [ps, docs] = await Promise.all([api.listParties('supplier'), api.listDocuments(['purchase_bill'])]);
  const bal = {}; docs.filter(d => d.status === 'posted').forEach(d => bal[d.party_id] = (bal[d.party_id] || 0) + d.total - d.amount_paid);
  $('#main').innerHTML = `<div class="page-head"><h1>الموردون</h1>${can('purchases', 'create') ? `<button class="btn primary" id="newp">${icon('plus')}مورد جديد</button>` : ''}</div>
    ${ps.length ? `<div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>الاسم</th><th>الرقم الضريبي</th><th>الجوال</th><th class="amt">المستحق له</th><th></th></tr></thead><tbody>
    ${ps.map(p => `<tr class="click" data-href="#/suppliers/${esc(p.id)}"><td style="white-space:normal"><a class="rowlink" href="#/suppliers/${esc(p.id)}">${esc(p.name)}</a></td><td class="num m-sub">${esc(p.vat_number || '—')}</td><td class="num m-hide">${esc(p.phone || '')}</td><td class="amt num">${money(bal[p.id] || 0)}</td>
      <td class="m-hide">${can('purchases', 'create') ? `<button class="btn ghost sm" data-edit="${esc(p.id)}">تعديل</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
    : empty('users', 'لا يوجد موردون بعد', 'أضف الموردين لتسجيل فواتير الشراء والسداد لهم.', can('purchases', 'create') ? `<button class="btn primary" id="newp2">${icon('plus')}إضافة مورد</button>` : '')}`;
  const add = () => partyDrawer(null, () => { toast('تمت إضافة المورد'); suppliersView(); }, 'supplier');
  if ($('#newp')) $('#newp').onclick = add; if ($('#newp2')) $('#newp2').onclick = add;
  $$('[data-edit]').forEach(b => b.onclick = () => partyDrawer(ps.find(p => p.id === b.dataset.edit), () => { toast('تم الحفظ'); suppliersView(); }, 'supplier'));
}
async function supplierView(id) {
  shell('suppliers', loading()); const ps = await api.listParties(); const p = ps.find(x => x.id === id); if (!p) throw new AppError('المورد غير موجود');
  const rows = await api.partyStatement(id, 'supplier'), bal = rows.at(-1)?.balance || 0;
  $('#main').innerHTML = `<a class="crumb" href="#/suppliers">${icon('chev')} الموردون</a><div class="page-head"><h1>${esc(p.name)}</h1>
      ${can('purchases', 'create') ? `<button class="btn secondary" id="ed">تعديل</button><a class="btn secondary" href="#/bills/new">فاتورة مشتريات</a><a class="btn primary" href="#/payments/new?party=${esc(p.id)}">${icon('receipt')}سند صرف</a>` : ''}</div>
    <div class="grid g3" style="margin-bottom:20px"><div class="card stat"><div class="label">المستحق للمورد</div><div class="val num">${money(bal)}</div></div>
    <div class="card" style="grid-column:span 2"><dl class="kv"><dt>الرقم الضريبي</dt><dd class="num">${esc(p.vat_number || '—')}</dd><dt>العنوان</dt><dd>${esc([p.building_no, p.street, p.district, p.city].filter(Boolean).join('، ') || '—')}</dd><dt>التواصل</dt><dd class="num">${esc([p.phone, p.email].filter(Boolean).join(' · ') || '—')}</dd></dl></div></div>
    <h2 style="margin-bottom:12px">كشف حساب المورد</h2>
    ${rows.length ? `<div class="tbl-wrap"><table><thead><tr><th>التاريخ</th><th>المستند</th><th>البيان</th><th class="amt">له</th><th class="amt">عليه</th><th class="amt">الرصيد المستحق</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td class="num">${esc(r.date)}</td><td class="num">${r.link ? `<a href="${esc(r.link)}">${esc(r.ref)}</a>` : esc(r.ref)}</td><td>${esc(r.what)}</td><td class="amt num">${r.debit ? money(r.debit) : ''}</td><td class="amt num">${r.credit ? money(r.credit) : ''}</td><td class="amt num">${money(r.balance)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">لا توجد حركات بعد.</p>'}`;
  if ($('#ed')) $('#ed').onclick = () => partyDrawer(p, () => { toast('تم الحفظ'); supplierView(id); }, 'supplier');
}

// ---------- payment vouchers (to suppliers) ----------
async function paymentsView() {
  shell('payments', loading()); const pays = await api.listPayments('payment');
  $('#main').innerHTML = `<div class="page-head"><h1>سندات الصرف</h1>${can('purchases', 'create') ? `<a class="btn primary" href="#/payments/new">${icon('plus')}سند صرف</a>` : ''}</div>
  ${pays.length ? `<div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>الرقم</th><th>المورد</th><th>التاريخ</th><th>الطريقة</th><th class="amt">المبلغ</th></tr></thead><tbody>
    ${pays.map(p => `<tr><td class="num"><b>${esc(p.number)}</b></td><td class="m-sub" style="white-space:normal">${esc(p.party_name)}</td><td class="num m-hide">${esc(p.pay_date)}</td><td class="m-hide">${esc(METHOD[p.method] || p.method)}</td><td class="amt num">${money(p.amount)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="4">الإجمالي</td><td class="amt num">${money(pays.reduce((a, p) => a + Number(p.amount), 0))}</td></tr></tfoot></table></div>`
  : empty('receipt', 'لا توجد سندات صرف', 'سجّل ما تدفعه للموردين، ويُخصم تلقائياً من فواتيرهم.', can('purchases', 'create') ? `<a class="btn primary" href="#/payments/new">${icon('plus')}سند صرف</a>` : '')}`;
}
async function paymentNewView(qs) {
  shell('payments', loading());
  if (!can('purchases', 'create')) { location.hash = '#/payments'; return; }
  const [ps, docs, accs] = await Promise.all([api.listParties('supplier'), api.listDocuments(['purchase_bill']), api.listAccounts()]);
  const openDocs = docs.filter(d => d.status === 'posted' && d.payment_status !== 'paid'), pa = payAccts(accs);
  let party = qs.get('party') || '', alloc = {}; const pre = qs.get('doc');
  $('#main').innerHTML = `<a class="crumb" href="#/payments">${icon('chev')} سندات الصرف</a><div class="page-head"><h1>سند صرف جديد</h1></div>
    <form class="card" id="pf" novalidate style="max-width:var(--l-form-max)">
      <div class="form-grid"><div class="field"><label for="f-party">المورد <span aria-hidden="true" style="color:var(--c-danger)">*</span></label><select class="input" id="f-party" name="party_id">${optList(ps.map(p => [p.id, p.name]), party, '— اختر المورد —')}</select></div>
      ${field('pay_date', 'التاريخ', { type: 'date', value: riyadhToday(), req: true })}
      ${field('amount', 'المبلغ المدفوع', { type: 'money', req: true })}
      ${select('method', 'طريقة الدفع', Object.entries(METHOD), 'bank_transfer')}
      ${select('cash_account_id', 'دُفع من حساب', pa.map(a => [a.id, `${a.code} — ${a.name_ar}`]), pa.find(a => a.system_key === 'bank')?.id)}
      ${field('reference', 'المرجع', { help: 'رقم الحوالة أو الشيك (اختياري)' })}</div>
      <h3 style="margin:20px 0 8px">توزيع المبلغ على فواتير المورد</h3><div id="allocs"></div>
      <p class="help err" id="perr" role="alert"></p>
      <div class="row" style="justify-content:flex-end;margin-top:16px"><a class="btn ghost" href="#/payments">إلغاء</a><button class="btn primary" type="submit">${can('purchases', 'post') ? 'حفظ وترحيل السند' : 'حفظ'}</button></div></form>`;
  const mineDocs = () => openDocs.filter(d => d.party_id === party).sort((x, y) => (y.id === pre) - (x.id === pre) || x.issue_date.localeCompare(y.issue_date));
  const draw = () => { const mine = mineDocs();
    $('#allocs').innerHTML = mine.length ? `<div class="tbl-wrap"><table class="alloc"><thead><tr><th>الفاتورة</th><th>التاريخ</th><th class="amt">المتبقي</th><th style="width:160px">المبلغ المخصص</th></tr></thead><tbody>
      ${mine.map(d => `<tr><td class="num">${esc(d.number)}</td><td class="num">${esc(d.issue_date)}</td><td class="amt num">${money(d.total - d.amount_paid)}</td><td><input class="input num" data-doc="${esc(d.id)}" inputmode="decimal" value="${alloc[d.id] ? money(alloc[d.id]) : ''}" aria-label="المبلغ المخصص للفاتورة ${esc(d.number)}"></td></tr>`).join('')}</tbody></table></div>`
      : `<p class="muted">${party ? 'لا توجد فواتير مفتوحة لهذا المورد — سيُسجَّل المبلغ دفعة مقدمة على حسابه.' : 'اختر المورد لعرض فواتيره المفتوحة.'}</p>`; };
  const auto = () => { alloc = {}; let a = toHalalas($('#f-amount').value || 0); if (!Number.isFinite(a)) a = 0;
    mineDocs().forEach(d => { const take = Math.min(a, d.total - d.amount_paid); if (take > 0) { alloc[d.id] = take; a -= take; } }); draw(); };
  $('#f-party').onchange = e => { party = e.target.value; auto(); }; $('#f-amount').oninput = auto;
  $('#allocs').addEventListener('input', e => { const i = e.target.closest('[data-doc]'); if (!i) return; const v = toHalalas(i.value || 0); alloc[i.dataset.doc] = Number.isFinite(v) ? v : 0; });
  if (pre) { const d = openDocs.find(x => x.id === pre); if (d) { party = d.party_id; $('#f-party').value = party; $('#f-amount').value = money(d.total - d.amount_paid); auto(); } } else draw();
  $('#pf').addEventListener('submit', async e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)), err = $('#perr'); err.textContent = '';
    const amount = toHalalas(f.amount); if (!f.party_id) return err.textContent = 'اختر المورد'; if (!(amount > 0)) return err.textContent = 'أدخل المبلغ';
    const allocations = Object.entries(alloc).filter(([, v]) => v > 0).map(([document_id, amount]) => ({ document_id, amount }));
    if (allocations.reduce((x, a) => x + a.amount, 0) > amount) return err.textContent = 'المبالغ الموزعة أكبر من المبلغ المدفوع';
    $('[type=submit]', e.target).disabled = true;
    try { await api.createReceipt({ kind: 'payment', party_id: f.party_id, pay_date: f.pay_date, amount, method: f.method, cash_account_id: f.cash_account_id, reference: f.reference, allocations }); toast('تم ترحيل سند الصرف');
      location.hash = pre ? '#/bills/' + pre : '#/payments'; } catch (x) { err.textContent = x.message; $('[type=submit]', e.target).disabled = false; } });
}

// ---------- expenses ----------
async function expensesView() {
  shell('expenses', loading()); const [xs, accs, ps, ccs] = await Promise.all([api.listExpenses(), api.listAccounts(), api.listParties(), api.listCostCenters()]);
  const month = riyadhToday().slice(0, 7), mx = xs.filter(x => x.status === 'posted' && x.expense_date.startsWith(month));
  $('#main').innerHTML = `<div class="page-head"><h1>المصروفات</h1>${can('expenses', 'create') ? `<button class="btn primary" id="newx">${icon('plus')}تسجيل مصروف</button>` : ''}</div>
    <div class="grid g3" style="margin-bottom:20px"><div class="card stat"><div class="label">مصروفات هذا الشهر</div><div class="val num">${money(mx.reduce((a, x) => a + x.amount + x.vat_amount, 0))}</div><div class="xs muted">${mx.length} مصروف مرحّل</div></div>
      <div class="card stat"><div class="label">بانتظار الاعتماد</div><div class="val num">${xs.filter(x => x.status === 'draft' && x.submitted_at).length}</div></div>
      <div class="card stat"><div class="label">ضريبة مدخلات هذا الشهر</div><div class="val num">${money(mx.reduce((a, x) => a + x.vat_amount, 0))}</div></div></div>
    ${xs.length ? `<div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>الرقم</th><th>التاريخ</th><th>الحساب</th><th>البيان</th><th class="amt">المبلغ</th><th class="amt">الضريبة</th><th>الحالة</th><th></th></tr></thead><tbody>
      ${xs.map(x => `<tr><td class="num">${esc(x.number || '—')}</td><td class="num m-hide">${esc(x.expense_date)}</td><td class="m-sub">${esc(x.accounts?.name_ar || '')}</td><td style="white-space:normal">${esc(x.description || '')}</td>
        <td class="amt num">${money(x.amount)}</td><td class="amt num m-hide">${x.vat_amount ? money(x.vat_amount) : '—'}</td><td>${statusBadge(x)}</td>
        <td>${x.status === 'draft' ? `${can('expenses', 'create') ? `<button class="btn ghost sm" data-edit="${esc(x.id)}">تعديل</button>` : ''}${can('expenses', 'post') ? `<button class="btn secondary sm" data-post="${esc(x.id)}">اعتماد</button>` : ''}` : ''}</td></tr>`).join('')}</tbody></table></div>`
    : empty('receipt', 'لا توجد مصروفات بعد', 'سجّل الإيجار والكهرباء والوقود وغيرها، ويُسجَّل قيدها تلقائياً.', can('expenses', 'create') ? `<button class="btn primary" id="newx2">${icon('plus')}تسجيل مصروف</button>` : '')}`;
  const open = x => expenseDrawer(x, accs, ps, ccs);
  ['#newx', '#newx2'].forEach(s => { if ($(s)) $(s).onclick = () => open(null); });
  $$('[data-edit]').forEach(b => b.onclick = () => open(xs.find(x => x.id === b.dataset.edit)));
  $$('[data-post]').forEach(b => b.onclick = async () => { b.disabled = true; try { await api.postExpense(b.dataset.post); toast('تم اعتماد المصروف وترحيله'); expensesView(); } catch (x) { fail(x); b.disabled = false; } });
}
function expenseDrawer(x, accs, ps, ccs) {
  x = x || { expense_date: riyadhToday(), paid_from_account_id: accs.find(a => a.system_key === 'cash')?.id };
  const ea = expAccts(accs), pa = [...payAccts(accs), ...accs.filter(a => a.system_key === 'ap')];
  const total0 = x.amount ? x.amount + (x.vat_amount || 0) : '';
  const f = drawer(x.id ? 'تعديل مصروف' : 'تسجيل مصروف', `
    ${field('expense_date', 'التاريخ', { type: 'date', value: x.expense_date, req: true })}
    <div class="field"><label for="f-account_id">نوع المصروف <span aria-hidden="true" style="color:var(--c-danger)">*</span></label><select class="input" id="f-account_id" name="account_id">${acctOpts(ea, x.account_id, '— اختر —')}</select></div>
    ${field('description', 'البيان', { value: x.description || '', help: 'مثل: إيجار الورشة لشهر نوفمبر' })}
    <div class="form-grid">${field('amount', 'المبلغ', { type: 'money', value: total0 ? money(total0) : '', req: true })}
      <div class="field"><label class="row" style="gap:8px;margin-top:28px"><input type="checkbox" name="has_vat" ${x.vat_amount ? 'checked' : ''}> شامل ضريبة 15%</label></div></div>
    <div class="field"><label for="f-paid_from_account_id">دُفع من</label><select class="input" id="f-paid_from_account_id" name="paid_from_account_id">${acctOpts(pa, x.paid_from_account_id)}</select>
      <span class="help">الصندوق أو البنك أو عهدة موظف، أو «الموردون» إن كان آجلاً</span></div>
    <div class="field"><label for="f-supplier_id">المورد / الجهة (اختياري)</label><select class="input" id="f-supplier_id" name="supplier_id">${optList(ps.filter(p => ['supplier', 'both'].includes(p.kind)).map(p => [p.id, p.name]), x.supplier_id, '—')}</select></div>
    ${field('supplier_vat_number', 'الرقم الضريبي للمورد', { value: x.supplier_vat_number || '', help: 'مطلوب لخصم ضريبة المدخلات', attrs: 'dir="ltr" inputmode="numeric" maxlength="15"' })}
    ${ccs.length ? `<div class="field"><label for="f-cost_center_id">المشروع / مركز التكلفة</label><select class="input" id="f-cost_center_id" name="cost_center_id">${optList(ccs.map(c => [c.id, c.name]), x.cost_center_id, '— بدون —')}</select></div>` : ''}
    ${!can('expenses', 'post') ? '<p class="note">سيُرسل المصروف لمن لديه صلاحية الاعتماد.</p>' : ''}`,
    async v => { const total = toHalalas(v.amount); if (!(total > 0)) throw new AppError('أدخل المبلغ'); if (!v.account_id) throw new AppError('اختر نوع المصروف');
      const net = v.has_vat ? Math.round(total / 1.15) : total;
      if (v.supplier_vat_number && !VAT_RE.test(toLatin(v.supplier_vat_number))) throw new AppError('الرقم الضريبي 15 رقماً ويبدأ وينتهي بـ 3');
      const r = await api.saveExpense({ ...(x.id ? { id: x.id } : {}), expense_date: v.expense_date, account_id: v.account_id, description: v.description, amount: net, vat_amount: total - net,
        paid_from_account_id: v.paid_from_account_id, supplier_id: v.supplier_id || null, supplier_vat_number: toLatin(v.supplier_vat_number) || null, cost_center_id: v.cost_center_id || null,
        submitted_at: can('expenses', 'post') ? null : new Date().toISOString() });
      if (can('expenses', 'post')) { await api.postExpense(r.id); toast('تم تسجيل المصروف وترحيله'); } else toast('أُرسل المصروف للاعتماد');
      expensesView(); }, can('expenses', 'post') ? 'حفظ وترحيل' : 'إرسال للاعتماد');
  if (x.id) { const del = document.createElement('button'); del.type = 'button'; del.className = 'btn ghost'; del.style.color = 'var(--c-danger)'; del.textContent = 'حذف';
    $('footer', f).prepend(del); del.onclick = async () => { if (!confirmBtn(del)) return; await api.deleteExpense(x.id); f.closest('.drawer-bg').remove(); toast('حُذف'); expensesView(); }; }
}

// ---------- journal ----------
async function journalView() {
  shell('journal', loading()); const es = await api.listEntries();
  const SRC = { manual: 'قيد يدوي', document: 'مستند', payment: 'سند', expense: 'مصروف', stock: 'مخزون / تصنيع', reversal: 'عكس قيد', opening: 'افتتاحي', payroll: 'رواتب' };
  $('#main').innerHTML = `<div class="page-head"><h1>القيود اليومية</h1>${can('accounting', 'post') ? `<a class="btn primary" href="#/journal/new">${icon('plus')}قيد يدوي</a>` : ''}</div>
    <p class="muted" style="margin:-8px 0 16px">كل فاتورة وسند ومصروف وأمر تصنيع يسجّل قيده هنا تلقائياً. القيد اليدوي للتسويات والأرصدة الافتتاحية.</p>
    ${es.length ? `<div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>الرقم</th><th>التاريخ</th><th>البيان</th><th>المصدر</th><th class="amt">المبلغ</th></tr></thead><tbody>
      ${es.map(e => `<tr class="click" data-href="#/journal/${esc(e.id)}"><td class="num"><a class="rowlink" href="#/journal/${esc(e.id)}">${esc(e.number)}</a></td><td class="num m-hide">${esc(e.entry_date)}</td><td style="white-space:normal">${esc(e.memo || '')}</td>
        <td class="m-sub">${esc(SRC[e.source_type] || e.source_type)}</td><td class="amt num">${money(e.journal_lines.reduce((a, l) => a + Number(l.debit), 0))}</td></tr>`).join('')}</tbody></table></div>`
    : empty('book', 'لا توجد قيود بعد', 'تظهر القيود مع أول فاتورة أو مصروف.')}`;
}
async function entryView(id) {
  shell('journal', loading()); const e = await api.getEntry(id);
  const D = e.lines.reduce((a, l) => a + Number(l.debit), 0);
  $('#main').innerHTML = `<a class="crumb" href="#/journal">${icon('chev')} القيود اليومية</a><div class="page-head"><h1>قيد رقم <span class="num">${esc(e.number)}</span></h1>
      ${e.reverses_id ? badge(['قيد عكسي', 'b-info']) : ''}${e.reversed ? badge(['معكوس', 'b-warn']) : ''}
      ${e.source_type === 'manual' && !e.reversed && can('accounting', 'post') ? '<button class="btn secondary" id="rev">عكس القيد</button>' : ''}</div>
    <div class="card" style="margin-bottom:16px"><dl class="kv"><dt>التاريخ</dt><dd class="num">${esc(e.entry_date)}</dd><dt>البيان</dt><dd>${esc(e.memo || '')}</dd>${e.reversed ? `<dt>عُكس بالقيد</dt><dd><a class="num" href="#/journal/${esc(e.reversed.id)}">${esc(e.reversed.number)}</a></dd>` : ''}</dl></div>
    <div class="tbl-wrap"><table><thead><tr><th>الحساب</th><th>الطرف</th><th>البيان</th><th class="amt">مدين</th><th class="amt">دائن</th></tr></thead><tbody>
      ${e.lines.map(l => `<tr><td><span class="num muted">${esc(l.accounts.code)}</span> ${esc(l.accounts.name_ar)}</td><td>${esc(l.parties?.name || '')}</td><td>${esc(l.memo || '')}</td><td class="amt num">${l.debit ? money(l.debit) : ''}</td><td class="amt num">${l.credit ? money(l.credit) : ''}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="3">المجموع</td><td class="amt num">${money(D)}</td><td class="amt num">${money(e.lines.reduce((a, l) => a + Number(l.credit), 0))}</td></tr></tfoot></table></div>`;
  if ($('#rev')) $('#rev').onclick = async ev => { if (!confirmBtn(ev.target, 'متأكد؟ سيُنشأ قيد معاكس بتاريخ اليوم')) return; ev.target.disabled = true;
    try { const nid = await api.reverseEntry(id, riyadhToday()); toast('تم عكس القيد'); location.hash = '#/journal/' + nid; } catch (x) { fail(x); ev.target.disabled = false; } };
}
async function entryNewView() {
  shell('journal', loading());
  if (!can('accounting', 'post')) { location.hash = '#/journal'; return; }
  const [accs, ps] = await Promise.all([api.listAccounts(), api.listParties()]);
  const post = accs.filter(a => a.is_postable);
  let lines = [{ account_id: '', debit: 0, credit: 0, memo: '', party_id: '' }, { account_id: '', debit: 0, credit: 0, memo: '', party_id: '' }];
  $('#main').innerHTML = `<a class="crumb" href="#/journal">${icon('chev')} القيود اليومية</a><div class="page-head"><h1>قيد يدوي</h1></div>
    <form class="card" id="jf" novalidate><div class="grid g3" style="margin-bottom:16px">${field('entry_date', 'التاريخ', { type: 'date', value: riyadhToday(), req: true })}${field('memo', 'البيان', { cls: 'span2', help: 'مثل: إثبات رأس المال، تسوية عهدة' })}</div>
      <div class="tbl-wrap editor"><table><thead><tr><th style="min-width:220px">الحساب</th><th style="min-width:150px">الطرف (اختياري)</th><th>البيان</th><th style="width:130px">مدين</th><th style="width:130px">دائن</th><th style="width:44px"></th></tr></thead><tbody id="jl"></tbody>
        <tfoot><tr><td colspan="3">المجموع</td><td class="amt num" id="jd"></td><td class="amt num" id="jc"></td><td></td></tr></tfoot></table></div>
      <button type="button" class="btn ghost sm" style="margin-top:8px" id="addj">${icon('plus')}إضافة سطر</button>
      <p class="help err" id="jerr" role="alert"></p>
      <div class="row" style="justify-content:flex-end;margin-top:16px"><a class="btn ghost" href="#/journal">إلغاء</a><button class="btn primary" type="submit">ترحيل القيد</button></div></form>`;
  const draw = () => { $('#jl').innerHTML = lines.map((l, i) => `<tr data-i="${i}"><td><select class="input" data-k="account_id" aria-label="الحساب — سطر ${i + 1}">${acctOpts(post, l.account_id, '— اختر الحساب —')}</select></td>
      <td><select class="input" data-k="party_id" aria-label="الطرف">${optList(ps.map(p => [p.id, p.name]), l.party_id, '—')}</select></td><td><input class="input" data-k="memo" value="${esc(l.memo)}" aria-label="البيان"></td>
      <td><input class="input num" data-k="debit" inputmode="decimal" value="${l.debit ? money(l.debit) : ''}" aria-label="مدين"></td><td><input class="input num" data-k="credit" inputmode="decimal" value="${l.credit ? money(l.credit) : ''}" aria-label="دائن"></td>
      <td><button type="button" class="btn ghost icon sm" data-del aria-label="حذف السطر">${icon('trash')}</button></td></tr>`).join(''); sum(); };
  const sum = () => { const d = lines.reduce((a, l) => a + (l.debit || 0), 0), c = lines.reduce((a, l) => a + (l.credit || 0), 0);
    $('#jd').textContent = money(d); $('#jc').textContent = money(c); $('#jd').style.color = $('#jc').style.color = d === c ? '' : 'var(--c-danger)'; };
  $('#jl').addEventListener('input', e => { const tr = e.target.closest('tr'), k = e.target.dataset.k; if (!tr || !k) return; const l = lines[tr.dataset.i];
    if (k === 'debit' || k === 'credit') { const v = toHalalas(e.target.value || 0); l[k] = Number.isFinite(v) ? v : NaN; if (l[k] > 0) { const o = k === 'debit' ? 'credit' : 'debit'; l[o] = 0; tr.querySelector(`[data-k=${o}]`).value = ''; } sum(); } else l[k] = e.target.value; });
  $('#jl').addEventListener('change', e => { const tr = e.target.closest('tr'), k = e.target.dataset.k; if (tr && e.target.tagName === 'SELECT') lines[tr.dataset.i][k] = e.target.value; });
  $('#jl').addEventListener('click', e => { if (e.target.closest('[data-del]') && lines.length > 2) { lines.splice(e.target.closest('tr').dataset.i, 1); draw(); } });
  $('#addj').onclick = () => { lines.push({ account_id: '', debit: 0, credit: 0, memo: '', party_id: '' }); draw(); };
  $('#jf').addEventListener('submit', async e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)), err = $('#jerr'); err.textContent = '';
    const real = lines.filter(l => l.account_id && (l.debit > 0 || l.credit > 0));
    if (lines.some(l => !Number.isFinite(l.debit) || !Number.isFinite(l.credit))) return err.textContent = 'مبلغ غير صحيح';
    if (real.length < 2) return err.textContent = 'القيد يحتاج سطرين على الأقل بحساب ومبلغ';
    const d = real.reduce((a, l) => a + l.debit, 0), c = real.reduce((a, l) => a + l.credit, 0);
    if (d !== c) return err.textContent = `القيد غير متوازن: المدين ${money(d)} والدائن ${money(c)}`;
    $('[type=submit]', e.target).disabled = true;
    try { const id = await api.postManualEntry(f.entry_date, f.memo, real.map(l => ({ account_id: l.account_id, debit: l.debit, credit: l.credit, memo: l.memo || null, party_id: l.party_id || null })));
      toast('تم ترحيل القيد'); location.hash = '#/journal/' + id; } catch (x) { err.textContent = x.message; $('[type=submit]', e.target).disabled = false; } });
  draw();
}

// ---------- warehouses & stock ----------
async function warehousesView() {
  shell('warehouses', loading()); const [whs, items, bal] = await Promise.all([api.listWarehouses(), api.listItems(), api.stockByWarehouse()]);
  const stock = items.filter(i => i.track_stock), q = {}; bal.forEach(b => q[b.item_id + ':' + b.warehouse_id] = b.qty);
  const val = stock.reduce((a, i) => a + Number(i.on_hand) * Number(i.avg_cost), 0);
  $('#main').innerHTML = `<div class="page-head"><h1>المستودعات والأرصدة</h1>${can('inventory', 'create') ? `<button class="btn secondary" id="neww">${icon('plus')}مستودع جديد</button><a class="btn primary" href="#/stock/new">${icon('plus')}حركة مخزون</a>` : ''}</div>
    <div class="grid g3" style="margin-bottom:20px"><div class="card stat"><div class="label">قيمة المخزون</div><div class="val num">${money(val)}</div><div class="xs muted">بمتوسط التكلفة</div></div>
      <div class="card stat"><div class="label">المستودعات</div><div class="val num">${whs.length}</div><div class="xs muted">${whs.map(w => esc(w.name)).join(' · ')}</div></div>
      <div class="card stat"><div class="label">أصناف رصيدها سالب</div><div class="val num ${stock.some(i => i.on_hand < 0) ? 'down' : ''}">${stock.filter(i => i.on_hand < 0).length}</div></div></div>
    ${stock.length ? `<div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>الصنف</th>${whs.map(w => `<th class="amt">${esc(w.name)}</th>`).join('')}<th class="amt">الإجمالي</th><th class="amt">متوسط التكلفة</th><th class="amt">القيمة</th></tr></thead><tbody>
      ${stock.map(i => `<tr><td style="white-space:normal"><b>${esc(i.name_ar)}</b> <span class="xs muted">${i.kind === 'raw_material' ? 'مادة خام' : 'منتج'}</span></td>${whs.map(w => { const v = q[i.id + ':' + w.id] || 0; return `<td class="amt num ${v < 0 ? 'down' : ''}">${v ? fq(v) : '—'}</td>`; }).join('')}
        <td class="amt num"><b class="${i.on_hand < 0 ? 'down' : ''}">${fq(i.on_hand)}</b> ${esc(i.unit)}</td><td class="amt num">${money(i.avg_cost)}</td><td class="amt num">${money(Number(i.on_hand) * Number(i.avg_cost))}</td></tr>`).join('')}</tbody></table></div>`
    : empty('box', 'لا توجد أصناف مخزنية', 'أضف المواد الخام والمنتجات من صفحة الأصناف.', '<a class="btn primary" href="#/items">الأصناف</a>')}
    <p class="muted xs" style="margin-top:12px">${ORG.allow_negative_stock ? 'البيع والصرف بدون رصيد مسموح حالياً — يمكن منعه من الإعدادات.' : 'لا يُسمح بالصرف بأكثر من الرصيد المتوفر في المستودع.'}</p>`;
  if ($('#neww')) $('#neww').onclick = () => drawer('مستودع جديد', `${field('name', 'اسم المستودع', { req: true, help: 'مثل: مستودع المواد الخام، الورشة، صالة العرض' })}
      ${select('kind', 'النوع', [['general', 'عام'], ['raw', 'مواد خام'], ['finished', 'منتجات تامة'], ['site', 'موقع مشروع']], 'general')}`,
    async v => { if (!v.name?.trim()) throw new AppError('الاسم مطلوب'); await api.saveWarehouse({ name: v.name.trim(), kind: v.kind }); toast('أُضيف المستودع'); warehousesView(); });
}
const SD_KIND = { transfer: ['تحويل بين مستودعات', 'TRF'], count: ['جرد وتسوية', 'CNT'], waste: ['تالف وهالك', 'WST'], opening: ['رصيد افتتاحي', 'OPN'] };
async function stockDocsView() {
  shell('stock', loading()); const [ds, whs] = await Promise.all([api.listStockDocs(), api.listWarehouses()]); const W = Object.fromEntries(whs.map(w => [w.id, w.name]));
  $('#main').innerHTML = `<div class="page-head"><h1>حركات المخزون</h1>${can('inventory', 'create') ? `<a class="btn primary" href="#/stock/new">${icon('plus')}حركة جديدة</a>` : ''}</div>
    <p class="muted" style="margin:-8px 0 16px">التحويل بين المستودعات، والجرد، والتالف، والأرصدة الافتتاحية. البيع والشراء والتصنيع تُحرّك المخزون تلقائياً.</p>
    ${ds.length ? `<div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>الرقم</th><th>النوع</th><th>التاريخ</th><th>المستودع</th><th class="amt">البنود</th><th>الحالة</th></tr></thead><tbody>
      ${ds.map(d => `<tr class="click" data-href="#/stock/${esc(d.id)}"><td class="num"><a class="rowlink" href="#/stock/${esc(d.id)}">${esc(d.number || 'مسودة')}</a></td><td>${esc(SD_KIND[d.kind][0])}</td><td class="num m-hide">${esc(d.doc_date)}</td>
        <td class="m-sub">${esc(d.kind === 'transfer' ? `${W[d.from_warehouse_id] || ''} ← ${W[d.to_warehouse_id] || ''}` : W[d.from_warehouse_id || d.to_warehouse_id] || '')}</td><td class="amt num">${d.stock_doc_lines.length}</td><td>${statusBadge(d)}</td></tr>`).join('')}</tbody></table></div>`
    : empty('box', 'لا توجد حركات بعد', 'ابدأ بإدخال الأرصدة الافتتاحية لمخزونك الحالي.', can('inventory', 'create') ? `<a class="btn primary" href="#/stock/new?kind=opening">رصيد افتتاحي</a>` : '')}`;
}
async function stockDocEditView(id, qs) {
  shell('stock', loading()); const [whs, items, bal, ex] = await Promise.all([api.listWarehouses(), api.listItems(), api.stockByWarehouse(), id ? api.getStockDoc(id) : null]);
  if (ex && ex.status !== 'draft') return stockDocView(id, ex);
  if (!can('inventory', 'create')) { location.hash = '#/stock'; return; }
  const stock = items.filter(i => i.track_stock), q = {}; bal.forEach(b => q[b.item_id + ':' + b.warehouse_id] = b.qty);
  const d = ex || { kind: qs?.get('kind') || 'transfer', doc_date: riyadhToday(), from_warehouse_id: whs[0]?.id, to_warehouse_id: whs[1]?.id || whs[0]?.id };
  let lines = ex?.lines?.length ? ex.lines.map(l => ({ item_id: l.item_id, qty: l.qty, unit_cost: l.unit_cost })) : [{ item_id: '', qty: '', unit_cost: null }];
  $('#main').innerHTML = `<a class="crumb" href="#/stock">${icon('chev')} حركات المخزون</a><div class="page-head"><h1>${ex ? 'تعديل مسودة' : 'حركة مخزون جديدة'}</h1>${ex ? statusBadge(ex) : ''}</div>
    <form class="card" id="sdf" novalidate><div class="grid g3" style="margin-bottom:16px">
      ${select('kind', 'نوع الحركة', Object.entries(SD_KIND).map(([k, v]) => [k, v[0]]), d.kind)}${field('doc_date', 'التاريخ', { type: 'date', value: d.doc_date, req: true })}
      <div class="field" id="wfrom"><label for="f-from">من مستودع</label><select class="input" id="f-from" name="from_warehouse_id">${optList(whs.map(w => [w.id, w.name]), d.from_warehouse_id)}</select></div>
      <div class="field" id="wto"><label for="f-to">إلى مستودع</label><select class="input" id="f-to" name="to_warehouse_id">${optList(whs.map(w => [w.id, w.name]), d.to_warehouse_id)}</select></div></div>
      <p class="note" id="sdhelp" style="margin-bottom:12px"></p>
      <div class="tbl-wrap editor"><table><thead><tr><th style="min-width:200px">الصنف</th><th class="amt">الرصيد الحالي</th><th style="width:140px" id="qh">الكمية</th><th style="width:140px" id="ch">تكلفة الوحدة</th><th style="width:44px"></th></tr></thead><tbody id="sl"></tbody></table></div>
      <button type="button" class="btn ghost sm" style="margin-top:8px" id="adds">${icon('plus')}إضافة صنف</button>
      ${field('note', 'ملاحظات', { value: d.note || '' })}
      <p class="help err" id="serr2" role="alert"></p>
      <div class="row" style="justify-content:flex-end;margin-top:16px">${ex ? '<button type="button" class="btn ghost" id="dels" style="color:var(--c-danger)">حذف المسودة</button>' : ''}<a class="btn ghost" href="#/stock">إلغاء</a>
        <button type="button" class="btn secondary" id="saves">حفظ كمسودة</button>${can('inventory', 'post') ? '<button class="btn primary" type="submit">ترحيل</button>' : '<button type="button" class="btn secondary" id="subs">إرسال للاعتماد</button>'}</div></form>`;
  const HELP = { transfer: 'تنقل البضاعة بسعر التكلفة بين المستودعين، بدون قيد محاسبي.', count: 'أدخل الكمية الفعلية المعدودة؛ يُحسب الفرق عن رصيد النظام ويُسجَّل قيد فروقات الجرد.',
    waste: 'تُخصم الكمية من المستودع بمتوسط التكلفة وتُسجَّل في حساب الهالك والتالف.', opening: 'لإدخال المخزون الموجود عند بدء استخدام النظام — بالكمية وتكلفة الوحدة.' };
  const kind = () => $('#f-kind').value, wh = () => kind() === 'opening' ? $('#f-to').value : $('#f-from').value;
  const draw = () => { const k = kind();
    $('#wfrom').hidden = k === 'opening'; $('#wto').hidden = k !== 'transfer' && k !== 'opening'; $('#wto label').textContent = k === 'opening' ? 'المستودع' : 'إلى مستودع';
    $('#sdhelp').textContent = HELP[k]; $('#qh').textContent = k === 'count' ? 'الكمية الفعلية' : 'الكمية'; $('#ch').hidden = k !== 'opening';
    $('#sl').innerHTML = lines.map((l, i) => `<tr data-i="${i}"><td><select class="input" data-k="item_id" aria-label="الصنف">${optList(stock.map(s => [s.id, s.name_ar]), l.item_id, '— اختر —')}</select></td>
      <td class="amt num">${l.item_id ? fq(q[l.item_id + ':' + wh()] || 0) : ''}</td><td><input class="input num" data-k="qty" inputmode="decimal" value="${l.qty ?? ''}" aria-label="الكمية"></td>
      <td ${k !== 'opening' ? 'hidden' : ''}><input class="input num" data-k="unit_cost" inputmode="decimal" value="${l.unit_cost != null ? money(l.unit_cost) : ''}" aria-label="تكلفة الوحدة"></td>
      <td><button type="button" class="btn ghost icon sm" data-del aria-label="حذف">${icon('trash')}</button></td></tr>`).join(''); };
  ['#f-kind', '#f-from', '#f-to'].forEach(s => $(s).addEventListener('change', draw));
  $('#sl').addEventListener('input', e => { const tr = e.target.closest('tr'), k = e.target.dataset.k; if (!tr || !k) return; const l = lines[tr.dataset.i]; if (k === 'qty') l.qty = num(e.target.value); if (k === 'unit_cost') l.unit_cost = toHalalas(e.target.value || 0); });
  $('#sl').addEventListener('change', e => { const tr = e.target.closest('tr'); if (tr && e.target.dataset.k === 'item_id') { const l = lines[tr.dataset.i]; l.item_id = e.target.value; if (kind() === 'opening' && l.unit_cost == null) l.unit_cost = Math.round(Number(stock.find(s => s.id === l.item_id)?.avg_cost) || 0); draw(); } });
  $('#sl').addEventListener('click', e => { if (e.target.closest('[data-del]')) { lines.splice(e.target.closest('tr').dataset.i, 1); if (!lines.length) lines.push({ item_id: '', qty: '', unit_cost: null }); draw(); } });
  $('#adds').onclick = () => { lines.push({ item_id: '', qty: '', unit_cost: null }); draw(); };
  const save = async mode => { const f = Object.fromEntries(new FormData($('#sdf'))), err = $('#serr2'); err.textContent = '';
    const real = lines.filter(l => l.item_id); if (!real.length) return err.textContent = 'أضف صنفاً واحداً على الأقل';
    if (real.some(l => !Number.isFinite(l.qty) || l.qty < 0 || (l.qty === 0 && f.kind !== 'count'))) return err.textContent = 'تحقق من الكميات';
    if (f.kind === 'transfer' && f.from_warehouse_id === f.to_warehouse_id) return err.textContent = 'اختر مستودعين مختلفين';
    const btns = $$('#sdf button'); btns.forEach(b => b.disabled = true);
    try { const sid = await api.saveStockDoc({ ...(ex ? { id: ex.id } : {}), kind: f.kind, doc_date: f.doc_date, note: f.note,
        from_warehouse_id: f.kind === 'opening' ? null : f.from_warehouse_id, to_warehouse_id: ['transfer', 'opening'].includes(f.kind) ? f.to_warehouse_id : null,
        submitted_at: mode === 'submit' ? new Date().toISOString() : null }, real.map(l => ({ ...l, unit_cost: f.kind === 'opening' ? l.unit_cost : null })));
      if (mode === 'post') { await api.postStockDoc(sid); toast('تم الترحيل'); location.hash = '#/stock/' + sid; } else { toast(mode === 'submit' ? 'أُرسل للاعتماد' : 'تم حفظ المسودة'); location.hash = '#/stock'; }
    } catch (x) { err.textContent = x.message; btns.forEach(b => b.disabled = false); } };
  $('#sdf').addEventListener('submit', e => { e.preventDefault(); save('post'); }); $('#saves').onclick = () => save('draft'); if ($('#subs')) $('#subs').onclick = () => save('submit');
  if ($('#dels')) $('#dels').onclick = async e => { if (!confirmBtn(e.target)) return; await api.deleteStockDoc(ex.id); toast('حُذفت'); location.hash = '#/stock'; };
  draw();
}
async function stockDocView(id, pre) {
  shell('stock', loading()); const [d, whs, items] = await Promise.all([pre || api.getStockDoc(id), api.listWarehouses(), api.listItems()]);
  if (d.status === 'draft' && can('inventory', 'create')) return stockDocEditView(id);
  const W = Object.fromEntries(whs.map(w => [w.id, w.name])), I = Object.fromEntries(items.map(i => [i.id, i]));
  $('#main').innerHTML = `<a class="crumb" href="#/stock">${icon('chev')} حركات المخزون</a><div class="page-head"><h1>${esc(SD_KIND[d.kind][0])} <span class="num">${esc(d.number || '')}</span></h1>${statusBadge(d)}
      ${d.status === 'draft' && can('inventory', 'post') ? '<button class="btn primary" id="apps">اعتماد وترحيل</button>' : ''}</div>
    <div class="card" style="margin-bottom:16px"><dl class="kv"><dt>التاريخ</dt><dd class="num">${esc(d.doc_date)}</dd><dt>المستودع</dt><dd>${esc(d.kind === 'transfer' ? `${W[d.from_warehouse_id]} ← ${W[d.to_warehouse_id]}` : W[d.from_warehouse_id || d.to_warehouse_id] || '')}</dd>${d.note ? `<dt>ملاحظات</dt><dd>${esc(d.note)}</dd>` : ''}</dl></div>
    <div class="tbl-wrap"><table><thead><tr><th>الصنف</th>${d.kind === 'count' ? '<th class="amt">رصيد النظام</th><th class="amt">المعدود</th><th class="amt">الفرق</th>' : '<th class="amt">الكمية</th>'}<th class="amt">تكلفة الوحدة</th><th class="amt">القيمة</th></tr></thead><tbody>
      ${d.lines.map(l => { const diff = d.kind === 'count' ? l.qty - (l.system_qty || 0) : l.qty; return `<tr><td>${esc(I[l.item_id]?.name_ar || '')}</td>
        ${d.kind === 'count' ? `<td class="amt num">${l.system_qty == null ? '—' : fq(l.system_qty)}</td><td class="amt num">${fq(l.qty)}</td><td class="amt num ${diff < 0 ? 'down' : ''}">${l.system_qty == null ? '—' : fq(diff)}</td>` : `<td class="amt num">${fq(l.qty)}</td>`}
        <td class="amt num">${l.unit_cost != null ? money(l.unit_cost) : '—'}</td><td class="amt num">${l.unit_cost != null ? money(diff * l.unit_cost) : '—'}</td></tr>`; }).join('')}</tbody></table></div>`;
  if ($('#apps')) $('#apps').onclick = async e => { e.target.disabled = true; try { await api.postStockDoc(id); toast('تم الترحيل'); stockDocView(id); } catch (x) { fail(x); e.target.disabled = false; } };
}

// ---------- manufacturing ----------
async function bomsView() {
  shell('boms', loading()); const [boms, items] = await Promise.all([api.listBoms(), api.listItems()]); const I = Object.fromEntries(items.map(i => [i.id, i]));
  const cost = b => b.bom_lines.reduce((a, l) => a + l.qty * (1 + l.waste_pct / 100) * Number(I[l.item_id]?.avg_cost || 0), 0) / b.output_qty;
  $('#main').innerHTML = `<div class="page-head"><h1>قوائم المواد</h1>${can('manufacturing', 'create') ? `<a class="btn primary" href="#/boms/new">${icon('plus')}قائمة مواد جديدة</a>` : ''}</div>
    <p class="muted" style="margin:-8px 0 16px">مكونات وحدة واحدة من كل منتج تصنعه — كرفان، درج مطبخ خارجي، أي منتج. أوامر التصنيع تُملأ منها تلقائياً.</p>
    ${boms.length ? `<div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>المنتج</th><th class="amt">المكونات</th><th class="amt">التكلفة التقديرية للوحدة</th><th class="amt">سعر البيع</th><th></th></tr></thead><tbody>
      ${boms.map(b => `<tr class="click" data-href="#/boms/${esc(b.id)}"><td style="white-space:normal"><a class="rowlink" href="#/boms/${esc(b.id)}"><b>${esc(I[b.item_id]?.name_ar || '')}</b></a></td><td class="amt num">${b.bom_lines.length}</td>
        <td class="amt num">${money(cost(b))}</td><td class="amt num m-hide">${money(I[b.item_id]?.sale_price || 0)}</td>
        <td>${can('manufacturing', 'create') ? `<a class="btn secondary sm" href="#/mfg/new?bom=${esc(b.id)}">أمر تصنيع</a>` : ''}</td></tr>`).join('')}</tbody></table></div>`
    : empty('box', 'لا توجد قوائم مواد بعد', 'أضف المنتج التام (مثل كرفان 6 متر) ومواده الخام في صفحة الأصناف، ثم حدّد هنا مكونات الوحدة الواحدة.', can('manufacturing', 'create') ? `<a class="btn primary" href="#/boms/new">${icon('plus')}قائمة مواد جديدة</a>` : '')}`;
}
async function bomEditView(id) {
  shell('boms', loading()); const [boms, items] = await Promise.all([api.listBoms(), api.listItems()]);
  const ex = id ? boms.find(b => b.id === id) : null; if (id && !ex) throw new AppError('القائمة غير موجودة');
  const editable = can('manufacturing', 'create');
  const products = items.filter(i => i.track_stock && i.kind === 'product' && (!boms.some(b => b.item_id === i.id) || i.id === ex?.item_id));
  const comps = items.filter(i => i.track_stock), I = Object.fromEntries(items.map(i => [i.id, i]));
  let lines = ex?.bom_lines?.map(l => ({ item_id: l.item_id, qty: l.qty, waste_pct: l.waste_pct })) || [{ item_id: '', qty: '', waste_pct: 0 }];
  $('#main').innerHTML = `<a class="crumb" href="#/boms">${icon('chev')} قوائم المواد</a><div class="page-head"><h1>${ex ? esc(I[ex.item_id]?.name_ar) : 'قائمة مواد جديدة'}</h1>
      ${ex && editable ? `<a class="btn primary" href="#/mfg/new?bom=${esc(ex.id)}">أمر تصنيع</a>` : ''}</div>
    ${!products.length && !ex ? `<p class="note warn" style="margin-bottom:16px">لا توجد منتجات بدون قائمة مواد. أضف المنتج التام من <a href="#/items">الأصناف</a> بنوع «سلعة».</p>` : ''}
    <form class="card" id="bf2" novalidate><div class="grid g3" style="margin-bottom:16px">
      <div class="field"><label for="f-item">المنتج التام</label><select class="input" id="f-item" name="item_id" ${ex || !editable ? 'disabled' : ''}>${optList(products.map(p => [p.id, p.name_ar]), ex?.item_id, '— اختر المنتج —')}</select></div>
      ${field('output_qty', 'المكونات أدناه تكفي لإنتاج', { value: ex?.output_qty || 1, help: 'عادة 1 وحدة', attrs: 'inputmode="decimal"' })}</div>
      <div class="tbl-wrap editor"><table><thead><tr><th style="min-width:200px">المكوّن</th><th style="width:130px">الكمية</th><th style="width:110px">الهدر %</th><th class="amt">تكلفة الوحدة</th><th class="amt">التكلفة</th><th style="width:44px"></th></tr></thead><tbody id="bl"></tbody>
        <tfoot><tr><td colspan="4">التكلفة التقديرية للوحدة</td><td class="amt num" id="bt"></td><td></td></tr></tfoot></table></div>
      ${editable ? `<button type="button" class="btn ghost sm" style="margin-top:8px" id="addb">${icon('plus')}إضافة مكوّن</button>` : ''}
      ${field('notes', 'ملاحظات / طريقة التصنيع', { value: ex?.notes || '' })}
      <p class="help err" id="berr" role="alert"></p>
      ${editable ? `<div class="row" style="justify-content:flex-end;margin-top:16px">${ex ? '<button type="button" class="btn ghost" id="delb" style="color:var(--c-danger)">حذف القائمة</button>' : ''}<a class="btn ghost" href="#/boms">إلغاء</a><button class="btn primary" type="submit">حفظ</button></div>` : ''}</form>`;
  const draw = () => { const out = num($('#f-output_qty').value) || 1;
    $('#bl').innerHTML = lines.map((l, i) => { const it = I[l.item_id], c = it ? Number(it.avg_cost) : 0, tot = (l.qty || 0) * (1 + (l.waste_pct || 0) / 100) * c;
      return `<tr data-i="${i}"><td><select class="input" data-k="item_id" aria-label="المكوّن" ${editable ? '' : 'disabled'}>${optList(comps.map(s => [s.id, s.name_ar + (s.kind === 'raw_material' ? ' (خام)' : '')]), l.item_id, '— اختر —')}</select></td>
      <td><input class="input num" data-k="qty" inputmode="decimal" value="${l.qty ?? ''}" aria-label="الكمية" ${editable ? '' : 'disabled'}> <span class="xs muted">${esc(it?.unit || '')}</span></td>
      <td><input class="input num" data-k="waste_pct" inputmode="decimal" value="${l.waste_pct || ''}" placeholder="0" aria-label="نسبة الهدر" ${editable ? '' : 'disabled'}></td>
      <td class="amt num">${it ? money(c) : ''}</td><td class="amt num" data-lt>${it ? money(tot) : ''}</td><td>${editable ? `<button type="button" class="btn ghost icon sm" data-del aria-label="حذف">${icon('trash')}</button>` : ''}</td></tr>`; }).join('');
    recalc(); };
  const recalc = () => { const out = num($('#f-output_qty').value) || 1;
    lines.forEach((l, i) => { const cell = $(`#bl tr[data-i="${i}"] [data-lt]`), it = I[l.item_id]; if (cell && it) cell.textContent = money((l.qty || 0) * (1 + (l.waste_pct || 0) / 100) * Number(it.avg_cost)); });
    $('#bt').textContent = money(lines.reduce((a, l) => a + (l.qty || 0) * (1 + (l.waste_pct || 0) / 100) * Number(I[l.item_id]?.avg_cost || 0), 0) / out); };
  $('#bl').addEventListener('change', e => { const tr = e.target.closest('tr'); if (tr && e.target.dataset.k === 'item_id') { lines[tr.dataset.i].item_id = e.target.value; draw(); } });
  $('#bl').addEventListener('input', e => { const tr = e.target.closest('tr'), k = e.target.dataset.k; if (tr && (k === 'qty' || k === 'waste_pct')) { lines[tr.dataset.i][k] = num(e.target.value || 0); recalc(); } });
  $('#f-output_qty').addEventListener('input', recalc);
  $('#bl').addEventListener('click', e => { if (e.target.closest('[data-del]')) { lines.splice(e.target.closest('tr').dataset.i, 1); if (!lines.length) lines.push({ item_id: '', qty: '', waste_pct: 0 }); draw(); } });
  if ($('#addb')) $('#addb').onclick = () => { lines.push({ item_id: '', qty: '', waste_pct: 0 }); draw(); };
  if ($('#bf2') && editable) $('#bf2').addEventListener('submit', async e => { e.preventDefault(); const err = $('#berr'); err.textContent = '';
    const item = ex?.item_id || $('#f-item').value, out = num($('#f-output_qty').value), real = lines.filter(l => l.item_id);
    if (!item) return err.textContent = 'اختر المنتج'; if (!(out > 0)) return err.textContent = 'كمية الإنتاج غير صحيحة';
    if (!real.length) return err.textContent = 'أضف مكوّناً واحداً على الأقل'; if (real.some(l => !(l.qty > 0) || !(l.waste_pct >= 0 && l.waste_pct <= 100))) return err.textContent = 'تحقق من الكميات ونسب الهدر';
    if (real.some(l => l.item_id === item)) return err.textContent = 'لا يمكن أن يكون المنتج مكوّناً لنفسه';
    $('[type=submit]', e.target).disabled = true;
    try { const bid = await api.saveBom({ id: ex?.id, item_id: item, output_qty: out, notes: $('#f-notes').value }, real); toast('حُفظت قائمة المواد'); location.hash = '#/boms/' + bid; if (ex) bomEditView(bid); }
    catch (x) { err.textContent = x.message; $('[type=submit]', e.target).disabled = false; } });
  if ($('#delb')) $('#delb').onclick = async e => { if (!confirmBtn(e.target)) return; await api.deleteBom(ex.id); toast('حُذفت'); location.hash = '#/boms'; };
  draw();
}
async function mfgListView() {
  shell('mfg', loading()); const ms = await api.listMfg();
  const month = riyadhToday().slice(0, 7), mm = ms.filter(m => m.status === 'posted' && m.order_date.startsWith(month));
  $('#main').innerHTML = `<div class="page-head"><h1>أوامر التصنيع</h1>${can('manufacturing', 'create') ? `<a class="btn primary" href="#/mfg/new">${icon('plus')}أمر تصنيع جديد</a>` : ''}</div>
    <div class="grid g3" style="margin-bottom:20px"><div class="card stat"><div class="label">أوامر منفذة هذا الشهر</div><div class="val num">${mm.length}</div></div>
      <div class="card stat"><div class="label">تكلفة إنتاج الشهر</div><div class="val num">${money(mm.reduce((a, m) => a + m.total_cost, 0))}</div></div>
      <div class="card stat"><div class="label">بانتظار الاعتماد</div><div class="val num">${ms.filter(m => m.status === 'draft' && m.submitted_at).length}</div></div></div>
    ${ms.length ? `<div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>الرقم</th><th>المنتج</th><th class="amt">الكمية</th><th>العميل</th><th>التاريخ</th><th class="amt">تكلفة الوحدة</th><th>الحالة</th></tr></thead><tbody>
      ${ms.map(m => `<tr class="click" data-href="#/mfg/${esc(m.id)}"><td class="num"><a class="rowlink" href="#/mfg/${esc(m.id)}">${esc(m.number || 'مسودة')}</a></td><td style="white-space:normal">${esc(m.items?.name_ar || '')}</td>
        <td class="amt num">${fq(m.qty)}</td><td class="m-hide">${esc(m.parties?.name || 'للمخزون')}</td><td class="num m-hide">${esc(m.order_date)}</td><td class="amt num">${m.unit_cost != null ? money(m.unit_cost) : '—'}</td><td>${statusBadge(m)}</td></tr>`).join('')}</tbody></table></div>`
    : empty('box', 'لا توجد أوامر تصنيع بعد', 'أنشئ قائمة مواد للمنتج، ثم أمر تصنيع — تُخصم المواد من المستودع ويدخل المنتج التام بتكلفته الفعلية.', can('manufacturing', 'create') ? `<a class="btn primary" href="#/mfg/new">${icon('plus')}أمر تصنيع جديد</a>` : '')}`;
}
async function mfgEditView(id, qs) {
  shell('mfg', loading());
  const [boms, items, whs, accs, ps, ex, bal, ccs] = await Promise.all([api.listBoms(), api.listItems(), api.listWarehouses(), api.listAccounts(), api.listParties('customer'), id ? api.getMfg(id) : null, api.stockByWarehouse(), api.listCostCenters()]);
  if (ex && ex.status !== 'draft') return mfgView(id, ex);
  if (!can('manufacturing', 'create')) { location.hash = '#/mfg' + (id ? '/' + id : ''); return; }
  const quotes = can('sales') ? (await api.listDocuments(['quote'])).filter(d => d.status === 'posted') : [];
  const I = Object.fromEntries(items.map(i => [i.id, i])), q = {}; bal.forEach(b => q[b.item_id + ':' + b.warehouse_id] = b.qty);
  const products = items.filter(i => i.track_stock && i.kind === 'product'), comps = items.filter(i => i.track_stock);
  const costAccts = accs.filter(a => a.is_postable && (['liability'].includes(a.type) || ['cash', 'bank', 'custody'].includes(a.system_key)));
  const preBom = boms.find(b => b.id === qs?.get('bom'));
  const m = ex || { item_id: preBom?.item_id || '', qty: 1, order_date: riyadhToday(), warehouse_id: whs[0]?.id };
  let lines = ex?.lines?.map(l => ({ item_id: l.item_id, planned_qty: l.planned_qty, actual_qty: l.actual_qty, waste_qty: l.waste_qty })) || [];
  let costs = ex?.costs?.map(c => ({ description: c.description, amount: c.amount, account_id: c.account_id })) || [];
  const fromBom = () => { const b = boms.find(x => x.item_id === $('#f-item').value), n = num($('#f-qty').value) || 0; if (!b) { lines = []; return; }
    lines = b.bom_lines.map(l => { const base = l.qty * n / b.output_qty, planned = base * (1 + l.waste_pct / 100);
      return { item_id: l.item_id, planned_qty: +planned.toFixed(4), actual_qty: +base.toFixed(4), waste_qty: +(planned - base).toFixed(4) }; }); };
  $('#main').innerHTML = `<a class="crumb" href="#/mfg">${icon('chev')} أوامر التصنيع</a><div class="page-head"><h1>${ex ? 'تعديل أمر تصنيع' : 'أمر تصنيع جديد'}</h1>${ex ? statusBadge(ex) : ''}</div>
    <form class="card" id="mf" novalidate>
      <div class="grid g3" style="margin-bottom:16px">
        <div class="field"><label for="f-item">المنتج التام <span aria-hidden="true" style="color:var(--c-danger)">*</span></label><select class="input" id="f-item" name="item_id">${optList(products.map(p => [p.id, p.name_ar + (boms.some(b => b.item_id === p.id) ? '' : ' (بدون قائمة مواد)')]), m.item_id, '— اختر المنتج —')}</select></div>
        ${field('qty', 'كمية الإنتاج', { value: m.qty, req: true, attrs: 'inputmode="decimal"' })}
        ${field('order_date', 'تاريخ الأمر', { type: 'date', value: m.order_date, req: true })}
        ${select('warehouse_id', 'المستودع (تُصرف منه المواد ويدخله المنتج)', whs.map(w => [w.id, w.name]), m.warehouse_id)}
        <div class="field"><label for="f-party">لعميل (اختياري)</label><select class="input" id="f-party" name="party_id">${optList(ps.map(p => [p.id, p.name]), m.party_id, '— للمخزون —')}</select></div>
        ${ccField(ccs, m.cost_center_id)}
        ${quotes.length ? `<div class="field"><label for="f-rel">عرض السعر المرتبط (اختياري)</label><select class="input" id="f-rel" name="related_document_id">${optList(quotes.map(d => [d.id, `${d.number} — ${d.party_name}`]), m.related_document_id, '—')}</select></div>` : ''}
      </div>
      <h3 style="margin-bottom:8px">المكونات — المخطط والمستهلك فعلاً والهدر</h3>
      <div class="tbl-wrap editor"><table><thead><tr><th style="min-width:180px">المكوّن</th><th class="amt">المتاح</th><th style="width:110px">المخطط</th><th style="width:110px">المستهلك</th><th style="width:110px">التالف / الهدر</th><th class="amt">تكلفة الوحدة</th><th class="amt">التكلفة</th><th style="width:44px"></th></tr></thead><tbody id="ml"></tbody></table></div>
      <div class="row" style="margin-top:8px"><button type="button" class="btn ghost sm" id="addm">${icon('plus')}إضافة مكوّن</button><button type="button" class="btn ghost sm" id="refill">إعادة التعبئة من قائمة المواد</button></div>
      <h3 style="margin:20px 0 8px">تكاليف إضافية (عمالة، تشغيل، دهان خارجي…)</h3><div id="mc"></div>
      <button type="button" class="btn ghost sm" id="addc">${icon('plus')}إضافة تكلفة</button>
      <div class="card" style="background:var(--c-bg);margin-top:16px"><div class="grid g4" id="msum"></div></div>
      ${field('notes', 'ملاحظات العمل', { value: m.notes || '' })}
      <p class="help err" id="merr" role="alert"></p>
      <div class="row" style="justify-content:flex-end;margin-top:16px;flex-wrap:wrap">${ex ? '<button type="button" class="btn ghost" id="delm" style="color:var(--c-danger)">حذف</button>' : ''}<a class="btn ghost" href="#/mfg">إلغاء</a>
        <button type="button" class="btn secondary" id="savem">حفظ كمسودة</button>${can('manufacturing', 'post') ? '<button class="btn primary" type="submit">تنفيذ الأمر وترحيله</button>' : '<button type="button" class="btn secondary" id="subm">إرسال للاعتماد</button>'}</div></form>`;
  const wh = () => $('#f-warehouse_id').value;
  const draw = () => {
    $('#ml').innerHTML = lines.length ? lines.map((l, i) => { const it = I[l.item_id], c = Number(it?.avg_cost || 0), avail = q[l.item_id + ':' + wh()] || 0, need = (l.actual_qty || 0) + (l.waste_qty || 0);
      return `<tr data-i="${i}"><td><select class="input" data-k="item_id" aria-label="المكوّن">${optList(comps.map(s => [s.id, s.name_ar]), l.item_id, '— اختر —')}</select></td>
        <td class="amt num ${l.item_id && avail < need ? 'down' : ''}">${l.item_id ? fq(avail) : ''}</td>
        <td><input class="input num" data-k="planned_qty" inputmode="decimal" value="${l.planned_qty ?? ''}" aria-label="المخطط"></td><td><input class="input num" data-k="actual_qty" inputmode="decimal" value="${l.actual_qty ?? ''}" aria-label="المستهلك فعلاً"></td>
        <td><input class="input num" data-k="waste_qty" inputmode="decimal" value="${l.waste_qty || ''}" placeholder="0" aria-label="التالف"></td>
        <td class="amt num">${it ? money(c) : ''}</td><td class="amt num">${it ? money(need * c) : ''}</td><td><button type="button" class="btn ghost icon sm" data-del aria-label="حذف">${icon('trash')}</button></td></tr>`; }).join('')
      : `<tr><td colspan="8" class="muted" style="text-align:center;padding:20px">اختر منتجاً له قائمة مواد ليُملأ تلقائياً، أو أضف المكونات يدوياً.</td></tr>`;
    $('#mc').innerHTML = costs.map((c, i) => `<div class="row" data-c="${i}" style="margin-bottom:8px;flex-wrap:wrap"><input class="input" data-ck="description" value="${esc(c.description)}" placeholder="مثل: أجور الورشة، لحام خارجي" aria-label="وصف التكلفة" style="flex:2;min-width:160px">
      <input class="input num" data-ck="amount" inputmode="decimal" value="${c.amount ? money(c.amount) : ''}" placeholder="0.00" aria-label="المبلغ" style="flex:1;min-width:100px">
      <select class="input" data-ck="account_id" aria-label="يُحمّل على حساب" style="flex:2;min-width:180px">${acctOpts(costAccts, c.account_id)}</select><button type="button" class="btn ghost icon sm" data-cdel aria-label="حذف">${icon('trash')}</button></div>`).join('')
      || '<p class="muted xs">لا توجد تكاليف إضافية. الحساب الدائن عادة «رواتب مستحقة» للعمالة، أو الصندوق/البنك لما دُفع نقداً.</p>';
    sum(); };
  const sum = () => { let mat = 0, wst = 0; lines.forEach(l => { const c = Number(I[l.item_id]?.avg_cost || 0); mat += (l.actual_qty || 0) * c; wst += (l.waste_qty || 0) * c; });
    const ext = costs.reduce((a, c) => a + (c.amount || 0), 0), tot = mat + wst + ext, n = num($('#f-qty').value) || 0;
    $('#msum').innerHTML = [['تكلفة المواد', mat], ['تكلفة التالف', wst], ['التكاليف الإضافية', ext], ['التكلفة الكلية', tot]].map(([t, v]) => `<div><div class="xs muted">${t}</div><div class="num" style="font-weight:700">${money(v)}</div></div>`).join('')
      + `<div style="grid-column:1/-1;border-top:1px solid var(--c-border);padding-top:8px"><span class="muted">تكلفة الوحدة التقديرية: </span><b class="num">${n > 0 ? money(tot / n) : '—'}</b> <span class="xs muted">(تُحسب نهائياً بمتوسط التكلفة لحظة الترحيل)</span></div>`; };
  $('#f-item').addEventListener('change', () => { fromBom(); draw(); });
  $('#f-qty').addEventListener('change', () => { fromBom(); draw(); });
  $('#f-warehouse_id').addEventListener('change', draw);
  $('#refill').onclick = () => { fromBom(); draw(); };
  $('#ml').addEventListener('change', e => { const tr = e.target.closest('tr[data-i]'); if (tr && e.target.dataset.k === 'item_id') { lines[tr.dataset.i].item_id = e.target.value; draw(); } });
  $('#ml').addEventListener('input', e => { const tr = e.target.closest('tr[data-i]'), k = e.target.dataset.k; if (tr && k && k !== 'item_id') { lines[tr.dataset.i][k] = num(e.target.value || 0); sum(); } });
  $('#ml').addEventListener('click', e => { if (e.target.closest('[data-del]')) { lines.splice(e.target.closest('tr').dataset.i, 1); draw(); } });
  $('#addm').onclick = () => { lines.push({ item_id: '', planned_qty: 0, actual_qty: 0, waste_qty: 0 }); draw(); };
  $('#addc').onclick = () => { costs.push({ description: '', amount: 0, account_id: costAccts.find(a => a.system_key === 'salaries_payable')?.id || costAccts[0]?.id }); draw(); };
  $('#mc').addEventListener('input', e => { const r = e.target.closest('[data-c]'); if (!r) return; const c = costs[r.dataset.c]; if (e.target.dataset.ck === 'amount') { c.amount = toHalalas(e.target.value || 0); sum(); } else if (e.target.dataset.ck === 'description') c.description = e.target.value; });
  $('#mc').addEventListener('change', e => { const r = e.target.closest('[data-c]'); if (r && e.target.dataset.ck === 'account_id') costs[r.dataset.c].account_id = e.target.value; });
  $('#mc').addEventListener('click', e => { if (e.target.closest('[data-cdel]')) { costs.splice(e.target.closest('[data-c]').dataset.c, 1); draw(); } });
  const save = async mode => { const f = Object.fromEntries(new FormData($('#mf'))), err = $('#merr'); err.textContent = '';
    const n = num(f.qty), real = lines.filter(l => l.item_id);
    if (!f.item_id) return err.textContent = 'اختر المنتج'; if (!(n > 0)) return err.textContent = 'كمية الإنتاج غير صحيحة';
    if (real.some(l => [l.planned_qty, l.actual_qty, l.waste_qty].some(v => !Number.isFinite(v) || v < 0))) return err.textContent = 'تحقق من كميات المكونات';
    if (real.some(l => l.item_id === f.item_id)) return err.textContent = 'لا يمكن أن يكون المنتج مكوّناً لنفسه';
    if (costs.some(c => !(c.amount > 0) || !c.description.trim() || !c.account_id)) return err.textContent = 'أكمل بيانات التكاليف الإضافية أو احذفها';
    if (!real.length && !costs.length) return err.textContent = 'أضف مكونات أو تكاليف';
    const btns = $$('#mf button'); btns.forEach(b => b.disabled = true);
    try { const mid = await api.saveMfg({ ...(ex ? { id: ex.id } : {}), item_id: f.item_id, qty: n, order_date: f.order_date, warehouse_id: f.warehouse_id, party_id: f.party_id || null,
        related_document_id: f.related_document_id || null, cost_center_id: f.cost_center_id || null, notes: f.notes, submitted_at: mode === 'submit' ? new Date().toISOString() : null }, real, costs);
      if (mode === 'post') { await api.postMfg(mid); toast('تم تنفيذ أمر التصنيع ودخل المنتج المخزون'); location.hash = '#/mfg/' + mid; }
      else { toast(mode === 'submit' ? 'أُرسل للاعتماد' : 'تم حفظ المسودة'); location.hash = '#/mfg'; }
    } catch (x) { err.textContent = x.message; btns.forEach(b => b.disabled = false); } };
  $('#mf').addEventListener('submit', e => { e.preventDefault(); save('post'); }); $('#savem').onclick = () => save('draft'); if ($('#subm')) $('#subm').onclick = () => save('submit');
  if ($('#delm')) $('#delm').onclick = async e => { if (!confirmBtn(e.target)) return; await api.deleteMfg(ex.id); toast('حُذف'); location.hash = '#/mfg'; };
  if (!ex && m.item_id) fromBom();
  draw();
}
async function mfgView(id, pre) {
  shell('mfg', loading()); const [m, items, whs] = await Promise.all([pre || api.getMfg(id), api.listItems(), api.listWarehouses()]);
  if (m.status === 'draft' && can('manufacturing', 'create')) return mfgEditView(id);
  const I = Object.fromEntries(items.map(i => [i.id, i])), W = Object.fromEntries(whs.map(w => [w.id, w.name]));
  $('#main').innerHTML = `<a class="crumb no-print" href="#/mfg">${icon('chev')} أوامر التصنيع</a><div class="page-head no-print"><h1>أمر تصنيع <span class="num">${esc(m.number || 'مسودة')}</span></h1>${statusBadge(m)}
      <button class="btn secondary" onclick="window.print()">${icon('down')}طباعة</button>${m.status === 'draft' && can('manufacturing', 'post') ? '<button class="btn primary" id="appm">اعتماد وتنفيذ</button>' : ''}</div>
    <div class="grid g4" style="margin-bottom:20px">${[['المنتج', esc(m.items?.name_ar)], ['الكمية', fq(m.qty) + ' ' + esc(m.items?.unit || '')], ['المستودع', esc(W[m.warehouse_id] || '')], ['العميل', esc(m.parties?.name || 'للمخزون')]].map(([t, v]) => `<div class="card stat"><div class="label">${t}</div><div class="val" style="font-size:var(--fs-md)">${v}</div></div>`).join('')}</div>
    <div class="tbl-wrap"><table><thead><tr><th>المكوّن</th><th class="amt">المخطط</th><th class="amt">المستهلك</th><th class="amt">التالف</th><th class="amt">الانحراف</th><th class="amt">تكلفة الوحدة</th><th class="amt">التكلفة</th></tr></thead><tbody>
      ${m.lines.map(l => { const dev = l.actual_qty + l.waste_qty - l.planned_qty; return `<tr><td>${esc(I[l.item_id]?.name_ar || '')}</td><td class="amt num">${fq(l.planned_qty)}</td><td class="amt num">${fq(l.actual_qty)}</td><td class="amt num">${l.waste_qty ? fq(l.waste_qty) : '—'}</td>
        <td class="amt num ${dev > 0 ? 'down' : ''}">${dev ? (dev > 0 ? '+' : '') + fq(dev) : '—'}</td><td class="amt num">${l.unit_cost != null ? money(l.unit_cost) : '—'}</td><td class="amt num">${l.unit_cost != null ? money((l.actual_qty + l.waste_qty) * l.unit_cost) : '—'}</td></tr>`; }).join('')}</tbody></table></div>
    ${m.costs.length ? `<h3 style="margin:20px 0 8px">التكاليف الإضافية</h3><div class="tbl-wrap"><table><tbody>${m.costs.map(c => `<tr><td>${esc(c.description)}</td><td class="amt num">${money(c.amount)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${m.status === 'posted' ? `<div class="card" style="margin-top:20px"><div class="grid g4">${[['تكلفة المواد', m.material_cost], ['تكلفة التالف', m.waste_cost], ['التكاليف الإضافية', m.extra_cost], ['التكلفة الكلية', m.total_cost]].map(([t, v]) => `<div><div class="xs muted">${t}</div><div class="num" style="font-weight:700">${money(v)}</div></div>`).join('')}</div>
      <p style="margin:12px 0 0">تكلفة الوحدة: <b class="num">${money(m.unit_cost)}</b>${I[m.item_id]?.sale_price ? ` · سعر البيع <span class="num">${money(I[m.item_id].sale_price)}</span> · هامش الربح <b class="num">${(((I[m.item_id].sale_price - m.unit_cost) / I[m.item_id].sale_price) * 100).toFixed(1)}%</b>` : ''}
      ${m.entry && can('accounting') ? ` · <a href="#/journal/${esc(m.entry.id)}">القيد <span class="num">${esc(m.entry.number)}</span></a>` : ''}</p></div>` : ''}
    ${m.notes ? `<p style="margin-top:12px">${esc(m.notes)}</p>` : ''}`;
  if ($('#appm')) $('#appm').onclick = async e => { e.target.disabled = true; try { await api.postMfg(id); toast('تم التنفيذ'); mfgView(id); } catch (x) { fail(x); e.target.disabled = false; } };
}

// ---------- users, roles & permissions ----------
async function usersView() {
  shell('users', loading()); const [roles, members, invites] = await Promise.all([api.listRoles(), api.listMembers(), api.listInvites()]);
  const R = Object.fromEntries(roles.map(r => [r.id, r])), editable = can('users', 'create');
  const summary = p => MODULES.filter(([k]) => p[k]?.length).map(([k, t]) => `${t}${p[k].includes('post') ? ' (اعتماد)' : p[k].includes('create') ? '' : ' (عرض)'}`).join('، ') || 'لا صلاحيات';
  $('#main').innerHTML = `<div class="page-head"><h1>المستخدمون والصلاحيات</h1>${editable ? `<button class="btn secondary" id="newr">${icon('plus')}دور جديد</button><button class="btn primary" id="newu">${icon('plus')}إضافة مستخدم</button>` : ''}</div>
    <p class="muted" style="margin:-8px 0 16px">لا يدخل النظام إلا من تضيفه. أعطِ كل شخص دوراً — محاسب، عامل ورشة، مشرف مستودع… — وحدّد في الدور ما يراه وما ينشئه وما يعتمده في كل قسم.</p>
    <div class="tabs" role="tablist"><button class="on" data-t="m">الأعضاء <span class="muted num">(${members.length})</span></button><button data-t="r">الأدوار <span class="muted num">(${roles.length})</span></button>${invites.length ? `<button data-t="i">دعوات معلقة <span class="muted num">(${invites.length})</span></button>` : ''}</div>
    <div id="ut"></div>`;
  const tabs = {
    m: () => `<div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>البريد</th><th>الدور</th><th>منذ</th><th></th></tr></thead><tbody>
      ${members.map(m => { const locked = m.role === 'owner' || m.is_me || !editable;
        return `<tr><td dir="ltr" style="text-align:start">${esc(m.email)}${m.is_me ? ' <span class="badge b-info">أنت</span>' : ''}</td>
        <td>${locked ? `<b>${esc(m.role_name)}</b>` : `<select class="input" data-role="${esc(m.user_id)}" aria-label="دور ${esc(m.email)}" style="height:34px">${optList(roles.map(r => [r.id, r.name]), m.role_id)}</select>`}
          <div class="xs muted">${m.role === 'owner' ? 'كل الصلاحيات' : esc(summary(R[m.role_id]?.permissions || {}))}</div></td>
        <td class="num m-hide">${esc(String(m.joined_at).slice(0, 10))}</td><td>${locked ? '' : `<button class="btn ghost sm" data-remove="${esc(m.user_id)}" style="color:var(--c-danger)">إزالة</button>`}</td></tr>`; }).join('')}</tbody></table></div>`,
    r: () => `<div class="grid g2">${roles.map(r => `<div class="card"><div class="row" style="justify-content:space-between"><h3 style="margin:0">${esc(r.name)}</h3>${r.is_system ? badge(['أساسي', 'b-info']) : ''}</div>
      <p class="xs muted" style="margin:8px 0">${esc(summary(r.permissions))}</p><p class="xs muted" style="margin:0 0 8px">${members.filter(m => m.role_id === r.id).length} عضو</p>
      ${editable ? `<button class="btn secondary sm" data-er="${esc(r.id)}">تعديل الصلاحيات</button>` : ''}</div>`).join('')}</div>`,
    i: () => `<div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>البريد</th><th>الدور</th><th>التاريخ</th><th></th></tr></thead><tbody>
      ${invites.map(i => `<tr><td dir="ltr" style="text-align:start">${esc(i.email)}</td><td>${esc(i.roles?.name || '')}</td><td class="num">${esc(i.created_at.slice(0, 10))}</td>
        <td>${editable ? `<button class="btn ghost sm" data-resend="${esc(i.email)}">إعادة إرسال الرابط</button><button class="btn ghost sm" data-revoke="${esc(i.id)}" style="color:var(--c-danger)">إلغاء</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` };
  const show = t => { $('#ut').innerHTML = tabs[t](); $$('[data-t]').forEach(b => b.classList.toggle('on', b.dataset.t === t)); };
  $$('[data-t]').forEach(b => b.onclick = () => show(b.dataset.t)); show('m');
  const main = $('#main');
  main.addEventListener('click', async e => { const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.er) roleDrawer(R[b.dataset.er]);
      if (b.dataset.revoke) { await api.revokeInvite(b.dataset.revoke); toast('أُلغيت الدعوة'); usersView(); }
      if (b.dataset.resend) { b.disabled = true; await api.sendInviteLink(b.dataset.resend); toast('أُرسل رابط الدخول'); b.disabled = false; }
      if (b.dataset.remove) { if (!confirmBtn(b, 'تأكيد الإزالة؟')) return; await api.removeMember(b.dataset.remove); toast('أُزيل المستخدم ولن يستطيع الدخول للشركة'); usersView(); }
    } catch (x) { toast(x.message, 'bad'); b.disabled = false; } });
  main.addEventListener('change', async e => { const s = e.target.closest('[data-role]'); if (!s) return;
    try { await api.setRole(s.dataset.role, s.value); toast('تم تغيير الدور'); usersView(); } catch (x) { toast(x.message, 'bad'); usersView(); } });
  if ($('#newr')) $('#newr').onclick = () => roleDrawer(null);
  if ($('#newu')) $('#newu').onclick = () => drawer('إضافة مستخدم', `
      ${field('email', 'البريد الإلكتروني', { type: 'email', req: true, attrs: 'dir="ltr" autocomplete="off"' })}
      <div class="field"><label for="f-role_id">الدور</label><select class="input" id="f-role_id" name="role_id">${optList(roles.filter(r => r.name !== 'مدير عام' || ORG.perms?._owner).map(r => [r.id, r.name]), roles.find(r => r.name === 'محاسب')?.id)}</select>
        <span class="help" id="rsum"></span></div>
      <label class="row" style="gap:8px"><input type="checkbox" name="send" checked> أرسل له رابط دخول على بريده الآن</label>
      <p class="note">يسجّل بنفس البريد (أو بحساب Google بنفس البريد) ويدخل الشركة مباشرة بهذا الدور.</p>`,
    async v => { await api.invite(v.email, v.role_id); let sent = false;
      if (v.send) { try { await api.sendInviteLink(v.email.trim().toLowerCase()); sent = true; } catch (x) { toast('أُضيفت الدعوة لكن تعذّر إرسال البريد: ' + x.message, 'warn'); } }
      toast(sent ? 'أُضيف المستخدم وأُرسل له رابط الدخول' : 'أُضيف المستخدم — أرسل له رابط النظام'); usersView(); }, 'إضافة');
  const rs = $('#f-role_id'); if (rs) { const upd = () => $('#rsum').textContent = summary(R[rs.value]?.permissions || {}); rs.onchange = upd; upd(); }
}
function roleDrawer(r) {
  const p = r?.permissions || {}, sys = r?.is_system, mine = ORG.perms || {};
  const f = drawer(r ? 'صلاحيات الدور' : 'دور جديد', `
    ${field('name', 'اسم الدور', { req: true, value: r?.name || '', help: 'مثل: محاسب، عامل ورشة، مشرف مستودع، مندوب', attrs: sys && !mine._owner ? 'disabled' : '' })}
    <div class="tbl-wrap"><table class="perm-tbl"><thead><tr><th>القسم</th>${ACTIONS.map(([, t]) => `<th style="text-align:center">${t}</th>`).join('')}</tr></thead><tbody>
      ${MODULES.map(([k, t]) => `<tr><td>${t}</td>${ACTIONS.map(([a]) => { const allowed = mine._owner || mine[k]?.includes(a);
        return `<td style="text-align:center"><input type="checkbox" name="p:${k}:${a}" aria-label="${t} — ${a}" ${p[k]?.includes(a) ? 'checked' : ''} ${allowed ? '' : 'disabled title="لا تملك هذه الصلاحية"'}></td>`; }).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="xs muted">«عرض» يرى السجلات فقط. «إنشاء وتعديل» ينشئ المسودات ويرسلها للاعتماد. «اعتماد وترحيل» يعتمد ويسجّل القيد. لا يمكنك منح صلاحية لا تملكها.</p>
    ${r && !sys ? '<button type="button" class="btn ghost" id="delr" style="color:var(--c-danger)">حذف الدور</button>' : ''}`,
    async v => { const perms = {}; MODULES.forEach(([k]) => { const acts = ACTIONS.map(([a]) => a).filter(a => v[`p:${k}:${a}`]); if (acts.length) perms[k] = acts; });
      await api.saveRole(r?.id, v.name ?? r?.name, perms); toast('حُفظ الدور'); usersView(); });
  $$('input[type=checkbox]', f).forEach(cb => cb.addEventListener('change', () => { const [, k, a] = cb.name.split(':');
    if (cb.checked && a !== 'view') { const vw = $(`[name="p:${k}:view"]`, f); if (vw && !vw.disabled) vw.checked = true; } }));
  if ($('#delr', f)) $('#delr', f).onclick = async e => { if (!confirmBtn(e.target)) return; try { await api.deleteRole(r.id); f.closest('.drawer-bg').remove(); toast('حُذف الدور'); usersView(); } catch (x) { toast(x.message, 'bad'); } };
}

// ---------- pending approvals (dashboard) ----------
async function approvalsCard() {
  if (api.mode !== 'supabase') return '';
  const can2 = m => can(m, 'post'); const out = [];
  if (can2('sales') || can2('purchases')) (await api.listDocuments(null)).filter(d => d.status === 'draft' && d.submitted_at && can2(doc_module_js(d.kind))).forEach(d => out.push([docLink(d) + '/edit', KIND_NAME[d.kind], d.party_name]));
  if (can2('expenses')) (await api.listExpenses()).filter(x => x.status === 'draft' && x.submitted_at).forEach(x => out.push(['#/expenses', 'مصروف', x.description || money(x.amount + x.vat_amount)]));
  if (can2('manufacturing')) (await api.listMfg()).filter(m => m.status === 'draft' && m.submitted_at).forEach(m => out.push(['#/mfg/' + m.id, 'أمر تصنيع', m.items?.name_ar]));
  if (can2('inventory')) (await api.listStockDocs()).filter(s => s.status === 'draft' && s.submitted_at).forEach(s => out.push(['#/stock/' + s.id, SD_KIND[s.kind][0], s.doc_date]));
  if (can2('hr')) (await api.listPayrollRuns()).filter(r => r.status === 'draft' && r.submitted_at).forEach(r => out.push(['#/payroll/' + r.id, 'مسير رواتب', monthName(r.period_month)]));
  if (!out.length) return '';
  return `<section class="card" style="margin-bottom:24px;border-color:var(--c-warning)"><h2 style="margin-bottom:8px">بانتظار اعتمادك <span class="badge b-warn num">${out.length}</span></h2>
    <ul style="margin:0;padding-inline-start:18px">${out.slice(0, 8).map(([h, t, s]) => `<li><a href="${esc(h)}">${esc(t)}</a> — ${esc(s || '')}</li>`).join('')}</ul></section>`;
}
const doc_module_js = k => ['purchase_bill', 'purchase_return', 'purchase_order'].includes(k) ? 'purchases' : 'sales';

// ---------- company switcher ----------
async function orgSwitcher() {
  const box = $('#orgsw'); if (!box || api.mode !== 'supabase') return;
  const [orgs, who] = await Promise.all([api.myOrgs(), api.whoami()]);
  if (orgs.length < 2 && !who.is_platform_admin) return;
  box.innerHTML = `<select class="input" aria-label="الشركة" id="orgsel" style="height:34px;background:transparent;color:inherit;border-color:rgba(255,255,255,.25)">${orgs.map(o => `<option value="${esc(o.id)}"${o.id === ORG.id ? ' selected' : ''} style="color:#000">${esc(o.name)}</option>`).join('')}
    ${who.is_platform_admin ? '<option value="__new" style="color:#000">+ شركة جديدة…</option>' : ''}</select>`;
  $('#orgsel').onchange = e => { if (e.target.value === '__new') { ORG = null; NEW_ORG = true; route(); return; } api.switchOrg(e.target.value); ORG = null; location.hash = '#/dashboard'; route(); };
}
let NEW_ORG = false;

const OPS_ROUTES = [
  ...docRoutes('quotes'), ...docRoutes('credit-notes'), ...docRoutes('bills'), ...docRoutes('purchase-orders'), ...docRoutes('purchase-returns'),
  [/^#\/suppliers$/, gate('suppliers', 'الموردون', 'purchases', suppliersView)], [/^#\/suppliers\/([\w-]+)$/, gate('suppliers', 'الموردون', 'purchases', m => supplierView(m[1]))],
  [/^#\/payments$/, gate('payments', 'سندات الصرف', 'purchases', paymentsView)], [/^#\/payments\/new(\?.*)?$/, gate('payments', 'سندات الصرف', 'purchases', m => paymentNewView(new URLSearchParams((m[1] || '').slice(1))))],
  [/^#\/expenses$/, gate('expenses', 'المصروفات', 'expenses', expensesView)],
  [/^#\/journal$/, gate('journal', 'القيود اليومية', 'accounting', journalView)], [/^#\/journal\/new$/, gate('journal', 'القيود اليومية', 'accounting', entryNewView)],
  [/^#\/journal\/([\w-]+)$/, gate('journal', 'القيود اليومية', 'accounting', m => entryView(m[1]))],
  [/^#\/warehouses$/, gate('warehouses', 'المستودعات', 'inventory', warehousesView)],
  [/^#\/stock$/, gate('stock', 'حركات المخزون', 'inventory', stockDocsView)], [/^#\/stock\/new(\?.*)?$/, gate('stock', 'حركات المخزون', 'inventory', m => stockDocEditView(null, new URLSearchParams((m[1] || '').slice(1))))],
  [/^#\/stock\/([\w-]+)$/, gate('stock', 'حركات المخزون', 'inventory', m => stockDocView(m[1]))],
  [/^#\/boms$/, gate('boms', 'قوائم المواد', 'manufacturing', bomsView)], [/^#\/boms\/new$/, gate('boms', 'قوائم المواد', 'manufacturing', () => bomEditView(null))],
  [/^#\/boms\/([\w-]+)$/, gate('boms', 'قوائم المواد', 'manufacturing', m => bomEditView(m[1]))],
  [/^#\/mfg$/, gate('mfg', 'أوامر التصنيع', 'manufacturing', mfgListView)], [/^#\/mfg\/new(\?.*)?$/, gate('mfg', 'أوامر التصنيع', 'manufacturing', m => mfgEditView(null, new URLSearchParams((m[1] || '').slice(1))))],
  [/^#\/mfg\/([\w-]+)$/, gate('mfg', 'أوامر التصنيع', 'manufacturing', m => mfgView(m[1]))],
  [/^#\/users$/, gate('users', 'المستخدمون والصلاحيات', 'users', usersView)],
];
