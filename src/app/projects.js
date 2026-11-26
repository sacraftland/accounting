// =====================================================================
// Projects: types (customer / production / internal), templates & copies,
// planned materials with issue / return / purchase, tasks assigned to workers
// with phases & a timeline, timesheets with hourly cost, planned-vs-actual.
// Inserted after ext3.js by build.py.
// =====================================================================
const PTYPE = { customer: ['مشروع لعميل', 'b-info'], production: ['تصنيع إنتاجي', 'b-warn'], internal: ['مركز تكلفة داخلي', 'b-draft'] };
const WTYPE = { monthly: '', daily: 'يومية', hourly: 'بالساعة' };
const wpickRow = (w, on) => `<label class="row" style="gap:6px"><input type="checkbox" name="w_${esc(w.id)}" ${on ? 'checked' : ''}> ${esc(w.full_name)}<span class="xs muted">${esc([w.job_title, WTYPE[w.employment_type]].filter(Boolean).join(' · '))}</span></label>`;
const PHASES = ['التصميم والاعتماد', 'القص والتجهيز', 'اللحام والهيكل', 'الكهرباء والسباكة', 'العزل', 'الدهان', 'التجهيز الداخلي', 'الفحص والتسليم'];
const projEditable = () => can('accounting', 'create') || can('manufacturing', 'create');
const hoursEditable = () => can('hr', 'create') || can('manufacturing', 'create') || can('accounting', 'create');
const dayDiff = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 864e5);
const nextCode = (ccs, pre) => { const n = ccs.map(c => (c.code.match(new RegExp('^' + pre + '-(\\d+)$')) || [])[1]).filter(Boolean).map(Number); return pre + '-' + String((n.length ? Math.max(...n) : 0) + 1).padStart(3, '0'); };

// ---------- list ----------
async function projectsView(qs) {
  shell('projects', loading());
  const f = qs?.get('f') || 'active';
  const [ccs, pl, ts, ps, items] = await Promise.all([api.listCostCenters(true), can('accounting') || can('reports') || can('manufacturing') ? api.projectPl('2000-01-01', riyadhToday()) : [], api.listTasks().catch(() => []), api.listParties('customer').catch(() => []), api.listItems().catch(() => [])]);
  const P = Object.fromEntries(pl.map(r => [r.id, r])), PN = Object.fromEntries(ps.map(p => [p.id, p.name])), IN = Object.fromEntries(items.map(i => [i.id, i.name_ar])), today = riyadhToday();
  const TS = {}; ts.forEach(t => { if (!t.cost_center_id) return; const x = (TS[t.cost_center_id] ||= { n: 0, done: 0, late: 0 }); x.n++; if (t.status === 'done') x.done++; else if (t.due_date && t.due_date < today) x.late++; });
  const rows = ccs.map(c => { const r = P[c.id] || { revenue: 0, cogs: 0, expenses: 0 }, cost = r.cogs + r.expenses; return { ...c, ...r, cost, profit: r.revenue - cost }; });
  const FIL = { active: ['النشطة', r => !r.is_template && r.status === 'active' && r.project_type !== 'internal'], closed: ['المنتهية', r => !r.is_template && r.status === 'closed'],
    internal: ['مراكز التكلفة', r => !r.is_template && r.project_type === 'internal' && r.status === 'active'], templates: ['القوالب', r => r.is_template] };
  const list = rows.filter(FIL[f]?.[1] || FIL.active[1]), act = rows.filter(FIL.active[1]);
  const T = k => act.reduce((s, r) => s + (r[k] || 0), 0);
  $('#main').innerHTML = `<div class="page-head"><h1>المشاريع</h1>${projEditable() ? `<button class="btn primary" id="newp">${icon('plus')}مشروع جديد</button>` : ''}</div>
    <div class="grid g4" style="margin-bottom:20px">${[['مشاريع نشطة', act.length, 0], ['متأخرة عن التسليم', act.filter(r => r.due_date && r.due_date < today).length, 0], ['إيرادات المشاريع النشطة', T('revenue'), 1], ['ربح المشاريع النشطة', T('profit'), 1]]
      .map(([t, v, m]) => `<div class="card stat"><div class="label">${t}</div><div class="val num ${m && v < 0 ? 'down' : ''}">${m ? money(v) : v}</div></div>`).join('')}</div>
    <div class="tabs">${Object.entries(FIL).map(([k, [t, fn]]) => `<a href="#/projects?f=${k}" class="${k === f ? 'on' : ''}">${t} <span class="muted num">${rows.filter(fn).length}</span></a>`).join('')}</div>
    ${list.length ? `<div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>المشروع</th><th class="m-hide">النوع</th><th class="m-hide">العميل / المنتج</th><th class="m-hide">التسليم</th><th>المهام</th>${f === 'templates' ? '' : '<th class="amt">التكلفة</th><th class="amt">الربح</th>'}</tr></thead><tbody>
      ${list.map(r => { const t = TS[r.id], late = r.status === 'active' && r.due_date && r.due_date < today;
        return `<tr class="click" data-href="#/projects/${esc(r.id)}"><td style="white-space:normal"><a class="rowlink" href="#/projects/${esc(r.id)}"><b>${esc(r.name)}</b></a> <span class="xs muted num">${esc(r.code)}</span></td>
        <td class="m-hide">${badge(PTYPE[r.project_type] || PTYPE.customer)}</td><td class="m-hide">${esc(r.project_type === 'production' ? (IN[r.product_item_id] || '') + (r.production_qty ? ' × ' + fq(r.production_qty) : '') : PN[r.party_id] || '—')}</td>
        <td class="num m-hide ${late ? 'down' : ''}">${esc(r.due_date || '—')}${late ? ' ⚠' : ''}</td>
        <td>${t ? `<div class="bar"><i style="width:${(t.done / t.n * 100).toFixed(0)}%"></i></div><span class="xs muted num">${t.done}/${t.n}</span>${t.late ? ` <span class="xs down">${t.late} متأخرة</span>` : ''}` : '<span class="xs muted">—</span>'}</td>
        ${f === 'templates' ? '' : `<td class="amt num">${money(r.cost)}</td><td class="amt num ${r.profit < 0 ? 'down' : ''}"><b>${money(r.profit)}</b></td>`}</tr>`; }).join('')}</tbody></table></div>`
    : empty('box', f === 'templates' ? 'لا توجد قوالب' : 'لا توجد مشاريع هنا', f === 'templates' ? 'افتح مشروعاً جاهزاً واضغط «حفظ كقالب» — ثم أنشئ منه أي مشروع جديد بنقرة.' : 'أنشئ مشروعاً لكل كرفان أو عقد، أو دفعة إنتاج للمخزون، أو مركز تكلفة لقسم داخلي.', projEditable() ? `<button class="btn primary" id="newp2">${icon('plus')}مشروع جديد</button>` : '')}`;
  ['#newp', '#newp2'].forEach(s => { if ($(s)) $(s).onclick = () => newProjectDrawer(ccs, ps, items); });
  $$('#main tr.click').forEach(tr => tr.onclick = e => { if (!e.target.closest('a')) location.hash = tr.dataset.href; });
}

// ---------- create: choose the type, or copy a template / finished project ----------
function newProjectDrawer(ccs, ps, items, preset) {
  const srcs = ccs.filter(c => c.project_type !== 'internal' || c.is_template).sort((a, b) => (b.is_template - a.is_template) || (b.status === 'closed') - (a.status === 'closed'));
  const mode0 = preset || 'customer', products = items.filter(i => i.kind === 'product');
  const f = drawer('مشروع جديد', `
    <div class="ptype-pick" role="radiogroup" aria-label="نوع المشروع">${[['customer', 'مشروع لعميل', 'كرفان أو عقد لعميل بقيمة وتاريخ تسليم'], ['production', 'تصنيع إنتاجي', 'دفعة منتج للمخزون من قائمة المواد'], ['internal', 'مركز تكلفة داخلي', 'الورشة، الصيانة، قسم أو فرع'], ['copy', 'نسخ من قالب أو مشروع سابق', 'المهام والمواد والساعات جاهزة']]
      .map(([k, t, d]) => `<label class="ptype ${k === mode0 ? 'on' : ''}"><input type="radio" name="mode" value="${k}" ${k === mode0 ? 'checked' : ''}><b>${t}</b><span class="xs muted">${d}</span></label>`).join('')}</div>
    <div id="pf-copy">${srcs.length ? select('src', 'انسخ من', srcs.map(c => [c.id, `${c.is_template ? '📋 قالب: ' : c.status === 'closed' ? '✔ منتهي: ' : ''}${c.name} (${c.code})`]), srcs[0].id) : '<p class="note warn">لا توجد قوالب أو مشاريع سابقة بعد.</p>'}</div>
    <div class="form-grid">${field('code', 'رمز المشروع', { req: true, value: nextCode(ccs, mode0 === 'internal' ? 'CC' : 'P'), attrs: 'dir="ltr" maxlength="20"' })}${field('name', 'اسم المشروع', { req: true, help: 'مثل: كرفان 8 متر — مؤسسة البر' })}</div>
    <div id="pf-customer"><div class="field"><label for="f-party_id">العميل</label><select class="input" id="f-party_id" name="party_id">${optList(ps.map(p => [p.id, p.name]), '', '— بدون —')}</select></div>
      ${field('contract_value', 'قيمة العقد قبل الضريبة', { type: 'money' })}</div>
    <div id="pf-production"><div class="form-grid"><div class="field"><label for="f-product_item_id">المنتج</label><select class="input" id="f-product_item_id" name="product_item_id">${optList([...products.map(i => [i.id, i.name_ar]), ['__new', '+ منتج جديد…']], products.length ? '' : '__new', products.length ? '— اختر —' : undefined)}</select></div>
      ${field('production_qty', 'الكمية المطلوب إنتاجها', { value: '1', attrs: 'inputmode="decimal"' })}</div>
      <div id="pf-newprod" class="form-grid">${field('new_product', 'اسم المنتج الجديد', { help: products.length ? 'يُضاف للأصناف كسلعة مخزنية' : 'لا توجد منتجات بعد — اكتب اسم المنتج ويُضاف للأصناف تلقائياً' })}${field('new_price', 'سعر البيع قبل الضريبة (اختياري)', { type: 'money' })}</div></div>
    <div id="pf-dates" class="form-grid">${field('start_date', 'تاريخ البداية', { type: 'date', value: riyadhToday() })}${field('due_date', 'تاريخ التسليم المتوقع', { type: 'date' })}</div>
    <div id="pf-desc">${field('description', 'وصف / مواصفات مختصرة', {})}</div>`,
    async v => { const mode = v.mode;
      if (!v.code?.trim() || !v.name?.trim()) throw new AppError('أدخل رمز المشروع واسمه');
      if (ccs.some(c => c.code === v.code.trim())) throw new AppError('رمز المشروع مستخدم');
      let id;
      if (mode === 'copy') { if (!v.src) throw new AppError('اختر القالب أو المشروع'); id = await api.copyProject(v.src, v.code.trim(), v.name.trim(), v.party_id || null, v.start_date || null, false); }
      else { if (v.due_date && v.start_date && v.due_date < v.start_date) throw new AppError('تاريخ التسليم قبل تاريخ البداية');
        const cv = mode === 'customer' && v.contract_value ? toHalalas(v.contract_value) : null; if (cv != null && !(cv >= 0)) throw new AppError('قيمة العقد غير صحيحة');
        const pq = mode === 'production' ? num(v.production_qty) : null;
        if (mode === 'production' && v.product_item_id === '__new') { if (!v.new_product?.trim()) throw new AppError('اكتب اسم المنتج الجديد'); const pr = v.new_price ? toHalalas(v.new_price) : 0; if (!(pr >= 0)) throw new AppError('سعر غير صحيح');
          v.product_item_id = (await api.saveItem({ kind: 'product', name_ar: v.new_product.trim(), unit: 'unit', sale_price: pr, tax_category: 'S', vat_rate: 15, track_stock: true })).id; }
        if (mode === 'production' && (!v.product_item_id || !(pq > 0))) throw new AppError('اختر المنتج والكمية');
        id = (await api.saveCostCenter({ code: v.code.trim(), name: v.name.trim(), project_type: mode, party_id: mode === 'customer' ? v.party_id || null : null, contract_value: cv,
          product_item_id: mode === 'production' ? v.product_item_id : null, production_qty: pq, start_date: mode === 'internal' ? null : v.start_date || null, due_date: mode === 'internal' ? null : v.due_date || null, description: v.description || null, status: 'active' })).id;
        if (mode === 'production') { const b = (await api.listBoms()).find(x => x.item_id === v.product_item_id);
          if (b) for (const l of b.bom_lines) await api.saveProjectMaterial({ cost_center_id: id, item_id: l.item_id, planned_qty: Math.round(l.qty * (1 + (l.waste_pct || 0) / 100) * pq / (b.output_qty || 1) * 10000) / 10000 }); } }
      toast('أُنشئ المشروع'); location.hash = '#/projects/' + id; }, 'إنشاء المشروع');
  const sync = () => { const mode = $('[name=mode]:checked', f).value;
    $$('.ptype', f).forEach(l => l.classList.toggle('on', $('input', l).checked));
    $('#pf-copy', f).hidden = mode !== 'copy'; $('#pf-customer', f).hidden = !['customer', 'copy'].includes(mode); $('#f-contract_value', f).closest('.field').hidden = mode !== 'customer';
    $('#pf-production', f).hidden = mode !== 'production'; $('#pf-newprod', f).hidden = mode !== 'production' || $('#f-product_item_id', f).value !== '__new'; $('#pf-dates', f).hidden = mode === 'internal'; $('#pf-desc', f).hidden = mode === 'copy';
    const code = $('#f-code', f); if (/^(P|CC)-\d{3}$/.test(code.value)) code.value = nextCode(ccs, mode === 'internal' ? 'CC' : 'P');
    if (mode === 'copy' && $('#f-src', f) && !$('#f-name', f).value) { const s = srcs.find(c => c.id === $('#f-src', f).value); if (s) $('#f-name', f).value = s.name.replace(/^قالب:\s*/, '') + ' — '; } };
  $$('[name=mode]', f).forEach(r => r.onchange = sync); if ($('#f-src', f)) $('#f-src', f).onchange = () => { $('#f-name', f).value = ''; sync(); };
  if ($('#f-product_item_id', f)) $('#f-product_item_id', f).onchange = e => { sync(); if (e.target.value !== '__new' && !$('#f-name', f).value) $('#f-name', f).value = 'إنتاج ' + (products.find(i => i.id === e.target.value)?.name_ar || ''); };
  sync();
}

function editProjectDrawer(c, ps, items, workers) {
  const products = items.filter(i => i.kind === 'product');
  drawer('تعديل المشروع', `<div class="form-grid">${field('code', 'الرمز', { req: true, value: c.code, attrs: 'dir="ltr"' })}${select('project_type', 'النوع', Object.entries(PTYPE).map(([k, v]) => [k, v[0]]), c.project_type)}</div>
    ${field('name', 'الاسم', { req: true, value: c.name })}
    <div class="form-grid">${select('party_id', 'العميل', [['', '— بدون —'], ...ps.map(p => [p.id, p.name])], c.party_id || '')}${field('contract_value', 'قيمة العقد قبل الضريبة', { type: 'money', value: c.contract_value ? money(c.contract_value) : '' })}
      ${select('product_item_id', 'المنتج (للإنتاج)', [['', '—'], ...products.map(i => [i.id, i.name_ar])], c.product_item_id || '')}${field('production_qty', 'كمية الإنتاج', { value: c.production_qty ? fq(c.production_qty) : '', attrs: 'inputmode="decimal"' })}
      ${field('start_date', 'البداية', { type: 'date', value: c.start_date || '' })}${field('due_date', 'التسليم المتوقع', { type: 'date', value: c.due_date || '' })}
      ${workers.length ? select('manager_employee_id', 'مسؤول المشروع', [['', '—'], ...workers.map(w => [w.id, w.full_name])], c.manager_employee_id || '') : ''}${field('budget_other', 'ميزانية مصاريف أخرى', { type: 'money', value: c.budget_other ? money(c.budget_other) : '', help: 'نقل، تركيب، رسوم…' })}</div>
    ${field('description', 'الوصف', { value: c.description || '' })}${select('status', 'الحالة', [['active', 'نشط'], ['closed', 'منتهي / مغلق']], c.status)}`,
    async v => { if (!v.code?.trim() || !v.name?.trim()) throw new AppError('الرمز والاسم مطلوبان'); if (v.due_date && v.start_date && v.due_date < v.start_date) throw new AppError('تاريخ التسليم قبل تاريخ البداية');
      const m = k => { if (!v[k]) return null; const x = toHalalas(v[k]); if (!(x >= 0)) throw new AppError('مبلغ غير صحيح'); return x; };
      await api.saveCostCenter({ id: c.id, code: v.code.trim(), name: v.name.trim(), project_type: v.project_type, party_id: v.party_id || null, contract_value: m('contract_value'), product_item_id: v.product_item_id || null,
        production_qty: v.production_qty ? num(v.production_qty) : null, start_date: v.start_date || null, due_date: v.due_date || null, manager_employee_id: v.manager_employee_id || null, budget_other: m('budget_other'), description: v.description || null, status: v.status });
      toast('حُفظ المشروع'); projectView(c.id); });
}

// ---------- project page ----------
async function projectView(id, qs) {
  shell('projects', loading()); const tab = qs?.get('tab') || 'overview', today = riyadhToday();
  const [ccs, pl, d, ts, mats, stk, sheets, workers, items, bal, ps] = await Promise.all([api.listCostCenters(true), can('accounting') || can('reports') || can('manufacturing') ? api.projectPl('2000-01-01', today) : [], api.projectDocs(id),
    api.listTasks().catch(() => []), api.listProjectMaterials(id).catch(() => []), api.projectStock(id).catch(() => []), api.listTimesheets(id).catch(() => []), api.listWorkers().catch(() => []), api.listItems(), api.stockByWarehouse().catch(() => []), api.listParties('customer').catch(() => [])]);
  const c = ccs.find(x => x.id === id); if (!c) throw new AppError('المشروع غير موجود');
  const I = Object.fromEntries(items.map(i => [i.id, i])), W = Object.fromEntries(workers.map(w => [w.id, w])), tasks = ts.filter(t => t.cost_center_id === id).sort((a, b) => (a.sort - b.sort) || String(a.start_date || '').localeCompare(String(b.start_date || '')));
  const r = pl.find(x => x.id === id) || { revenue: 0, cogs: 0, expenses: 0 }, cost = r.cogs + r.expenses, profit = r.revenue - cost;
  // materials: planned vs issued (net of returns)
  const used = {}; stk.filter(s => s.status === 'posted').forEach(s => s.stock_doc_lines.forEach(l => { const u = (used[l.item_id] ||= { qty: 0, cost: 0 }), sg = s.kind === 'issue' ? 1 : -1; u.qty += sg * l.qty; u.cost += sg * l.qty * l.unit_cost; }));
  const onHand = {}; bal.forEach(b => onHand[b.item_id] = (onHand[b.item_id] || 0) + b.qty);
  const matIds = [...new Set([...mats.map(m => m.item_id), ...Object.keys(used)])];
  const plannedMat = mats.reduce((s, m) => s + m.planned_qty * Number(I[m.item_id]?.avg_cost || 0), 0), actualMat = Object.values(used).reduce((s, u) => s + u.cost, 0);
  // labor: estimated vs logged
  const hrsBy = {}; sheets.forEach(t => { const x = (hrsBy[t.task_id || '_'] ||= { h: 0, a: 0 }); x.h += t.hours; x.a += t.amount; });
  const avgRate = t => { const rs = (t.employee_ids || []).map(e => W[e]?.hour_rate).filter(v => v != null); return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null; };
  const estH = tasks.reduce((s, t) => s + Number(t.est_hours || 0), 0), logH = sheets.reduce((s, t) => s + t.hours, 0), logA = sheets.reduce((s, t) => s + t.amount, 0), postedA = sheets.filter(t => t.status === 'posted').reduce((s, t) => s + t.amount, 0);
  const plannedLab = tasks.reduce((s, t) => s + Number(t.est_hours || 0) * (avgRate(t) || 0), 0);
  const otherActual = Math.max(0, cost - actualMat - postedA), done = tasks.filter(t => t.status === 'done').length, pct = tasks.length ? Math.round(done / tasks.length * 100) : 0;
  const late = c.status === 'active' && c.due_date && c.due_date < today, ed = projEditable() && !c.is_template;
  const stat = (t, v, sub, cls = '') => `<div class="card stat"><div class="label">${t}</div><div class="val num ${cls}">${v}</div>${sub ? `<div class="xs muted">${sub}</div>` : ''}</div>`;
  const TABS = [['overview', 'نظرة عامة'], ['tasks', `المهام <span class="muted num">${tasks.length}</span>`], ['materials', `المواد <span class="muted num">${matIds.length}</span>`], ['labor', `العمالة والساعات <span class="muted num">${fq(logH)}</span>`], ['docs', 'المستندات']];
  $('#main').innerHTML = `<a class="crumb" href="#/projects${c.is_template ? '?f=templates' : ''}">${icon('chev')} المشاريع</a>
    <div class="page-head"><h1>${esc(c.name)} <span class="num muted" style="font-size:var(--fs-md)">${esc(c.code)}</span></h1>${badge(PTYPE[c.project_type] || PTYPE.customer)}
      ${c.is_template ? badge(['قالب', 'b-info']) : badge(c.status === 'active' ? (late ? ['متأخر', 'b-bad'] : ['نشط', 'b-ok']) : ['منتهي', 'b-draft'])}
      ${projEditable() ? `<button class="btn ghost" id="pedit">تعديل</button><button class="btn ghost" id="pcopy">${c.is_template ? 'مشروع من هذا القالب' : 'نسخ'}</button>${c.is_template ? '' : '<button class="btn ghost" id="ptpl">حفظ كقالب</button>'}` : ''}</div>
    <div class="card" style="margin-bottom:16px"><dl class="kv">${c.party_id ? `<dt>العميل</dt><dd><a href="#/customers/${esc(c.party_id)}">${esc(ps.find(p => p.id === c.party_id)?.name || '')}</a></dd>` : ''}
      ${c.product_item_id ? `<dt>المنتج</dt><dd>${esc(I[c.product_item_id]?.name_ar || '')} × <span class="num">${fq(c.production_qty || 0)}</span></dd>` : ''}
      ${c.start_date || c.due_date ? `<dt>المدة</dt><dd class="num">${esc(c.start_date || '؟')} ← ${esc(c.due_date || '؟')}${c.due_date && c.status === 'active' ? ` · ${late ? `<span class="down">متأخر ${-daysTo(c.due_date)} يوم</span>` : `باقي ${daysTo(c.due_date)} يوم`}` : ''}</dd>` : ''}
      ${c.manager_employee_id ? `<dt>المسؤول</dt><dd>${esc(W[c.manager_employee_id]?.full_name || '')}</dd>` : ''}${c.description ? `<dt>الوصف</dt><dd>${esc(c.description)}</dd>` : ''}</dl></div>
    ${c.is_template ? '' : `<div class="grid g4" style="margin-bottom:16px">${stat(c.project_type === 'customer' ? 'الإيرادات / العقد' : 'الإيرادات', money(r.revenue), c.contract_value ? `من عقد <span class="num">${money(c.contract_value)}</span>` : '')}${stat('التكلفة الفعلية', money(cost), `مخطط <span class="num">${money(plannedMat + plannedLab + (c.budget_other || 0))}</span>`)}
      ${stat('الربح', money(profit), r.revenue ? `هامش ${(profit / r.revenue * 100).toFixed(1)}%` : '', profit < 0 ? 'down' : '')}${stat('الإنجاز', pct + '%', `${done} من ${tasks.length} مهمة`)}</div>`}
    <div class="tabs">${TABS.map(([k, t]) => `<a href="#/projects/${esc(id)}?tab=${k}" class="${k === tab ? 'on' : ''}">${t}</a>`).join('')}</div><div id="ptab"></div>`;
  const ctx = { c, id, tasks, mats, stk, sheets, workers, W, I, used, onHand, matIds, hrsBy, avgRate, items, d, r, cost, plannedMat, actualMat, plannedLab, postedA, logA, logH, estH, otherActual, ed, today, ccs, ps };
  ({ overview: projOverview, tasks: projTasks, materials: projMaterials, labor: projLabor, docs: projDocs }[tab] || projOverview)(ctx);
  if ($('#pedit')) $('#pedit').onclick = () => editProjectDrawer(c, ps, items, workers);
  if ($('#pcopy')) $('#pcopy').onclick = () => drawer(c.is_template ? 'مشروع جديد من القالب' : 'نسخ المشروع', `<p class="muted">يُنسخ: المهام (بعمّالها وساعاتها المقدرة ومراحلها)، المواد المخططة، الميزانية والمواصفات. لا تُنسخ التكاليف والساعات المسجلة والمستندات.</p>
      <div class="form-grid">${field('code', 'رمز المشروع الجديد', { req: true, value: nextCode(ccs, 'P'), attrs: 'dir="ltr"' })}${field('name', 'الاسم', { req: true, value: c.name.replace(/^قالب:\s*/, '') + ' — ' })}
        ${select('party_id', 'العميل', [['', '— بدون —'], ...ps.map(p => [p.id, p.name])], c.is_template ? '' : c.party_id || '')}${field('start_date', 'تاريخ البداية', { type: 'date', value: today, help: 'تُزاح تواريخ المهام تلقائياً' })}</div>`,
    async v => { const nid = await api.copyProject(c.id, v.code, v.name, v.party_id, v.start_date, false); toast('أُنشئ المشروع'); location.hash = '#/projects/' + nid; }, 'إنشاء');
  if ($('#ptpl')) $('#ptpl').onclick = () => drawer('حفظ كقالب', `<p class="muted">يُحفظ هذا المشروع كقالب (مثل «كرفان 8 متر»): المهام والمواد والساعات المقدرة — بدون عميل وتواريخ وتكاليف. ابدأ منه أي مشروع جديد لاحقاً.</p>
      ${field('code', 'رمز القالب', { req: true, value: nextCode(ccs, 'TPL'), attrs: 'dir="ltr"' })}${field('name', 'اسم القالب', { req: true, value: 'قالب: ' + c.name.split(' — ')[0] })}`,
    async v => { const nid = await api.copyProject(c.id, v.code, v.name, null, null, true); toast('حُفظ القالب'); location.hash = '#/projects/' + nid; }, 'حفظ');
}

// ---------- tab: overview ----------
function projOverview(x) {
  const { c, plannedMat, actualMat, plannedLab, postedA, logA, otherActual, tasks, today, estH, logH, r, cost } = x;
  const row = (t, p, a, note = '') => { const over = p && a > p; return `<tr><td>${t}${note ? `<div class="xs muted">${note}</div>` : ''}</td><td class="amt num">${p ? money(p) : '—'}</td><td class="amt num ${over ? 'down' : ''}">${money(a)}</td>
    <td class="amt num ${over ? 'down' : ''}">${p ? money(p - a) : '—'}</td><td class="m-hide">${p ? `<div class="bar"><i style="width:${Math.min(100, a / p * 100).toFixed(0)}%;${over ? 'background:var(--c-danger)' : ''}"></i></div>` : ''}</td></tr>`; };
  const P = plannedMat + plannedLab + (c.budget_other || 0), A = actualMat + postedA + otherActual;
  const next = tasks.filter(t => t.status !== 'done').sort((a, b) => String(a.due_date || '9').localeCompare(String(b.due_date || '9'))).slice(0, 5);
  $('#ptab').innerHTML = `${c.is_template ? '<p class="note" style="margin-bottom:16px">هذا قالب: عدّل المهام والمواد هنا، ثم اضغط «مشروع من هذا القالب» لكل مشروع جديد.</p>' : ''}
    <div class="grid" style="gap:16px"><section class="card"><h3 style="margin-bottom:8px">المخطط مقابل الفعلي</h3><div class="tbl-wrap"><table class="rep-tbl"><thead><tr><th>البند</th><th class="amt">المخطط</th><th class="amt">الفعلي</th><th class="amt">المتبقي</th><th class="m-hide"></th></tr></thead><tbody>
      ${row('المواد', plannedMat, actualMat, 'المخطط × متوسط التكلفة · الفعلي = المصروف − المرتجع')}${row('العمالة', plannedLab, postedA, logA > postedA ? `ساعات غير مرحّلة بقيمة ${money(logA - postedA)}` : `${fq(logH)} ساعة من ${fq(estH)} مقدّرة`)}
      ${row('مصاريف ومشتريات أخرى', c.budget_other || 0, otherActual)}<tr class="grand"><td>الإجمالي</td><td class="amt num">${money(P)}</td><td class="amt num">${money(A)}</td><td class="amt num">${P ? money(P - A) : '—'}</td><td class="m-hide"></td></tr></tbody></table></div>
      ${!c.is_template && c.contract_value ? `<p style="margin-top:12px">الربح المتوقع حسب الخطة: <b class="num">${money(c.contract_value - P)}</b> · الحالي: <b class="num ${r.revenue - cost < 0 ? 'down' : ''}">${money(r.revenue - cost)}</b></p>
        <div class="row" style="justify-content:space-between;margin-top:8px"><span class="xs muted">الفوترة من العقد</span><b class="num xs">${(r.revenue / c.contract_value * 100).toFixed(0)}%</b></div><div class="bar" style="height:8px"><i style="width:${Math.min(100, r.revenue / c.contract_value * 100).toFixed(0)}%"></i></div>` : ''}</section>
      <section class="card"><div class="row" style="justify-content:space-between"><h3 style="margin:0">المهام القادمة</h3><a class="xs" href="#/projects/${esc(c.id)}?tab=tasks">كل المهام ←</a></div>
        ${next.length ? `<div class="tbl-wrap" style="margin-top:8px"><table><tbody>${next.map(t => `<tr><td>${esc(t.title)}<div class="xs muted">${esc((t.employee_ids || []).map(e => x.W[e]?.full_name).filter(Boolean).join('، ') || 'بدون عامل')}</div></td>
          <td class="num xs ${t.due_date && t.due_date < today ? 'down' : 'muted'}">${esc(t.due_date || '')}</td><td>${badge(t.status === 'doing' ? ['قيد التنفيذ', 'b-warn'] : ['للتنفيذ', 'b-draft'])}</td></tr>`).join('')}</tbody></table></div>` : `<p class="muted" style="margin-top:8px">${tasks.length ? 'كل المهام منجزة ✓' : 'لا توجد مهام بعد.'}</p>`}
        ${!c.is_template ? `<div class="row" style="gap:6px;flex-wrap:wrap;margin-top:12px">${hoursEditable() ? `<a class="btn secondary sm" href="#/projects/${esc(c.id)}?tab=labor">تسجيل ساعات</a>` : ''}${can('inventory', 'create') ? `<a class="btn secondary sm" href="#/projects/${esc(c.id)}?tab=materials">صرف مواد</a>` : ''}
          ${c.project_type === 'production' && can('manufacturing', 'create') ? `<a class="btn secondary sm" href="#/mfg/new?cc=${esc(c.id)}&item=${esc(c.product_item_id || '')}&qty=${esc(c.production_qty || 1)}">أمر تصنيع</a>` : ''}</div>` : ''}</section></div>`;
}

// ---------- tab: tasks (phases, workers, timeline) ----------
function projTasks(x) {
  const { c, tasks, workers, W, hrsBy, today } = x, canEdit = can_any_write();
  const dates = tasks.flatMap(t => [t.start_date, t.due_date]).filter(Boolean).concat([c.start_date, c.due_date].filter(Boolean)).sort();
  const t0 = dates[0], t1 = dates.at(-1), span = t0 && t1 ? Math.max(1, dayDiff(t0, t1) + 1) : 0;
  const ST = { todo: ['للتنفيذ', 'b-draft'], doing: ['قيد التنفيذ', 'b-warn'], done: ['منجزة', 'b-ok'] };
  const phases = [...new Set(tasks.map(t => t.phase || ''))];
  const bar = t => { if (!span || !(t.start_date || t.due_date)) return ''; const s = t.start_date || t.due_date, e = t.due_date || t.start_date, l = dayDiff(t0, s) / span * 100, w = Math.max(2, (dayDiff(s, e) + 1) / span * 100);
    return `<div class="gantt"><i class="${t.status}${t.status !== 'done' && t.due_date && t.due_date < today ? ' late' : ''}" style="margin-inline-start:${l.toFixed(1)}%;width:${w.toFixed(1)}%" title="${esc(s)} ← ${esc(e)}"></i>${today >= t0 && today <= t1 ? `<b class="now" style="inset-inline-start:${(dayDiff(t0, today) / span * 100).toFixed(1)}%"></b>` : ''}</div>`; };
  $('#ptab').innerHTML = `<div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:12px"><span class="muted">${span ? `من <span class="num">${t0}</span> إلى <span class="num">${t1}</span>` : 'أضف تواريخ للمهام لترى الجدول الزمني'}</span>
      ${canEdit ? `<span class="row" style="gap:6px">${!tasks.length ? '<button class="btn secondary" id="tstd">مراحل الكرفان القياسية</button>' : ''}<button class="btn primary" id="tadd">${icon('plus')}مهمة</button></span>` : ''}</div>
    ${tasks.length ? `<div class="tbl-wrap"><table class="list-tbl ptasks"><thead><tr><th>المهمة</th><th class="m-hide">العمّال</th><th class="amt">الساعات</th><th>الحالة</th><th class="m-hide" style="min-width:220px">الجدول الزمني</th></tr></thead><tbody>
      ${phases.map(ph => `${phases.length > 1 || ph ? `<tr class="sec"><td colspan="5">${esc(ph || 'بدون مرحلة')}</td></tr>` : ''}${tasks.filter(t => (t.phase || '') === ph).map(t => { const h = hrsBy[t.id] || { h: 0 }, over = t.est_hours && h.h > t.est_hours;
        return `<tr class="click" data-t="${esc(t.id)}"><td style="white-space:normal">${canEdit ? `<input type="checkbox" data-done="${esc(t.id)}" ${t.status === 'done' ? 'checked' : ''} aria-label="منجزة" style="margin-inline-end:6px">` : ''}<b>${esc(t.title)}</b>${t.priority === 'high' ? ' ' + badge(['عاجل', 'b-bad']) : ''}
          <div class="xs muted num">${esc(t.start_date || '')}${t.due_date ? ' ← ' + esc(t.due_date) : ''}</div></td><td class="m-hide">${(t.employee_ids || []).map(e => `<span class="chip">${esc(W[e]?.full_name || '؟')}</span>`).join(' ') || '<span class="xs muted">—</span>'}</td>
          <td class="amt num ${over ? 'down' : ''}">${fq(h.h)}${t.est_hours ? ` / ${fq(t.est_hours)}` : ''}</td><td>${badge(ST[t.status])}</td><td class="m-hide">${bar(t)}</td></tr>`; }).join('')}`).join('')}</tbody></table></div>`
    : empty('file', 'لا توجد مهام', 'قسّم المشروع إلى مهام بمراحل وعمّال وساعات مقدّرة — أو ابدأ بمراحل الكرفان القياسية وعدّلها.')}`;
  const open = t => { t = t || { status: 'todo', priority: 'normal', employee_ids: [], start_date: c.start_date || '', sort: tasks.length + 1 };
    const fd = drawer(t.id ? 'تعديل مهمة' : 'مهمة جديدة', `${field('title', 'المهمة', { req: true, value: t.title || '' })}
      <div class="field"><label for="f-phase">المرحلة</label><input class="input" id="f-phase" name="phase" list="phlist" value="${esc(t.phase || '')}"><datalist id="phlist">${[...new Set([...PHASES, ...phases.filter(Boolean)])].map(p => `<option value="${esc(p)}">`).join('')}</datalist></div>
      <fieldset><legend>العمّال المكلّفون</legend><div class="wpick" id="wpick">${workers.length ? workers.map(w => wpickRow(w, (t.employee_ids || []).includes(w.id))).join('') : '<p class="muted xs" id="wnone">لا يوجد عمال بعد — أضف أول عامل من الزر أدناه، أو من صفحة «الموظفون».</p>'}</div>
        ${can('hr', 'create') ? `<button type="button" class="btn ghost sm" id="wnewb" style="margin-top:8px">${icon('plus')}عامل جديد</button>
        <div id="wnew" hidden class="card" style="margin-top:8px;padding:12px"><div class="form-grid">${field('wn_name', 'اسم العامل', {})}${field('wn_job', 'المهنة', { help: 'لحام، دهان، كهربائي…' })}
          ${select('wn_type', 'النوع', [['daily', 'عامل يومية'], ['hourly', 'عامل بالساعة'], ['monthly', 'موظف شهري']], 'daily')}${select('wn_saudi', 'الجنسية', [['0', 'غير سعودي'], ['1', 'سعودي']], '0')}
          ${field('wn_day', 'الأجر اليومي (ر.س)', { type: 'money' })}${field('wn_rate', 'أجر الساعة (ر.س)', { type: 'money' })}${field('wn_sal', 'الراتب الشهري (ر.س)', { type: 'money' })}</div>
          <div class="row" style="gap:6px;margin-top:8px"><button type="button" class="btn secondary sm" id="wnadd">إضافة العامل</button><span class="xs muted">يُضاف لقائمة الموظفين، وتكمل بياناته (الإقامة، الآيبان…) لاحقاً.</span></div><p class="help err" id="wnerr"></p></div>` : ''}</fieldset>
      <div class="form-grid">${field('start_date', 'البداية', { type: 'date', value: t.start_date || '' })}${field('due_date', 'الاستحقاق', { type: 'date', value: t.due_date || '' })}
        ${field('est_hours', 'الساعات المقدّرة', { value: t.est_hours ? fq(t.est_hours) : '', attrs: 'inputmode="decimal"' })}${select('priority', 'الأولوية', [['low', 'منخفضة'], ['normal', 'عادية'], ['high', 'عاجلة']], t.priority)}
        ${select('status', 'الحالة', Object.entries(ST).map(([k, v]) => [k, v[0]]), t.status)}</div>${field('notes', 'التفاصيل', { value: t.notes || '' })}
      ${t.id ? '<button type="button" class="btn ghost" id="tdel" style="color:var(--c-danger)">حذف المهمة</button>' : ''}`,
      async v => { if (!v.title?.trim()) throw new AppError('اكتب المهمة'); if (v.start_date && v.due_date && v.due_date < v.start_date) throw new AppError('تاريخ الاستحقاق قبل البداية');
        const eh = v.est_hours ? num(v.est_hours) : null; if (eh != null && !(eh >= 0)) throw new AppError('الساعات غير صحيحة');
        await api.saveTask({ ...(t.id ? { id: t.id } : {}), cost_center_id: c.id, title: v.title.trim(), phase: v.phase?.trim() || null, employee_ids: workers.filter(w => v['w_' + w.id]).map(w => w.id), start_date: v.start_date || null, due_date: v.due_date || null,
          est_hours: eh, priority: v.priority, status: v.status, notes: v.notes || null, sort: t.sort ?? tasks.length + 1 });
        toast('حُفظت المهمة'); projectView(c.id, new URLSearchParams('tab=tasks')); });
    if ($('#wnewb', fd)) $('#wnewb', fd).onclick = () => { $('#wnew', fd).hidden = !$('#wnew', fd).hidden; $('#f-wn_name', fd).focus(); };
    const wnt = () => { if (!$('#f-wn_type', fd)) return; const t = $('#f-wn_type', fd).value; [['wn_day', 'daily'], ['wn_rate', 'hourly'], ['wn_sal', 'monthly']].forEach(([k, v]) => $('#f-' + k, fd).closest('.field').hidden = t !== v); };
    if ($('#f-wn_type', fd)) { $('#f-wn_type', fd).onchange = wnt; wnt(); }
    if ($('#wnadd', fd)) $('#wnadd', fd).onclick = async e => { const err = $('#wnerr', fd); err.textContent = ''; const name = $('#f-wn_name', fd).value.trim();
      const typ = $('#f-wn_type', fd).value, amt = k => $('#f-' + k, fd).value ? toHalalas($('#f-' + k, fd).value) : null;
      const day = typ === 'daily' ? amt('wn_day') : null, rate = typ === 'hourly' ? amt('wn_rate') : null, sal = typ === 'monthly' ? amt('wn_sal') : null;
      if (!name) return err.textContent = 'اكتب اسم العامل';
      const need = { daily: [day, 'الأجر اليومي'], hourly: [rate, 'أجر الساعة'], monthly: [sal, 'الراتب الشهري'] }[typ]; if (!(need[0] > 0)) return err.textContent = 'اكتب ' + need[1];
      e.target.disabled = true;
      try { const emp = await api.saveEmployee({ full_name: name, job_title: $('#f-wn_job', fd).value.trim() || null, is_saudi: $('#f-wn_saudi', fd).value === '1', hire_date: riyadhToday(), status: 'active',
          employment_type: typ, daily_rate: day, basic_salary: sal || 0, housing_allowance: 0, transport_allowance: 0, other_allowances: {}, gosi_enrolled: typ === 'monthly' && $('#f-wn_saudi', fd).value === '1', hourly_rate: rate });
        const w = { id: emp.id, full_name: emp.full_name, job_title: emp.job_title, employment_type: typ, daily_rate: day, hour_rate: rate ?? (day ? Math.round(day / 8) : Math.round((sal || 0) / 240)), rate_manual: rate != null };
        workers.push(w); $('#wnone', fd)?.remove(); $('#wpick', fd).insertAdjacentHTML('beforeend', wpickRow(w, true));
        ['wn_name', 'wn_job', 'wn_sal', 'wn_rate'].forEach(k => $('#f-' + k, fd).value = ''); $('#wnew', fd).hidden = true; toast('أُضيف العامل: ' + name); }
      catch (z) { err.textContent = z.message; } finally { e.target.disabled = false; } };
    if ($('#tdel', fd)) $('#tdel', fd).onclick = async e => { if (!confirmBtn(e.target)) return; try { await api.deleteTask(t.id); fd.closest('.drawer-bg').remove(); projectView(c.id, new URLSearchParams('tab=tasks')); } catch (z) { fail(z); } }; };
  if ($('#tadd')) $('#tadd').onclick = () => open(null);
  if ($('#tstd')) $('#tstd').onclick = async e => { e.target.disabled = true; let d = c.start_date || today; const step = n => { const z = new Date(d + 'T00:00:00'); z.setDate(z.getDate() + n); return ymd(z); };
    const plan = [[PHASES[0], 'اعتماد التصميم والمقاسات مع العميل', 8, 2], [PHASES[1], 'قص الحديد والألواح', 16, 2], [PHASES[2], 'لحام الشاسيه والهيكل', 40, 5], [PHASES[3], 'تمديدات الكهرباء والسباكة', 24, 3], [PHASES[4], 'تركيب العزل والألواح', 16, 2], [PHASES[5], 'الدهان', 16, 2], [PHASES[6], 'التجهيز الداخلي والأثاث', 32, 4], [PHASES[7], 'الفحص النهائي والتسليم', 6, 1]];
    try { let i = 0; for (const [ph, title, h, days] of plan) { const s = d, e2 = step(days - 1); await api.saveTask({ cost_center_id: c.id, title, phase: ph, est_hours: h, start_date: c.is_template ? null : s, due_date: c.is_template ? null : e2, status: 'todo', priority: 'normal', sort: ++i, employee_ids: [] }); d = step(days); }
      toast('أُضيفت 8 مراحل — عدّلها وكلّف العمال'); projectView(c.id, new URLSearchParams('tab=tasks')); } catch (z) { fail(z); e.target.disabled = false; } };
  $$('#ptab tr[data-t]').forEach(tr => tr.onclick = e => { if (e.target.closest('[data-done]')) return; if (canEdit) open(tasks.find(t => t.id === tr.dataset.t)); });
  $$('#ptab [data-done]').forEach(cb => cb.onchange = async () => { try { await api.saveTask({ id: cb.dataset.done, status: cb.checked ? 'done' : 'todo' }); projectView(c.id, new URLSearchParams('tab=tasks')); } catch (z) { fail(z); cb.checked = !cb.checked; } });
}

// ---------- tab: materials (plan, issue, return, buy) ----------
async function projMaterials(x) {
  const { c, mats, used, onHand, I, items, stk, ed } = x;
  const stockItems = items.filter(i => i.track_stock), M = Object.fromEntries(mats.map(m => [m.item_id, m]));
  const ids = [...new Set([...mats.map(m => m.item_id), ...Object.keys(used)])];
  const canIssue = can('inventory', 'create') && !c.is_template;
  $('#ptab').innerHTML = `<div class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:12px">${ed || (c.is_template && projEditable()) ? `<button class="btn secondary" id="madd">${icon('plus')}مادة للخطة</button><button class="btn secondary" id="mbom">من قائمة المواد</button>` : ''}
      ${canIssue ? `<button class="btn primary" id="miss">صرف مواد للمشروع</button>${Object.values(used).some(u => u.qty > 0) ? '<button class="btn secondary" id="mret">إرجاع الفائض</button>' : ''}` : ''}
      ${can('purchases', 'create') && !c.is_template ? '<button class="btn secondary" id="mbuy">شراء للمشروع</button>' : ''}</div>
    ${ids.length ? `<div class="tbl-wrap"><table class="rep-tbl"><thead><tr><th>المادة</th><th class="amt">المخطط</th><th class="amt">المصروف (صافي)</th><th class="amt">المتبقي للصرف</th><th class="amt m-hide">المتوفر بالمخزون</th><th class="amt m-hide">التكلفة الفعلية</th>${ed ? '<th></th>' : ''}</tr></thead><tbody>
      ${ids.map(it => { const m = M[it], u = used[it] || { qty: 0, cost: 0 }, rem = m ? m.planned_qty - u.qty : 0, i = I[it] || {}, short = rem > 0 && (onHand[it] || 0) < rem;
        return `<tr><td>${esc(i.name_ar || '')} <span class="xs muted">${esc(i.unit || '')}</span></td><td class="amt num">${m ? fq(m.planned_qty) : '—'}</td><td class="amt num ${m && u.qty > m.planned_qty ? 'down' : ''}">${fq(u.qty)}${m && u.qty > m.planned_qty ? ' ⚠' : ''}</td>
          <td class="amt num">${rem > 0 ? fq(rem) : '—'}</td><td class="amt num m-hide ${short ? 'down' : ''}">${fq(onHand[it] || 0)}${short ? ' — ناقص' : ''}</td><td class="amt num m-hide">${money(u.cost)}</td>
          ${ed ? `<td>${m ? `<button class="btn ghost sm" data-me="${esc(m.id)}">تعديل</button>` : ''}</td>` : ''}</tr>`; }).join('')}
      <tr class="grand"><td colspan="5">إجمالي تكلفة المواد</td><td class="amt num">${money(Object.values(used).reduce((s, u) => s + u.cost, 0))}</td>${ed ? '<td></td>' : ''}</tr></tbody></table></div>
      <p class="xs muted" style="margin-top:6px">الأحمر: صُرف أكثر من المخطط، أو المتوفر في المخزون أقل من المتبقي — اشترِ الناقص من «شراء للمشروع».</p>`
    : empty('box', 'لا توجد مواد', 'أضف المواد المخططة للمشروع (أو احسبها من قائمة المواد)، ثم اصرفها من المستودع — تُحمَّل تكلفتها على المشروع تلقائياً.')}
    ${stk.length ? `<h3 style="margin:20px 0 8px">حركات الصرف والإرجاع</h3><div class="tbl-wrap"><table><tbody>${stk.map(s => `<tr><td><a href="#/stock/${esc(s.id)}"><span class="num">${esc(s.number || 'مسودة')}</span></a> ${s.kind === 'issue' ? 'صرف' : 'إرجاع'}</td><td class="num">${esc(s.doc_date)}</td><td class="amt num">${money(s.stock_doc_lines.reduce((a, l) => a + l.qty * l.unit_cost, 0))}</td><td>${badge(s.status === 'posted' ? ['مرحّل', 'b-ok'] : ['مسودة', 'b-draft'])}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  const planDrawer = m => drawer(m ? 'تعديل مادة مخططة' : 'مادة للخطة', `${m ? `<p><b>${esc(I[m.item_id]?.name_ar || '')}</b></p>` : `<div class="field"><label for="f-item_id">المادة</label><select class="input" id="f-item_id" name="item_id">${optList(stockItems.map(i => [i.id, `${i.name_ar}${i.sku ? ' · ' + i.sku : ''}`]), '', '— اختر —')}</select></div>`}
      ${field('planned_qty', 'الكمية المخططة', { req: true, value: m ? fq(m.planned_qty) : '', attrs: 'inputmode="decimal"' })}${field('note', 'ملاحظة', { value: m?.note || '' })}${m ? '<button type="button" class="btn ghost" id="mdel" style="color:var(--c-danger)">حذف من الخطة</button>' : ''}`,
    async v => { const q = num(v.planned_qty); if (!(q > 0)) throw new AppError('أدخل الكمية'); const it = m?.item_id || v.item_id; if (!it) throw new AppError('اختر المادة');
      await api.saveProjectMaterial({ cost_center_id: c.id, item_id: it, planned_qty: q, note: v.note || null }); toast('حُفظ'); projectView(c.id, new URLSearchParams('tab=materials')); });
  if ($('#madd')) $('#madd').onclick = () => planDrawer(null);
  $$('[data-me]').forEach(b => b.onclick = () => { const m = mats.find(z => z.id === b.dataset.me); const f = planDrawer(m); $('#mdel')?.addEventListener('click', async e => { if (!confirmBtn(e.target)) return; await api.deleteProjectMaterial(m.id); document.querySelector('.drawer-bg')?.remove(); projectView(c.id, new URLSearchParams('tab=materials')); }); });
  if ($('#mbom')) $('#mbom').onclick = async () => { const boms = await api.listBoms(); if (!boms.length) return toast('لا توجد قوائم مواد — أنشئها من «قوائم المواد»', 'warn');
    drawer('إضافة المواد من قائمة مواد', `${select('bom', 'قائمة المواد (المنتج)', boms.map(b => [b.id, I[b.item_id]?.name_ar || '']), boms.find(b => b.item_id === c.product_item_id)?.id || boms[0].id)}
      ${field('qty', 'عدد الوحدات', { value: c.production_qty ? fq(c.production_qty) : '1', attrs: 'inputmode="decimal"' })}<p class="xs muted">تُضاف كميات المكونات (مع نسب الهدر) للخطة؛ المادة الموجودة تُستبدل كميتها.</p>`,
      async v => { const b = boms.find(z => z.id === v.bom), q = num(v.qty); if (!(q > 0)) throw new AppError('أدخل العدد');
        for (const l of b.bom_lines) await api.saveProjectMaterial({ cost_center_id: c.id, item_id: l.item_id, planned_qty: Math.round(l.qty * (1 + (l.waste_pct || 0) / 100) * q / (b.output_qty || 1) * 10000) / 10000 });
        toast(`أُضيفت ${b.bom_lines.length} مادة`); projectView(c.id, new URLSearchParams('tab=materials')); }, 'إضافة'); };
  const moveDrawer = async kind => { const whs = (await api.listWarehouses()).filter(w => w.kind !== 'van');
    const base = kind === 'issue' ? ids.map(it => ({ item_id: it, qty: Math.max(0, (M[it]?.planned_qty || 0) - (used[it]?.qty || 0)) })).filter(l => l.qty > 0) : ids.map(it => ({ item_id: it, qty: Math.max(0, used[it]?.qty || 0) })).filter(l => l.qty > 0);
    let lines = base.length ? base : [{ item_id: '', qty: '' }];
    const f = drawer(kind === 'issue' ? 'صرف مواد للمشروع' : 'إرجاع الفائض للمستودع', `${select('wh', kind === 'issue' ? 'من مستودع' : 'إلى مستودع', whs.map(w => [w.id, w.name]), whs[0]?.id)}${field('date', 'التاريخ', { type: 'date', value: riyadhToday() })}
      <p class="xs muted">${kind === 'issue' ? 'معبّأة بالمتبقي من الخطة — عدّل الكميات أو احذف ما لا تريد صرفه.' : 'معبّأة بكل ما صُرف — اترك فقط ما رجع فعلاً.'}</p><div id="mvl"></div>${kind === 'issue' ? `<button type="button" class="btn ghost sm" id="mvadd">${icon('plus')}مادة</button>` : ''}`,
      async v => { const real = lines.filter(l => l.item_id && Number(l.qty) > 0); if (!real.length) throw new AppError('أدخل كمية واحدة على الأقل');
        const sid = await api.saveStockDoc({ kind, doc_date: v.date, from_warehouse_id: kind === 'issue' ? v.wh : null, to_warehouse_id: kind === 'issue' ? null : v.wh, cost_center_id: c.id, note: (kind === 'issue' ? 'صرف لمشروع ' : 'إرجاع من مشروع ') + c.name }, real.map(l => ({ item_id: l.item_id, qty: Number(l.qty) })));
        if (can('inventory', 'post')) { await api.postStockDoc(sid); toast(kind === 'issue' ? 'صُرفت المواد وحُمّلت على المشروع' : 'أُرجع الفائض للمستودع'); } else toast('حُفظت كمسودة — تحتاج اعتماد المخزون');
        projectView(c.id, new URLSearchParams('tab=materials')); }, kind === 'issue' ? 'صرف' : 'إرجاع');
    const draw = () => { $('#mvl', f).innerHTML = lines.map((l, i) => `<div class="row" style="gap:8px;margin-bottom:8px" data-i="${i}"><select class="input" data-k="item_id" style="flex:2" aria-label="المادة">${optList((kind === 'issue' ? stockItems : stockItems.filter(s => used[s.id]?.qty > 0)).map(s => [s.id, `${s.name_ar} (${kind === 'issue' ? 'متوفر ' + fq(onHand[s.id] || 0) : 'صُرف ' + fq(used[s.id]?.qty || 0)})`]), l.item_id, '— اختر —')}</select>
      <input class="input num" data-k="qty" inputmode="decimal" value="${esc(l.qty === '' ? '' : fq(l.qty))}" style="flex:1" aria-label="الكمية"><button type="button" class="btn ghost icon sm" data-x aria-label="حذف">${icon('trash')}</button></div>`).join(''); };
    $('#mvl', f).addEventListener('input', e => { const r = e.target.closest('[data-i]'); if (r && e.target.dataset.k === 'qty') lines[r.dataset.i].qty = num(e.target.value); });
    $('#mvl', f).addEventListener('change', e => { const r = e.target.closest('[data-i]'); if (r && e.target.dataset.k === 'item_id') lines[r.dataset.i].item_id = e.target.value; });
    $('#mvl', f).addEventListener('click', e => { if (e.target.closest('[data-x]')) { lines.splice(e.target.closest('[data-i]').dataset.i, 1); if (!lines.length) lines.push({ item_id: '', qty: '' }); draw(); } });
    if ($('#mvadd', f)) $('#mvadd', f).onclick = () => { lines.push({ item_id: '', qty: '' }); draw(); }; draw(); };
  if ($('#miss')) $('#miss').onclick = () => moveDrawer('issue');
  if ($('#mret')) $('#mret').onclick = () => moveDrawer('issue_return');
  if ($('#mbuy')) $('#mbuy').onclick = () => { const need = ids.map(it => { const rem = (M[it]?.planned_qty || 0) - (used[it]?.qty || 0) - (onHand[it] || 0); return rem > 0 ? `${I[it]?.name_ar}: ${fq(rem)}` : null; }).filter(Boolean);
    sessionStorage.setItem('doc-prefill', JSON.stringify({ cc: c.id, note: 'مشتريات لمشروع ' + c.name + (need.length ? ' — الناقص: ' + need.join('، ') : '') })); location.hash = '#/bills/new'; };
}

// ---------- tab: labor & hours ----------
function projLabor(x) {
  const { c, tasks, workers, W, sheets, today } = x, canLog = hoursEditable() && !c.is_template, canPost = (can('accounting', 'post') || can('manufacturing', 'post')) && !c.is_template;
  const assigned = new Set(tasks.flatMap(t => t.employee_ids || [])), team = [...workers.filter(w => assigned.has(w.id)), ...workers.filter(w => !assigned.has(w.id))];
  const by = {}; sheets.forEach(s => { const z = (by[s.employee_id] ||= { h: 0, a: 0 }); z.h += s.hours; z.a += s.amount; });
  const draft = sheets.filter(s => s.status === 'draft'), T = Object.fromEntries(tasks.map(t => [t.id, t.title]));
  $('#ptab').innerHTML = `${canLog ? `<section class="card" style="margin-bottom:16px"><h3 style="margin-bottom:8px">تسجيل ساعات اليوم</h3>${team.length ? `<form id="tsf" novalidate>
      <div class="form-grid" style="margin-bottom:8px">${field('work_date', 'التاريخ', { type: 'date', value: today })}<div class="field"><label for="f-task_id">المهمة</label><select class="input" id="f-task_id" name="task_id">${optList(tasks.filter(t => t.status !== 'done').map(t => [t.id, t.title]), '', '— عام للمشروع —')}</select></div></div>
      <div class="tbl-wrap editor"><table><thead><tr><th>العامل</th><th style="width:110px">الساعات</th><th style="width:150px">تكلفة الساعة</th><th class="amt">القيمة</th></tr></thead><tbody>
        ${team.map(w => `<tr data-w="${esc(w.id)}" data-r="${w.hour_rate ?? ''}"><td>${esc(w.full_name)}${assigned.has(w.id) ? ' <span class="chip">في المشروع</span>' : ''}${WTYPE[w.employment_type] ? ` <span class="chip">${WTYPE[w.employment_type]}</span>` : ''}<div class="xs muted">${esc(w.job_title || '')}${w.employment_type === 'daily' && w.daily_rate ? ` · ${money(w.daily_rate)}/يوم — 8 ساعات = يوم` : ''}</div></td>
          <td><input class="input num" data-k="h" inputmode="decimal" placeholder="0" aria-label="ساعات ${esc(w.full_name)}"></td>
          <td><input class="input num" data-k="r" inputmode="decimal" placeholder="${w.hour_rate != null ? money(w.hour_rate) + (w.rate_manual ? '' : ' تلقائي') : 'تلقائي'}" aria-label="تكلفة الساعة"><div class="xs muted">اتركها فارغة للتكلفة ${w.rate_manual ? 'المحددة' : 'التلقائية'}</div></td><td class="amt num" data-k="a">—</td></tr>`).join('')}</tbody></table></div>
      <div class="row" style="justify-content:space-between;margin-top:8px;flex-wrap:wrap;gap:8px"><span class="muted" id="tstot"></span><button class="btn primary" type="submit">حفظ الساعات</button></div></form>`
      : '<p class="muted">أضف الموظفين والعمال من «الموظفون» أولاً.</p>'}</section>` : ''}
    <div class="grid g2" style="align-items:start"><section class="card"><h3 style="margin-bottom:8px">حسب العامل</h3>${Object.keys(by).length ? `<div class="tbl-wrap"><table><thead><tr><th>العامل</th><th class="amt">الساعات</th><th class="amt">التكلفة</th></tr></thead><tbody>
        ${Object.entries(by).sort((a, b) => b[1].h - a[1].h).map(([e, z]) => `<tr><td>${esc(W[e]?.full_name || '')}</td><td class="amt num">${fq(z.h)}</td><td class="amt num">${money(z.a)}</td></tr>`).join('')}
        <tr class="grand"><td>الإجمالي</td><td class="amt num">${fq(sheets.reduce((s, t) => s + t.hours, 0))}</td><td class="amt num">${money(sheets.reduce((s, t) => s + t.amount, 0))}</td></tr></tbody></table></div>` : '<p class="muted">لم تُسجَّل ساعات بعد.</p>'}
      ${draft.length && canPost ? `<div class="note" style="margin-top:12px">${draft.length} إدخال غير مرحّل بقيمة <b class="num">${money(draft.reduce((s, t) => s + t.amount, 0))}</b> — رحّلها لتظهر في تكلفة المشروع وأرباحه.<div style="margin-top:8px"><button class="btn primary sm" id="tspost">ترحيل تكلفة العمالة حتى اليوم</button></div></div>` : ''}
      <p class="xs muted" style="margin-top:8px">الترحيل ينقل تكلفة الساعات من الرواتب العامة إلى المشروع — لا يغيّر إجمالي رواتب الشركة.</p></section>
      <section class="card"><h3 style="margin-bottom:8px">آخر الإدخالات</h3>${sheets.length ? `<div class="tbl-wrap" style="max-height:420px;overflow:auto"><table><tbody>${sheets.slice(0, 100).map(s => `<tr><td class="num xs">${esc(s.work_date)}</td><td>${esc(W[s.employee_id]?.full_name || '')}<div class="xs muted">${esc(T[s.task_id] || 'عام')}${s.rate_manual ? ' · سعر يدوي' : ''}</div></td>
          <td class="amt num">${fq(s.hours)} س</td><td class="amt num">${money(s.amount)}</td><td>${s.status === 'posted' ? badge(['مرحّل', 'b-ok']) : canLog ? `<button class="btn ghost icon sm" data-tsdel="${esc(s.id)}" aria-label="حذف">${icon('trash')}</button>` : badge(['غير مرحّل', 'b-warn'])}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">—</p>'}</section></div>
    <div class="grid g2" style="align-items:start;margin-top:16px"><section class="card" id="casual"><h3 style="margin-bottom:8px">أجور العمالة باليومية والساعة</h3><p class="muted">جارٍ التحميل…</p></section>
      <section class="card"><div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:6px"><h3 style="margin:0">الورش الخارجية ومقاولو الباطن</h3>${can('purchases', 'create') && !c.is_template ? '<button class="btn secondary sm" id="subc">تسجيل أعمال ورشة خارجية</button>' : ''}</div>
        <p class="xs muted" style="margin:6px 0 8px">الورشة الخارجية تُسجَّل «مورداً»، وأعمالها فاتورة مشتريات على المشروع (بند خدمة)، وتُدفع بسند صرف.</p>
        ${(() => { const bills = x.d.docs.filter(z => z.kind === 'purchase_bill'); return bills.length ? `<div class="tbl-wrap"><table><tbody>${bills.map(z => `<tr><td><a href="#/bills/${esc(z.id)}"><span class="num">${esc(z.number || 'مسودة')}</span></a> ${esc(z.parties?.name || '')}</td><td class="num xs">${esc(z.issue_date)}</td><td class="amt num">${money(z.total)}</td><td>${badge(z.payment_status === 'paid' ? ['مدفوعة', 'b-ok'] : ['غير مدفوعة', 'b-warn'])}</td></tr>`).join('')}
          <tr class="grand"><td colspan="2">الإجمالي</td><td class="amt num">${money(bills.reduce((a, z) => a + Number(z.total), 0))}</td><td></td></tr></tbody></table></div>` : '<p class="muted">لا توجد فواتير موردين أو ورش على هذا المشروع بعد.</p>'; })()}</section></div>`;
  if ($('#subc')) $('#subc').onclick = () => { sessionStorage.setItem('doc-prefill', JSON.stringify({ cc: c.id, note: 'أعمال ورشة خارجية — ' + c.name })); location.hash = '#/bills/new'; };
  (async () => { const box = $('#casual'); if (!box) return; let bal = [];
    try { bal = await api.casualBalances(); } catch { box.innerHTML = '<h3>أجور العمالة باليومية والساعة</h3><p class="muted">لا تملك صلاحية عرضها.</p>'; return; }
    const here = new Set(sheets.map(t => t.employee_id)), rows = bal.filter(b => here.has(b.employee_id) || b.owed > 0), canPay = can('expenses', 'post') || can('accounting', 'post') || can('hr', 'post');
    box.innerHTML = `<h3 style="margin-bottom:8px">أجور العمالة باليومية والساعة</h3>${rows.length ? `<div class="tbl-wrap"><table><thead><tr><th>العامل</th><th class="amt">المستحق (كل المشاريع)</th><th class="amt">المصروف</th><th class="amt">الباقي</th><th></th></tr></thead><tbody>
      ${rows.map(b => `<tr><td>${esc(b.full_name)} <span class="chip">${WTYPE[b.employment_type]}</span></td><td class="amt num">${money(b.earned)}</td><td class="amt num">${money(b.paid)}</td><td class="amt num"><b class="${b.owed > 0 ? 'down' : ''}">${money(b.owed)}</b></td>
        <td>${b.owed > 0 && canPay ? `<button class="btn secondary sm" data-pay="${esc(b.employee_id)}">صرف</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
      <p class="xs muted" style="margin-top:6px">تُستحق الأجور عند «ترحيل تكلفة العمالة»، ثم تُصرف من الصندوق أو البنك.</p>` : '<p class="muted">لا يوجد عمال باليومية أو الساعة على هذا المشروع. أضفهم من «المهام ← عامل جديد» أو من «الموظفون».</p>'}`;
    $$('[data-pay]', box).forEach(btn => btn.onclick = async () => { const b = rows.find(r => r.employee_id === btn.dataset.pay), accs = (await api.listAccounts()).filter(a => a.is_postable && ['cash', 'bank'].includes(a.system_key));
      drawer('صرف أجور: ' + b.full_name, `<p>الباقي المستحق: <b class="num">${money(b.owed)}</b> ر.س</p>${field('amount', 'المبلغ', { type: 'money', req: true, value: money(b.owed) })}
        ${select('cash', 'يُصرف من', accs.map(a => [a.id, `${a.code} — ${a.name_ar}`]), accs[0]?.id)}${field('date', 'التاريخ', { type: 'date', value: riyadhToday() })}${field('memo', 'البيان', { value: 'أجور ' + b.full_name + ' — ' + c.name })}`,
        async v => { const a = toHalalas(v.amount); if (!(a > 0)) throw new AppError('أدخل المبلغ'); await api.payCasual(b.employee_id, a, v.cash, v.date, v.memo); toast('صُرفت الأجور'); projectView(c.id, new URLSearchParams('tab=labor')); }, 'صرف'); }); })();
  const recalc = () => { let th = 0, ta = 0; $$('#tsf tr[data-w]').forEach(tr => { const h = num($('[data-k=h]', tr).value || 0) || 0, rr = $('[data-k=r]', tr).value ? toHalalas($('[data-k=r]', tr).value) : (tr.dataset.r === '' ? null : Number(tr.dataset.r));
    $('[data-k=a]', tr).textContent = h && rr != null ? money(Math.round(h * rr)) : h ? 'تلقائي' : '—'; th += h; ta += h && rr != null ? Math.round(h * rr) : 0; });
    if ($('#tstot')) $('#tstot').textContent = th ? `${fq(th)} ساعة${ta ? ` · ${money(ta)} ر.س` : ''}` : ''; };
  if ($('#tsf')) { $('#tsf').addEventListener('input', recalc); $('#tsf').onsubmit = async e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)), rows = [];
    for (const tr of $$('#tsf tr[data-w]')) { const h = num($('[data-k=h]', tr).value || 0); if (!h) continue; if (!(h > 0 && h <= 24)) return toast('الساعات بين 0 و24', 'bad');
      const rv = $('[data-k=r]', tr).value, rate = rv ? toHalalas(rv) : null; if (rv && !(rate >= 0)) return toast('تكلفة ساعة غير صحيحة', 'bad');
      rows.push({ cost_center_id: c.id, task_id: f.task_id || null, employee_id: tr.dataset.w, work_date: f.work_date, hours: h, ...(rate != null ? { rate, rate_manual: true } : {}) }); }
    if (!rows.length) return toast('أدخل ساعات عامل واحد على الأقل', 'warn');
    $('[type=submit]', e.target).disabled = true; try { await api.addTimesheets(rows); toast(`سُجّلت ساعات ${rows.length} عامل`); projectView(c.id, new URLSearchParams('tab=labor')); } catch (z) { fail(z); $('[type=submit]', e.target).disabled = false; } }; }
  if ($('#tspost')) $('#tspost').onclick = async e => { e.target.disabled = true; try { const n = await api.postLabor(c.id, today); toast(`رُحّل ${n} إدخال على المشروع`); projectView(c.id, new URLSearchParams('tab=labor')); } catch (z) { fail(z); e.target.disabled = false; } };
  $$('[data-tsdel]').forEach(b => b.onclick = async () => { if (!confirmBtn(b, 'تأكيد؟')) return; try { await api.deleteTimesheet(b.dataset.tsdel); projectView(c.id, new URLSearchParams('tab=labor')); } catch (z) { fail(z); } });
}

// ---------- tab: documents ----------
function projDocs(x) {
  const { c, d } = x;
  const KIND = { tax_invoice: ['فاتورة', 'invoices'], simplified_invoice: ['فاتورة مبسطة', 'invoices'], credit_note: ['إشعار دائن', 'credit-notes'], quote: ['عرض سعر', 'quotes'], delivery_note: ['سند تسليم', 'delivery-notes'], purchase_bill: ['فاتورة مشتريات', 'bills'], purchase_order: ['أمر شراء', 'purchase-orders'], purchase_return: ['مرتجع مشتريات', 'purchase-returns'] };
  const go = (route, extra = {}) => { sessionStorage.setItem('doc-prefill', JSON.stringify({ cc: c.id, party: c.party_id || '', ...extra })); location.hash = route; };
  $('#ptab').innerHTML = c.is_template ? '<p class="muted">القوالب ليس لها مستندات.</p>' : `<div class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:12px">${can('sales', 'create') ? '<button class="btn secondary" data-go="#/quotes/new">عرض سعر</button><button class="btn secondary" data-go="#/invoices/new">فاتورة للعميل</button>' : ''}
      ${can('purchases', 'create') ? '<button class="btn secondary" data-go="#/bills/new" data-np="1">فاتورة مشتريات</button><button class="btn secondary" data-go="#/purchase-orders/new" data-np="1">أمر شراء</button>' : ''}
      ${can('manufacturing', 'create') ? `<a class="btn secondary" href="#/mfg/new?cc=${esc(c.id)}${c.product_item_id ? `&item=${esc(c.product_item_id)}&qty=${esc(c.production_qty || 1)}` : ''}">أمر تصنيع</a>` : ''}</div>
    <p class="xs muted" style="margin-bottom:12px">المستندات التي تُنشأ من هنا تُربط بالمشروع تلقائياً، وتدخل في تكلفته أو إيراده.</p>
    <div class="grid g2" style="align-items:start"><section class="card"><h3 style="margin-bottom:8px">المستندات</h3>${d.docs.length ? `<div class="tbl-wrap"><table><tbody>${d.docs.map(z => `<tr><td><a href="#/${KIND[z.kind]?.[1] || 'invoices'}/${esc(z.id)}">${esc(KIND[z.kind]?.[0] || z.kind)} <span class="num">${esc(z.number || 'مسودة')}</span></a><div class="xs muted">${esc(z.parties?.name || '')}</div></td><td class="num xs">${esc(z.issue_date)}</td><td class="amt num">${money(z.total)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">لا توجد.</p>'}</section>
      <div class="grid" style="gap:16px"><section class="card"><h3 style="margin-bottom:8px">أوامر التصنيع</h3>${d.mfg.length ? `<div class="tbl-wrap"><table><tbody>${d.mfg.map(z => `<tr><td><a href="#/mfg/${esc(z.id)}">${esc(z.items?.name_ar || '')} <span class="num">${esc(z.number || 'مسودة')}</span></a></td><td class="num">${fq(z.qty)}</td><td class="amt num">${z.status === 'posted' ? money(z.total_cost) : '—'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">لا توجد.</p>'}</section>
        <section class="card"><h3 style="margin-bottom:8px">المصروفات</h3>${d.expenses.length ? `<div class="tbl-wrap"><table><tbody>${d.expenses.map(z => `<tr><td>${esc(z.description || z.number || '')}</td><td class="num xs">${esc(z.expense_date)}</td><td class="amt num">${money(z.amount)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">لا توجد. سجّل المصروف من «المصروفات» واختر هذا المشروع.</p>'}</section></div></div>`;
  $$('#ptab [data-go]').forEach(b => b.onclick = () => go(b.dataset.go, b.dataset.np ? { party: '' } : {}));
}

const PROJECT_ROUTES = [
  [/^#\/projects(\?.*)?$/, gate('projects', 'المشاريع', 'accounting|manufacturing|reports|sales', m => projectsView(new URLSearchParams((m[1] || '').slice(1))))],
  [/^#\/projects\/([\w-]+)(\?.*)?$/, gate('projects', 'المشاريع', 'accounting|manufacturing|reports|sales', m => projectView(m[1], new URLSearchParams((m[2] || '').slice(1))))],
];
