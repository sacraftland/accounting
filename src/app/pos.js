// =====================================================================
// Point of sale (cashier) and projects / cost centers.
// Inserted into app.js by build.py after reports.js — shares its helpers.
// =====================================================================

// ---------- projects ----------
async function projectsView() {
  shell('projects', loading());
  const [ccs, pl] = await Promise.all([api.listCostCenters(), can('accounting') || can('reports') ? api.projectPl('2000-01-01', riyadhToday()) : []]);
  const P = Object.fromEntries(pl.map(r => [r.id, r])), editable = can('accounting', 'create') || can('manufacturing', 'create');
  const ts = api.listTasks ? await api.listTasks().catch(() => []) : [], TS = {}; ts.forEach(t => { if (!t.cost_center_id) return; const x = (TS[t.cost_center_id] ||= { n: 0, done: 0, late: 0 }); x.n++; if (t.status === 'done') x.done++; else if (t.due_date && t.due_date < riyadhToday()) x.late++; });
  const rows = ccs.map(c => { const r = P[c.id] || { revenue: 0, cogs: 0, expenses: 0 }, cost = r.cogs + r.expenses, profit = r.revenue - cost;
    return { ...c, ...r, cost, profit, margin: r.revenue ? profit / r.revenue * 100 : null, progress: c.contract_value ? r.revenue / c.contract_value * 100 : null }; });
  const T = k => rows.reduce((s, r) => s + (r[k] || 0), 0);
  $('#main').innerHTML = `<div class="page-head"><h1>المشاريع ومراكز التكلفة</h1>${editable ? `<button class="btn primary" id="newcc">${icon('plus')}مشروع جديد</button>` : ''}</div>
    <p class="muted" style="margin:-8px 0 16px">اختر المشروع في الفاتورة أو فاتورة الشراء أو المصروف أو أمر التصنيع أو ملف الموظف، فتظهر هنا إيراداته وتكاليفه وربحه — لكل كرفان أو عقد أو فرع.</p>
    <div class="grid g4" style="margin-bottom:20px">${[['مشاريع نشطة', rows.filter(r => r.status === 'active').length, 0], ['إيرادات المشاريع', T('revenue'), 1], ['تكاليف المشاريع', T('cost'), 1], ['ربح المشاريع', T('profit'), 1]]
      .map(([t, v, m]) => `<div class="card stat"><div class="label">${t}</div><div class="val num ${m && v < 0 ? 'down' : ''}">${m ? money(v) : v}</div></div>`).join('')}</div>
    ${rows.length ? `<div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>الرمز</th><th>المشروع</th><th class="amt m-hide">قيمة العقد</th><th class="amt">الإيرادات</th><th class="amt">التكاليف</th><th class="amt">الربح</th><th class="amt m-hide">الهامش</th><th class="m-hide">الفوترة</th><th>المهام</th><th>الحالة</th></tr></thead><tbody>
      ${rows.map(r => `<tr class="click" data-href="#/projects/${esc(r.id)}"><td class="num"><a class="rowlink" href="#/projects/${esc(r.id)}">${esc(r.code)}</a></td><td style="white-space:normal"><b>${esc(r.name)}</b>${r.is_project ? '' : ' <span class="xs muted">مركز تكلفة</span>'}</td>
        <td class="amt num m-hide">${r.contract_value ? money(r.contract_value) : '—'}</td><td class="amt num">${money(r.revenue)}</td><td class="amt num">${money(r.cost)}</td><td class="amt num ${r.profit < 0 ? 'down' : ''}"><b>${money(r.profit)}</b></td>
        <td class="amt num m-hide">${r.margin == null ? '—' : r.margin.toFixed(1) + '%'}</td>
        <td class="m-hide">${r.progress == null ? '—' : `<div class="bar" title="${r.progress.toFixed(0)}%"><i style="width:${Math.min(100, r.progress).toFixed(0)}%"></i></div><span class="xs muted num">${r.progress.toFixed(0)}%</span>`}</td>
        <td>${TS[r.id] ? `<div class="bar" title="${TS[r.id].done}/${TS[r.id].n}"><i style="width:${(TS[r.id].done / TS[r.id].n * 100).toFixed(0)}%"></i></div><span class="xs muted num">${TS[r.id].done}/${TS[r.id].n}</span>${TS[r.id].late ? ` <span class="xs down">${TS[r.id].late} متأخرة</span>` : ''}` : '<span class="xs muted">—</span>'}</td>
        <td>${badge(r.status === 'active' ? ['نشط', 'b-ok'] : ['مغلق', 'b-draft'])}</td></tr>`).join('')}</tbody></table></div>`
    : empty('chart', 'لا توجد مشاريع بعد', 'أنشئ مشروعاً لكل كرفان أو عقد كبير، أو مركز تكلفة لكل قسم (الورشة، المعرض)، لتعرف ربح كل واحد.', editable ? `<button class="btn primary" id="newcc2">${icon('plus')}مشروع جديد</button>` : '')}`;
  ['#newcc', '#newcc2'].forEach(s => { if ($(s)) $(s).onclick = () => projectDrawer(null, ccs); });
}
function projectDrawer(c, ccs) {
  const next = 'P-' + String((ccs.length || 0) + 1).padStart(3, '0');
  c = c || { code: next, is_project: true, status: 'active' };
  drawer(c.id ? 'تعديل المشروع' : 'مشروع جديد', `
    <div class="form-grid">${field('code', 'الرمز', { req: true, value: c.code, attrs: 'dir="ltr" maxlength="20"' })}${select('is_project', 'النوع', [['1', 'مشروع / عقد'], ['0', 'مركز تكلفة (قسم أو فرع)']], c.is_project ? '1' : '0')}</div>
    ${field('name', 'الاسم', { req: true, value: c.name || '', help: 'مثل: كرفان 8 متر — مؤسسة البر' })}
    ${field('contract_value', 'قيمة العقد قبل الضريبة (اختياري)', { type: 'money', value: c.contract_value ? money(c.contract_value) : '', help: 'لحساب نسبة الإنجاز والمتبقي للفوترة' })}
    ${select('status', 'الحالة', [['active', 'نشط'], ['closed', 'مغلق']], c.status)}`,
    async v => { if (!v.code?.trim() || !v.name?.trim()) throw new AppError('الرمز والاسم مطلوبان');
      const cv = v.contract_value ? toHalalas(v.contract_value) : null; if (cv != null && !(cv >= 0)) throw new AppError('قيمة العقد غير صحيحة');
      await api.saveCostCenter({ ...(c.id ? { id: c.id } : {}), code: v.code.trim(), name: v.name.trim(), is_project: v.is_project === '1', contract_value: cv, status: v.status });
      toast('حُفظ المشروع'); c.id ? projectView(c.id) : projectsView(); });
}
async function projectView(id) {
  shell('projects', loading());
  const [ccs, pl, d] = await Promise.all([api.listCostCenters(), can('accounting') || can('reports') ? api.projectPl('2000-01-01', riyadhToday()) : [], api.projectDocs(id)]);
  const c = ccs.find(x => x.id === id); if (!c) throw new AppError('المشروع غير موجود');
  const r = pl.find(x => x.id === id) || { revenue: 0, cogs: 0, expenses: 0 }, cost = r.cogs + r.expenses, profit = r.revenue - cost;
  const editable = can('accounting', 'create') || can('manufacturing', 'create');
  const KIND = { tax_invoice: ['فاتورة', 'invoices'], simplified_invoice: ['فاتورة مبسطة', 'invoices'], credit_note: ['إشعار دائن', 'credit-notes'], quote: ['عرض سعر', 'quotes'], purchase_bill: ['فاتورة مشتريات', 'bills'], purchase_order: ['أمر شراء', 'purchase-orders'], purchase_return: ['مرتجع مشتريات', 'purchase-returns'] };
  $('#main').innerHTML = `<a class="crumb" href="#/projects">${icon('chev')} المشاريع</a><div class="page-head"><h1>${esc(c.name)} <span class="num muted" style="font-size:var(--fs-md)">${esc(c.code)}</span></h1>
      ${badge(c.status === 'active' ? ['نشط', 'b-ok'] : ['مغلق', 'b-draft'])}${editable ? '<button class="btn secondary" id="edcc">تعديل</button>' : ''}${can('sales', 'create') ? '<a class="btn primary" href="#/invoices/new">فاتورة جديدة</a>' : ''}</div>
    <div class="grid g4" style="margin-bottom:20px">${[['قيمة العقد', c.contract_value], ['المفوتر (الإيرادات)', r.revenue], ['التكاليف', cost], ['الربح', profit]].map(([t, v]) => `<div class="card stat"><div class="label">${t}</div><div class="val num ${v < 0 ? 'down' : ''}">${v == null ? '—' : money(v)}</div></div>`).join('')}</div>
    ${c.contract_value ? `<div class="card" style="margin-bottom:20px"><div class="row" style="justify-content:space-between"><span>نسبة الفوترة من العقد</span><b class="num">${(r.revenue / c.contract_value * 100).toFixed(0)}%</b></div>
      <div class="bar" style="margin-top:8px;height:10px"><i style="width:${Math.min(100, r.revenue / c.contract_value * 100).toFixed(0)}%"></i></div><p class="xs muted" style="margin:8px 0 0">المتبقي للفوترة: <span class="num">${money(Math.max(0, c.contract_value - r.revenue))}</span> · الهامش الحالي: <span class="num">${r.revenue ? (profit / r.revenue * 100).toFixed(1) + '%' : '—'}</span></p></div>` : ''}
    <div class="grid g2" style="align-items:start">
      <section class="card"><h3 style="margin-bottom:8px">المستندات</h3>${d.docs.length ? `<div class="tbl-wrap"><table><tbody>${d.docs.map(x => `<tr><td><a href="#/${KIND[x.kind]?.[1] || 'invoices'}/${esc(x.id)}">${esc(KIND[x.kind]?.[0] || x.kind)} <span class="num">${esc(x.number || 'مسودة')}</span></a><div class="xs muted">${esc(x.parties?.name || '')}</div></td><td class="num">${esc(x.issue_date)}</td><td class="amt num">${money(x.total)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">لا توجد مستندات مرتبطة.</p>'}</section>
      <div class="grid" style="gap:16px">
        <section class="card"><h3 style="margin-bottom:8px">أوامر التصنيع</h3>${d.mfg.length ? `<div class="tbl-wrap"><table><tbody>${d.mfg.map(x => `<tr><td><a href="#/mfg/${esc(x.id)}">${esc(x.items?.name_ar || '')} <span class="num">${esc(x.number || 'مسودة')}</span></a></td><td class="num">${fq(x.qty)}</td><td class="amt num">${x.status === 'posted' ? money(x.total_cost) : '—'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">لا توجد.</p>'}</section>
        <section class="card"><h3 style="margin-bottom:8px">المصروفات</h3>${d.expenses.length ? `<div class="tbl-wrap"><table><tbody>${d.expenses.map(x => `<tr><td>${esc(x.description || x.number || '')}</td><td class="num">${esc(x.expense_date)}</td><td class="amt num">${money(x.amount)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">لا توجد.</p>'}</section></div></div>`;
  if ($('#edcc')) $('#edcc').onclick = () => projectDrawer(c, ccs);
  if (api.mode === 'supabase') projectTasksCard(c);
}
async function projectTasksCard(c) {
  const ts = (await api.listTasks().catch(() => [])).filter(t => t.cost_center_id === c.id), done = ts.filter(t => t.status === 'done').length, today = riyadhToday();
  const ST = { todo: ['للتنفيذ', 'b-draft'], doing: ['قيد التنفيذ', 'b-warn'], done: ['منجزة', 'b-ok'] }, pctv = ts.length ? Math.round(done / ts.length * 100) : 0;
  const sec = document.createElement('section'); sec.className = 'card'; sec.style.marginBottom = '20px'; sec.id = 'ptasks';
  sec.innerHTML = `<div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px"><h3 style="margin:0">المهام ونسبة الإنجاز</h3><span class="row" style="gap:6px"><a class="btn ghost sm" href="#/tasks?project=${esc(c.id)}">لوحة المهام</a>${can_any_write() ? '<button class="btn secondary sm" id="ptadd">' + icon('plus') + 'مهمة</button>' : ''}</span></div>
    <div class="row" style="justify-content:space-between;margin-top:10px"><span>الإنجاز: <b class="num">${done}</b> من <b class="num">${ts.length}</b> مهمة</span><b class="num">${pctv}%</b></div>
    <div class="bar" style="margin:6px 0 12px;height:10px"><i style="width:${pctv}%"></i></div>
    ${ts.length ? `<div class="tbl-wrap"><table><tbody>${ts.map(t => `<tr><td><label class="row" style="gap:8px"><input type="checkbox" data-tdone="${esc(t.id)}" ${t.status === 'done' ? 'checked' : ''} aria-label="منجزة"> <span style="${t.status === 'done' ? 'text-decoration:line-through;opacity:.6' : ''}">${esc(t.title)}</span></label></td>
      <td>${badge(ST[t.status])}${t.priority === 'high' ? ' ' + badge(['عاجل', 'b-bad']) : ''}</td><td class="num xs ${t.status !== 'done' && t.due_date && t.due_date < today ? 'down' : 'muted'}">${esc(t.due_date || '')}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="muted">لا توجد مهام بعد — قسّم المشروع إلى مهام (تصميم، قص، لحام، دهان، تجهيز داخلي، تسليم) بمسؤول وتاريخ استحقاق.</p>'}`;
  const anchor = $('#main .grid.g2'); if (anchor) anchor.before(sec); else $('#main').append(sec);
  $$('[data-tdone]', sec).forEach(cb => cb.onchange = async () => { try { await api.saveTask({ id: cb.dataset.tdone, status: cb.checked ? 'done' : 'todo' }); projectTasksCard2(c); } catch (x) { fail(x); cb.checked = !cb.checked; } });
  if ($('#ptadd', sec)) $('#ptadd', sec).onclick = () => drawer('مهمة جديدة — ' + c.name, `${field('title', 'المهمة', { req: true })}<div class="form-grid">${field('due_date', 'تاريخ الاستحقاق', { type: 'date' })}${select('priority', 'الأولوية', [['low', 'منخفضة'], ['normal', 'عادية'], ['high', 'عاجلة']], 'normal')}</div>`,
    async v => { if (!v.title?.trim()) throw new AppError('اكتب المهمة'); await api.saveTask({ title: v.title.trim(), cost_center_id: c.id, due_date: v.due_date || null, priority: v.priority, status: 'todo' }); toast('أُضيفت المهمة'); projectTasksCard2(c); });
}
const projectTasksCard2 = c => { $('#ptasks')?.remove(); projectTasksCard(c); };

// ---------- point of sale ----------
const POS_CART = 'daftar-pos-cart';
async function posView() {
  shell('pos', loading());
  if (!can('sales', 'post')) { shell('pos', `<div class="page-head"><h1>نقطة البيع</h1></div>${empty('lock', 'تحتاج صلاحية «اعتماد وترحيل» في المبيعات', 'نقطة البيع تُصدر الفاتورة وتقبض المبلغ فوراً.')}`); return; }
  const [items, parties, whs] = await Promise.all([api.listItems(), api.listParties('customer'), api.listWarehouses()]);
  const sell = items.filter(i => i.is_active !== false && Number(i.sale_price) > 0);
  let cart = []; try { cart = JSON.parse(localStorage.getItem(POS_CART) || '[]').filter(l => sell.some(i => i.id === l.id)); } catch { cart = []; }
  const save = () => { try { localStorage.setItem(POS_CART, JSON.stringify(cart)); } catch { /* private mode */ } };
  const I = Object.fromEntries(sell.map(i => [i.id, i]));
  let wh = sessionStorage.getItem('pos-wh') || whs[0]?.id, q = '';
  $('#main').innerHTML = `<div class="pos">
    <section class="pos-items"><div class="row" style="gap:8px;margin-bottom:12px;flex-wrap:wrap"><h1 style="margin:0;flex:1">نقطة البيع</h1>
        ${whs.length > 1 ? `<select class="input" id="poswh" aria-label="المستودع" style="height:38px;width:auto">${optList(whs.map(w => [w.id, w.name]), wh)}</select>` : ''}</div>
      <input class="input" id="posq" placeholder="ابحث بالاسم أو امسح الباركود / رمز الصنف ثم Enter" aria-label="بحث" autocomplete="off" style="margin-bottom:12px">
      <div class="pos-grid" id="posg"></div></section>
    <aside class="pos-cart card"><h2 style="margin-bottom:8px">الفاتورة</h2>
      <div class="field"><label for="f-poscust">العميل</label><select class="input" id="f-poscust">${optList(parties.map(p => [p.id, p.name]), '', '— عميل نقدي —')}</select></div>
      <div id="posl" class="pos-lines"></div>
      <div class="totals" aria-live="polite"><div><span class="muted">قبل الضريبة</span><span class="num" id="pS"></span></div><div><span class="muted">الضريبة 15%</span><span class="num" id="pV"></span></div><div class="grand"><span>الإجمالي</span><span class="num" id="pT"></span></div></div>
      <div class="field"><label for="f-paid">المبلغ المستلم نقداً (اختياري)</label><input class="input num" id="f-paid" inputmode="decimal" placeholder="0.00"><span class="help" id="change"></span></div>
      <p class="help err" id="poserr" role="alert"></p>
      <div class="grid g2" style="gap:8px"><button class="btn primary lg" id="paycash">${icon('pos')}نقداً</button><button class="btn secondary lg" id="paycard">شبكة / مدى</button></div>
      <button class="btn ghost sm" id="posclear" style="margin-top:8px;width:100%">إفراغ السلة</button></aside></div>`;
  const tot = () => { let s = 0, v = 0; cart.forEach(l => { const it = I[l.id]; const k = lineCalc({ qty: l.qty, unit_price: Number(it.sale_price), discount: 0, vat_rate: it.tax_category === 'S' ? 15 : 0 }); s += k.net; v += k.vat; }); return { s, v, t: s + v }; };
  const drawGrid = () => { const f = q ? sell.filter(i => (i.name_ar + ' ' + (i.sku || '') + ' ' + (i.barcode || '')).toLowerCase().includes(q.toLowerCase())) : sell;
    $('#posg').innerHTML = f.length ? f.map(i => `<button class="pos-tile" data-add="${esc(i.id)}"><b>${esc(i.name_ar)}</b><span class="num">${money(i.sale_price)}</span>${i.track_stock ? `<span class="xs ${i.on_hand <= 0 ? 'down' : 'muted'}">المتاح ${fq(i.on_hand)}</span>` : '<span class="xs muted">خدمة</span>'}</button>`).join('')
      : `<p class="muted">${sell.length ? 'لا نتائج.' : 'لا توجد أصناف لها سعر بيع. أضفها من <a href="#/items">الأصناف</a>.'}</p>`; };
  const drawCart = () => { const { s, v, t } = tot();
    $('#posl').innerHTML = cart.length ? cart.map((l, i) => { const it = I[l.id]; return `<div class="pos-line" data-i="${i}"><div style="flex:1;min-width:0"><b>${esc(it.name_ar)}</b><div class="xs muted num">${money(it.sale_price)} × ${fq(l.qty)}</div></div>
        <button class="btn ghost icon sm" data-dec aria-label="إنقاص">−</button><input class="input num" data-qty value="${fq(l.qty)}" inputmode="decimal" aria-label="الكمية" style="width:56px;height:34px;text-align:center"><button class="btn ghost icon sm" data-inc aria-label="زيادة">+</button>
        <b class="num" style="min-width:76px;text-align:end">${money(lineCalc({ qty: l.qty, unit_price: Number(it.sale_price), discount: 0, vat_rate: it.tax_category === 'S' ? 15 : 0 }).net * (it.tax_category === 'S' ? 1.15 : 1))}</b></div>`; }).join('')
      : '<p class="muted" style="text-align:center;padding:16px 0">اضغط على صنف لإضافته</p>';
    $('#pS').textContent = money(s); $('#pV').textContent = money(v); $('#pT').textContent = money(t) + ' ر.س';
    const paid = toHalalas($('#f-paid').value || 0); $('#change').textContent = paid > 0 && Number.isFinite(paid) ? (paid >= t ? `الباقي للعميل: ${money(paid - t)} ر.س` : `ناقص ${money(t - paid)} ر.س`) : '';
    $('#paycash').disabled = $('#paycard').disabled = !cart.length; save(); };
  const add = id => { const l = cart.find(x => x.id === id); if (l) l.qty += 1; else cart.push({ id, qty: 1 }); drawCart(); };
  $('#posg').onclick = e => { const b = e.target.closest('[data-add]'); if (b) add(b.dataset.add); };
  $('#posq').oninput = e => { q = e.target.value.trim(); drawGrid(); };
  $('#posq').onkeydown = e => { if (e.key !== 'Enter') return; e.preventDefault(); const v = q.toLowerCase();
    const hit = sell.find(i => (i.sku || '').toLowerCase() === v || (i.barcode || '').toLowerCase() === v) || (q && sell.filter(i => i.name_ar.includes(q)).length === 1 ? sell.find(i => i.name_ar.includes(q)) : null);
    if (hit) { add(hit.id); e.target.value = ''; q = ''; drawGrid(); } else toast('لم يُعثر على الصنف', 'warn'); };
  $('#posl').addEventListener('click', e => { const r = e.target.closest('[data-i]'); if (!r) return; const l = cart[r.dataset.i];
    if (e.target.closest('[data-inc]')) l.qty += 1; else if (e.target.closest('[data-dec]')) l.qty -= 1; else return;
    if (l.qty <= 0) cart.splice(r.dataset.i, 1); drawCart(); });
  $('#posl').addEventListener('change', e => { const r = e.target.closest('[data-i]'); if (!r || !e.target.matches('[data-qty]')) return; const n = num(e.target.value);
    if (!(n > 0)) cart.splice(r.dataset.i, 1); else cart[r.dataset.i].qty = n; drawCart(); });
  $('#f-paid').oninput = drawCart;
  $('#posclear').onclick = () => { cart = []; drawCart(); };
  if ($('#poswh')) $('#poswh').onchange = e => { wh = e.target.value; sessionStorage.setItem('pos-wh', wh); };
  const pay = async method => { const err = $('#poserr'); err.textContent = ''; if (!cart.length) return;
    const { t } = tot(), paid = toHalalas($('#f-paid').value || 0);
    if (method === 'cash' && paid > 0 && paid < t) { err.textContent = 'المبلغ المستلم أقل من الإجمالي'; return; }
    const btns = $$('.pos-cart button'); btns.forEach(b => b.disabled = true);
    try {
      const party = $('#f-poscust').value || null;
      const id = await api.saveDraft({ kind: 'simplified_invoice', party_id: party, issue_date: riyadhToday(), issue_time: riyadhTime(), warehouse_id: wh, note: 'نقطة البيع' },
        cart.map(l => { const it = I[l.id]; return { item_id: it.id, description: it.name_ar, qty: l.qty, unit_price: Math.round(Number(it.sale_price)), discount: 0, tax_category: it.tax_category, vat_rate: it.tax_category === 'S' ? 15 : 0 }; }));
      await api.postDocument('simplified_invoice', id);
      const d = await api.getDocument(id);
      await api.createReceipt({ kind: 'receipt', party_id: party, pay_date: d.issue_date, amount: d.total, method, reference: d.number, allocations: [{ document_id: id, amount: d.total }] });
      cart = []; save(); $('#f-paid').value = ''; drawCart(); posReceipt(d, method, method === 'cash' && paid > 0 ? paid : null);
      api.listItems().then(x => { x.forEach(i => { if (I[i.id]) I[i.id].on_hand = i.on_hand; }); drawGrid(); }).catch(() => {});
    } catch (x) { err.textContent = x.message; fail(x); } finally { btns.forEach(b => b.disabled = false); drawCart(); } };
  $('#paycash').onclick = () => pay('cash'); $('#paycard').onclick = () => pay('card');
  drawGrid(); drawCart(); $('#posq').focus();
}
function posReceipt(d, method, paid) {
  let qr = ''; try { const ts = `${d.issue_date}T${(d.issue_time || '00:00:00').slice(0, 8)}+03:00`;
    qr = QR.svg(QR.encode(QR.ascii(QR.zatcaTLV({ seller: ORG.name_ar, vatNo: ORG.vat_number || '', timestamp: new Date(ts).toISOString().replace('.000', ''), total: (d.total / 100).toFixed(2), vat: (d.vat_total / 100).toFixed(2) }))), 3); } catch { qr = ''; }
  const bg = document.createElement('div'); bg.className = 'drawer-bg receipt-bg';
  bg.innerHTML = `<div class="receipt-wrap"><div class="receipt80" id="rcpt">
      <div style="text-align:center"><b style="font-size:15px">${esc(ORG.name_ar)}</b><br>${ORG.vat_number ? `الرقم الضريبي <span class="num">${esc(ORG.vat_number)}</span><br>` : ''}${esc(ORG.city || '')}
        <div style="margin:6px 0;font-weight:700">فاتورة ضريبية مبسطة<br><span style="font-weight:400">Simplified Tax Invoice</span></div></div>
      <div class="rc-row"><span>الرقم</span><span class="num">${esc(d.number)}</span></div><div class="rc-row"><span>التاريخ</span><span class="num">${esc(d.issue_date)} ${esc((d.issue_time || '').slice(0, 5))}</span></div>
      ${d.party ? `<div class="rc-row"><span>العميل</span><span>${esc(d.party.name)}</span></div>` : ''}<hr>
      ${d.lines.map(l => `<div>${esc(l.description)}</div><div class="rc-row xs"><span class="num">${fq(l.qty)} × ${money(l.unit_price)}</span><span class="num">${money(Number(l.line_net) + Number(l.line_vat))}</span></div>`).join('')}<hr>
      <div class="rc-row"><span>الإجمالي قبل الضريبة</span><span class="num">${money(d.subtotal)}</span></div><div class="rc-row"><span>ضريبة القيمة المضافة 15%</span><span class="num">${money(d.vat_total)}</span></div>
      <div class="rc-row" style="font-weight:800;font-size:15px"><span>الإجمالي</span><span class="num">${money(d.total)} ر.س</span></div>
      <div class="rc-row"><span>الدفع</span><span>${method === 'cash' ? 'نقداً' : 'شبكة / مدى'}</span></div>
      ${paid ? `<div class="rc-row"><span>المستلم</span><span class="num">${money(paid)}</span></div><div class="rc-row"><span>الباقي</span><span class="num">${money(paid - d.total)}</span></div>` : ''}
      <div style="text-align:center;margin-top:8px">${qr}</div>${ORG.invoice_footer ? `<p style="text-align:center;font-size:11px;margin:6px 0 0">${esc(ORG.invoice_footer)}</p>` : '<p style="text-align:center;font-size:11px;margin:6px 0 0">شكراً لزيارتكم</p>'}</div>
    <div class="row no-print" style="gap:8px;justify-content:center;margin-top:12px"><button class="btn primary" id="rprint">${icon('down')}طباعة الإيصال</button><button class="btn secondary" id="rnew">بيع جديد</button><a class="btn ghost" href="#/invoices/${esc(d.id)}">عرض الفاتورة</a></div></div>`;
  document.body.append(bg);
  const close = () => { bg.remove(); $('#posq')?.focus(); };
  $('#rnew', bg).onclick = close; bg.onclick = e => { if (e.target === bg) close(); };
  $('#rprint', bg).onclick = () => { document.body.classList.add('print-receipt'); window.print(); setTimeout(() => document.body.classList.remove('print-receipt'), 500); };
  $('#rnew', bg).focus();
}

const POS_ROUTES = [
  [/^#\/pos$/, gate('pos', 'نقطة البيع', 'sales', posView)],
  [/^#\/projects$/, gate('projects', 'المشاريع', 'accounting|manufacturing|reports|sales', projectsView)],
  [/^#\/projects\/([\w-]+)$/, gate('projects', 'المشاريع', 'accounting|manufacturing|reports|sales', m => projectView(m[1]))],
];
