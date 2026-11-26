// =====================================================================
// Wave 5: CSV / Excel import (customers, suppliers, items, stock counts),
// branches with their warehouses and sales. Inserted after ext.js.
// =====================================================================
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/)[0] || '', delim = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : first.includes('\t') && !first.includes(',') ? '\t' : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; continue; }
    if (c === '"') q = true; else if (c === delim) { row.push(cur); cur = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; } else cur += c; }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.map(r => r.map(c => c.trim())).filter(r => r.some(c => c));
}
const readFileText = file => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file, 'utf-8'); });
const normH = h => toLatin(String(h || '')).toLowerCase().replace(/[\s_\-ـ:.]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
// field → accepted header spellings (Arabic and English, normalised)
const IMPORT_SPEC = {
  parties: { name: ['الاسم', 'اسمالعميل', 'اسمالمورد', 'name', 'customer', 'supplier', 'العميل', 'المورد'], vat_number: ['الرقمالضريبي', 'vat', 'vatnumber', 'taxnumber'],
    cr_number: ['السجلالتجاري', 'cr', 'crnumber'], phone: ['الجوال', 'الهاتف', 'رقمالجوال', 'phone', 'mobile'], email: ['البريد', 'البريدالالكتروني', 'email'],
    city: ['المدينه', 'city'], district: ['الحي', 'district'], street: ['الشارع', 'street'], building_no: ['رقمالمبني', 'building'], postal_code: ['الرمزالبريدي', 'postal', 'zip'],
    credit_limit: ['حدالائتمان', 'creditlimit'] },
  items: { name_ar: ['الاسم', 'اسمالصنف', 'الصنف', 'name', 'item', 'namear'], sku: ['الرمز', 'رمزالصنف', 'الكود', 'sku', 'code'], barcode: ['الباركود', 'barcode'],
    kind: ['النوع', 'kind', 'type'], unit: ['الوحده', 'unit'], sale_price: ['سعرالبيع', 'السعر', 'price', 'saleprice'], avg_cost: ['التكلفه', 'سعرالتكلفه', 'cost', 'avgcost'] },
  count: { sku: ['الرمز', 'رمزالصنف', 'الكود', 'sku', 'code', 'الباركود', 'barcode'], name: ['الاسم', 'الصنف', 'name', 'item'], qty: ['الكميه', 'الكميهالفعليه', 'qty', 'quantity', 'count'], cost: ['التكلفه', 'تكلفهالوحده', 'cost', 'unitcost'] },
};
function mapHeaders(header, spec) { const H = header.map(normH), m = {}; Object.entries(spec).forEach(([f, names]) => { const i = H.findIndex(h => names.includes(h)); if (i >= 0) m[f] = i; }); return m; }
const ITEM_KIND = v => { const s = normH(v); return ['service', 'خدمه'].includes(s) ? 'service' : ['raw', 'rawmaterial', 'مادهخام', 'خام', 'موادخام'].includes(s) ? 'raw_material' : 'product'; };
const csvTemplate = (cols, name) => dl([cols], name);

async function importView(qs) {
  shell('import', loading());
  const tab = qs?.get('t') || 'customers', T = { customers: ['العملاء', 'sales'], suppliers: ['الموردون', 'purchases'], items: ['الأصناف', 'inventory|sales|purchases'] };
  if (!T[tab][1].split('|').some(m => can(m, 'create'))) { $('#main').innerHTML = empty('lock', 'ليست لديك صلاحية', 'تحتاج صلاحية الإضافة في هذا القسم.'); return; }
  const [ps, items] = await Promise.all([tab === 'items' ? [] : api.listParties(), tab === 'items' ? api.listItems() : []]);
  const COLS = { customers: ['الاسم', 'الرقم الضريبي', 'السجل التجاري', 'الجوال', 'البريد', 'المدينة', 'الحي', 'الشارع', 'رقم المبنى', 'الرمز البريدي', 'حد الائتمان'],
    suppliers: ['الاسم', 'الرقم الضريبي', 'السجل التجاري', 'الجوال', 'البريد', 'المدينة', 'الحي', 'الشارع', 'رقم المبنى', 'الرمز البريدي'],
    items: ['الاسم', 'الرمز', 'الباركود', 'النوع (منتج / خدمة / مادة خام)', 'الوحدة', 'سعر البيع', 'التكلفة'] };
  $('#main').innerHTML = `<div class="page-head"><h1>استيراد البيانات من Excel</h1></div>
    <div class="tabs">${Object.entries(T).map(([k, [t]]) => `<a href="#/import?t=${k}" class="${k === tab ? 'on' : ''}">${t}</a>`).join('')}</div>
    <section class="card" style="max-width:860px"><ol style="margin:0 0 12px;padding-inline-start:20px;line-height:1.9">
      <li>نزّل القالب <button class="btn ghost sm" id="tpl">${icon('down')}قالب ${T[tab][0]} (CSV)</button> أو استخدم ملفك — أول صف أسماء الأعمدة.</li>
      <li>من Excel: «حفظ باسم» ← <b>CSV UTF-8</b>.</li><li>اختر الملف، راجع المعاينة، ثم اضغط «استيراد».</li></ol>
      <input type="file" id="csvf" accept=".csv,.txt,text/csv" class="input" aria-label="ملف CSV">
      <div id="prev" style="margin-top:16px"></div></section>`;
  $('#tpl').onclick = () => csvTemplate(COLS[tab], 'قالب ' + T[tab][0]);
  $('#csvf').onchange = async e => { const file = e.target.files[0]; if (!file) return; if (file.size > 2 * 1024 * 1024) return toast('الملف أكبر من 2 ميجابايت', 'bad');
    const rows = parseCSV(await readFileText(file)); if (rows.length < 2) return $('#prev').innerHTML = '<p class="help err">الملف فارغ أو بدون صف عناوين.</p>';
    const spec = tab === 'items' ? IMPORT_SPEC.items : IMPORT_SPEC.parties, m = mapHeaders(rows[0], spec), nameKey = tab === 'items' ? 'name_ar' : 'name';
    if (m[nameKey] == null) return $('#prev').innerHTML = `<p class="help err">لم أجد عمود «الاسم». الأعمدة في ملفك: ${esc(rows[0].join('، '))}</p>`;
    const existing = new Set((tab === 'items' ? items.map(i => i.sku || '') : ps.map(p => p.vat_number || '')).filter(Boolean)), names = new Set((tab === 'items' ? items.map(i => i.name_ar) : ps.map(p => p.name)));
    const recs = rows.slice(1).map((r, i) => { const o = {}; Object.entries(m).forEach(([f, j]) => o[f] = r[j] ?? ''); const errs = [];
      if (!o[nameKey]) errs.push('بدون اسم');
      if (tab !== 'items') { ['vat_number', 'cr_number', 'phone', 'building_no', 'postal_code'].forEach(k => { if (o[k]) o[k] = toLatin(o[k]).replace(/\s/g, ''); });
        if (o.vat_number && !VAT_RE.test(o.vat_number)) errs.push('رقم ضريبي غير صحيح'); if (o.email && !/^\S+@\S+\.\S+$/.test(o.email)) errs.push('بريد غير صحيح');
        if (o.credit_limit) { o.credit_limit = toHalalas(o.credit_limit); if (!(o.credit_limit >= 0)) errs.push('حد ائتمان غير صحيح'); } else delete o.credit_limit;
        if (o.vat_number && existing.has(o.vat_number) || names.has(o[nameKey])) errs.push('موجود مسبقاً'); }
      else { o.kind = ITEM_KIND(o.kind); o.sale_price = toHalalas(o.sale_price || 0); if (!(o.sale_price >= 0)) errs.push('سعر غير صحيح');
        if (o.avg_cost) { o.avg_cost = toHalalas(o.avg_cost); if (!(o.avg_cost >= 0)) errs.push('تكلفة غير صحيحة'); } else delete o.avg_cost;
        if (o.sku && existing.has(o.sku) || names.has(o.name_ar)) errs.push('موجود مسبقاً'); o.track_stock = o.kind !== 'service'; o.unit = o.unit || 'unit'; }
      Object.keys(o).forEach(k => { if (o[k] === '') delete o[k]; }); return { i: i + 2, o, errs }; });
    const good = recs.filter(r => !r.errs.length), fields = Object.keys(m);
    $('#prev').innerHTML = `<p><b class="num">${good.length}</b> صف جاهز للاستيراد${recs.length - good.length ? ` · <span class="down">${recs.length - good.length} صف فيه مشكلة (يُتخطّى)</span>` : ''}</p>
      <div class="tbl-wrap" style="max-height:360px;overflow:auto"><table class="rep-tbl"><thead><tr><th>#</th>${fields.map(f => `<th>${esc(rows[0][m[f]])}</th>`).join('')}<th>الحالة</th></tr></thead><tbody>
        ${recs.slice(0, 200).map(r => `<tr><td class="num">${r.i}</td>${fields.map(f => `<td>${esc(['sale_price', 'avg_cost', 'credit_limit'].includes(f) && r.o[f] != null ? money(r.o[f]) : r.o[f] ?? '')}</td>`).join('')}<td>${r.errs.length ? badge([r.errs.join('، '), 'b-bad']) : badge(['جاهز', 'b-ok'])}</td></tr>`).join('')}</tbody></table></div>
      ${good.length ? `<div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn primary" id="doimp">استيراد ${good.length} سجل</button></div><p class="muted xs" id="impst"></p>` : ''}`;
    if ($('#doimp')) $('#doimp').onclick = async ev => { ev.target.disabled = true; let n = 0; const failed = [];
      for (const r of good) { try { if (tab === 'items') await api.saveItem(r.o); else await api.saveParty({ ...r.o, kind: tab === 'customers' ? 'customer' : 'supplier' }); n++; }
        catch (x) { failed.push(`صف ${r.i}: ${x.message}`); } $('#impst').textContent = `تم ${n} من ${good.length}…`; }
      toast(`استُورد ${n} سجل` + (failed.length ? ` — تعذّر ${failed.length}` : ''), failed.length ? 'warn' : 'ok');
      $('#impst').innerHTML = failed.length ? `<span class="down">${esc(failed.slice(0, 10).join(' · '))}</span>` : `اكتمل الاستيراد. <a href="#/${tab}">فتح ${T[tab][0]} ←</a>`; };
  };
}

// stock-count sheet: export current balances to count on paper / Excel, import the counted quantities back
function stockSheetExport(stock, q, wh, whName) {
  dl([['الرمز', 'الاسم', 'الوحدة', 'رصيد النظام', 'الكمية الفعلية'], ...stock.map(s => [s.sku || '', s.name_ar, s.unit, fq(q[s.id + ':' + wh] || 0), ''])], `ورقة جرد ${whName} ${riyadhToday()}`);
}
async function stockSheetImport(file, stock) {
  const rows = parseCSV(await readFileText(file)); if (rows.length < 2) throw new AppError('الملف فارغ');
  const m = mapHeaders(rows[0], IMPORT_SPEC.count); if (m.qty == null) throw new AppError('لم أجد عمود «الكمية» أو «الكمية الفعلية»');
  const bySku = Object.fromEntries(stock.filter(s => s.sku).map(s => [toLatin(s.sku).toLowerCase(), s])), byBar = Object.fromEntries(stock.filter(s => s.barcode).map(s => [s.barcode, s])), byName = Object.fromEntries(stock.map(s => [s.name_ar.trim(), s]));
  const lines = [], missing = [];
  rows.slice(1).forEach(r => { const qv = r[m.qty]; if (qv === '' || qv == null) return; const sku = m.sku != null ? toLatin(r[m.sku] || '').toLowerCase() : '';
    const it = bySku[sku] || byBar[r[m.sku]] || (m.name != null ? byName[(r[m.name] || '').trim()] : null);
    if (!it) { missing.push(r[m.sku] || r[m.name] || '?'); return; }
    const qty = Number(toLatin(qv).replace(/,/g, '')); if (!Number.isFinite(qty) || qty < 0) { missing.push((r[m.sku] || r[m.name]) + ' (كمية)'); return; }
    lines.push({ item_id: it.id, qty, unit_cost: m.cost != null && r[m.cost] ? toHalalas(r[m.cost]) : null }); });
  return { lines, missing };
}

// ---------- branches ----------
async function branchesView() {
  shell('branches', loading()); const editable = can('settings', 'create');
  const y = riyadhToday().slice(0, 4), m = riyadhToday().slice(0, 7);
  const [bs, whs, docs] = await Promise.all([api.listBranches(), api.listWarehouses(), can('sales') ? api.listDocuments(['tax_invoice', 'simplified_invoice', 'credit_note']).catch(() => []) : []]);
  const posted = docs.filter(d => d.status === 'posted'), S = (b, pre) => posted.filter(d => d.branch_id === b && d.issue_date.startsWith(pre)).reduce((s, d) => s + (d.kind === 'credit_note' ? -1 : 1) * Number(d.subtotal), 0);
  $('#main').innerHTML = `<div class="page-head"><h1>الفروع</h1>${editable ? `<button class="btn primary" id="newb">${icon('plus')}فرع جديد</button>` : ''}</div>
    <p class="muted" style="margin:-8px 0 16px">لكل فرع مستودعاته؛ الفاتورة تُنسب لفرع المستودع الذي تُصرف منه. لنقل بضاعة بين الفروع استخدم <a href="#/stock/new?kind=transfer">تحويل بين مستودعات</a>.</p>
    <div class="grid g3">${bs.map(b => { const w = whs.filter(x => x.branch_id === b.id); return `<section class="card"><div class="row" style="justify-content:space-between"><h3 style="margin:0">${esc(b.name)}</h3>${editable ? `<button class="btn ghost sm" data-eb="${esc(b.id)}">تعديل</button>` : ''}</div>
      <p class="xs muted" style="margin:4px 0 10px">${esc([b.building_no, b.street, b.city].filter(Boolean).join('، ') || '—')}</p>
      ${can('sales') ? `<dl class="kv"><dt>مبيعات هذا الشهر</dt><dd class="num">${money(S(b.id, m))}</dd><dt>مبيعات ${y}</dt><dd class="num">${money(S(b.id, y))}</dd></dl>` : ''}
      <p class="xs" style="margin-top:8px"><b>المستودعات:</b> ${w.map(x => esc(x.name)).join('، ') || '<span class="muted">لا يوجد — أضف مستودعاً من صفحة المستودعات</span>'}</p></section>`; }).join('')}</div>`;
  const open = b => { b = b || {}; drawer(b.id ? 'تعديل فرع' : 'فرع جديد', `${field('name', 'اسم الفرع', { req: true, value: b.name || '', help: 'مثل: فرع جدة، المعرض، المصنع' })}
      <div class="form-grid">${field('city', 'المدينة', { value: b.city || '' })}${field('street', 'الشارع', { value: b.street || '' })}${field('building_no', 'رقم المبنى', { value: b.building_no || '', attrs: 'dir="ltr" inputmode="numeric" maxlength="4"' })}${field('postal_code', 'الرمز البريدي', { value: b.postal_code || '', attrs: 'dir="ltr" inputmode="numeric" maxlength="5"' })}</div>
      ${!b.id ? `<label class="row" style="gap:8px"><input type="checkbox" name="mkwh" checked> إنشاء مستودع للفرع تلقائياً</label>` : ''}`,
    async v => { if (!v.name?.trim()) throw new AppError('الاسم مطلوب'); ['building_no', 'postal_code'].forEach(k => v[k] = toLatin(v[k] || ''));
      const nb = await api.saveBranch({ ...(b.id ? { id: b.id } : {}), name: v.name.trim(), city: v.city || null, street: v.street || null, building_no: v.building_no || null, postal_code: v.postal_code || null });
      if (!b.id && v.mkwh) await api.saveWarehouse({ name: 'مستودع ' + v.name.trim(), kind: 'general', branch_id: nb.id });
      toast('حُفظ الفرع'); branchesView(); }); };
  if ($('#newb')) $('#newb').onclick = () => open(null);
  $$('[data-eb]').forEach(x => x.onclick = () => open(bs.find(b => b.id === x.dataset.eb)));
}

const EXT2_ROUTES = [
  [/^#\/import(\?.*)?$/, gate('import', 'الاستيراد', 'sales|purchases|inventory', m => importView(new URLSearchParams((m[1] || '').slice(1))))],
  [/^#\/branches$/, gate('branches', 'الفروع', 'settings|sales|inventory', branchesView)],
];
