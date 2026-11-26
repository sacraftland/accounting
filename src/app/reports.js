// =====================================================================
// Reports (income statement, balance sheet, VAT return, aging, inventory,
// production), dashboard insights, employees & payroll.
// Inserted into app.js by build.py after ops.js — shares its helpers.
// =====================================================================

// ---------- periods ----------
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monthStart = (y, m) => ymd(new Date(y, m, 1)), monthEnd = (y, m) => ymd(new Date(y, m + 1, 0));
function periodPresets() {
  const t = riyadhToday(), y = +t.slice(0, 4), m = +t.slice(5, 7) - 1, q = Math.floor(m / 3) * 3;
  return [['this-month', 'هذا الشهر', monthStart(y, m), t], ['last-month', 'الشهر الماضي', monthStart(y, m - 1), monthEnd(y, m - 1)],
    ['this-q', 'هذا الربع', monthStart(y, q), t], ['last-q', 'الربع الماضي', monthStart(y, q - 3), monthEnd(y, q - 1)],
    ['this-y', 'هذه السنة', `${y}-01-01`, t], ['last-y', 'السنة الماضية', `${y - 1}-01-01`, `${y - 1}-12-31`]];
}
const prevPeriod = (from, to) => { const f = new Date(from + 'T00:00:00'), tt = new Date(to + 'T00:00:00');
  const days = Math.round((tt - f) / 864e5) + 1; const pe = new Date(f); pe.setDate(pe.getDate() - 1); const ps = new Date(pe); ps.setDate(ps.getDate() - days + 1); return [ymd(ps), ymd(pe)]; };
const pct = (a, b) => (b ? ((a - b) / Math.abs(b) * 100) : null);
const pctTxt = v => v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const monthName = d => AR_MONTHS[+d.slice(5, 7) - 1] + ' ' + d.slice(0, 4);

// ---------- export ----------
function tableToCsv(tbl, name) {
  const rows = [...tbl.querySelectorAll('tr')].map(tr => [...tr.children].map(c => `"${c.innerText.replace(/\s+/g, ' ').trim().replace(/"/g, '""')}"`).join(','));
  const blob = new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name + '.csv'; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- reports page ----------
const REPORTS = [['pl', 'قائمة الدخل'], ['bs', 'المركز المالي'], ['vat', 'الإقرار الضريبي'], ['aging', 'أعمار الذمم'], ['stock', 'تقييم المخزون'], ['mfg', 'تقرير الإنتاج']];
async function reportsView(which, qs) {
  shell('reports', loading());
  const tab = REPORTS.some(r => r[0] === which) ? which : 'pl';
  const presets = periodPresets(), def = tab === 'vat' ? 'last-q' : tab === 'bs' ? 'this-y' : 'this-month';
  const pk = qs?.get('p') || sessionStorage.getItem('rep-p-' + tab) || def;
  const pr = presets.find(p => p[0] === pk);
  const from = qs?.get('from') || pr?.[2] || presets[0][2], to = qs?.get('to') || pr?.[3] || presets[0][3];
  const needsPeriod = !['aging', 'stock'].includes(tab);
  $('#main').innerHTML = `<div class="page-head no-print"><h1>التقارير</h1><button class="btn secondary" id="csv">${icon('down')}تصدير Excel (CSV)</button><button class="btn secondary" onclick="window.print()">${icon('down')}طباعة / PDF</button></div>
    <div class="tabs no-print" role="tablist">${REPORTS.map(([k, t]) => `<a role="tab" class="${k === tab ? 'on' : ''}" aria-selected="${k === tab}" href="#/reports/${k}">${t}</a>`).join('')}</div>
    ${needsPeriod ? `<form class="row no-print" id="perf" style="flex-wrap:wrap;gap:8px;margin-bottom:16px;align-items:flex-end">
      <div class="field" style="margin:0"><label for="f-preset">الفترة</label><select class="input" id="f-preset" style="height:38px">${presets.map(([k, t]) => `<option value="${k}"${k === pk ? ' selected' : ''}>${t}</option>`).join('')}<option value="custom"${!pr ? ' selected' : ''}>فترة مخصصة</option></select></div>
      ${tab !== 'bs' ? `<div class="field" style="margin:0"><label for="f-from">من</label><input class="input" type="date" id="f-from" value="${esc(from)}" style="height:38px"></div>` : ''}
      <div class="field" style="margin:0"><label for="f-to">${tab === 'bs' ? 'كما في تاريخ' : 'إلى'}</label><input class="input" type="date" id="f-to" value="${esc(to)}" style="height:38px"></div>
      <button class="btn primary" type="submit">عرض</button></form>` : ''}
    <section class="card" id="rep">${loading()}</section>`;
  if (needsPeriod) {
    $('#f-preset').onchange = e => { const p = presets.find(x => x[0] === e.target.value); if (!p) return; sessionStorage.setItem('rep-p-' + tab, p[0]); location.hash = `#/reports/${tab}?p=${p[0]}`; };
    $('#perf').onsubmit = e => { e.preventDefault(); sessionStorage.removeItem('rep-p-' + tab); location.hash = `#/reports/${tab}?p=custom&from=${$('#f-from')?.value || from}&to=${$('#f-to').value}`; };
  }
  const head = (title, sub) => `<div class="rep-head"><b style="font-size:18px">${esc(ORG.name_ar)}</b>${ORG.vat_number ? ` <span class="muted xs">· الرقم الضريبي <span class="num">${esc(ORG.vat_number)}</span></span>` : ''}<h2 style="margin:4px 0">${title}</h2><p class="muted" style="margin:0 0 16px">${sub}</p></div>`;
  const R = { pl: plReport, bs: bsReport, vat: vatReport, aging: agingReport, stock: stockReport, mfg: mfgReport }[tab];
  $('#rep').innerHTML = await R(from, to, head);
  $('#csv').onclick = () => { const t = $('#rep table'); if (t) tableToCsv(t, (REPORTS.find(r => r[0] === tab)[1]) + ' ' + (needsPeriod ? from + '_' + to : riyadhToday())); else toast('لا يوجد جدول للتصدير', 'warn'); };
}

const groupCode = (rows, r) => { const byId = Object.fromEntries(rows.map(x => [x.account_id, x])); return byId[r.parent_id]; };
async function plReport(from, to, head) {
  const [pf, pt] = prevPeriod(from, to);
  const [cur, prev] = await Promise.all([api.accountBalances(from, to), api.accountBalances(pf, pt)]);
  const P = Object.fromEntries(prev.map(r => [r.account_id, r]));
  const mv = (r, sign) => sign * (r.debit - r.credit);
  const lines = (pred, sign) => cur.filter(r => r.is_postable && pred(r)).map(r => ({ code: r.code, name: r.name_ar, id: r.account_id, v: mv(r, sign), p: P[r.account_id] ? mv(P[r.account_id], sign) : 0 })).filter(x => x.v || x.p);
  const isCogs = r => groupCode(cur, r)?.code === '51';
  const rev = lines(r => r.type === 'revenue', -1), cogs = lines(r => r.type === 'expense' && isCogs(r), 1), opx = lines(r => r.type === 'expense' && !isCogs(r), 1);
  const sum = (a, k) => a.reduce((s, x) => s + x[k], 0);
  const R = sum(rev, 'v'), Rp = sum(rev, 'p'), C = sum(cogs, 'v'), Cp = sum(cogs, 'p'), O = sum(opx, 'v'), Op = sum(opx, 'p');
  const row = x => `<tr><td><span class="num muted">${esc(x.code)}</span> ${esc(x.name)}</td><td class="amt num">${money(x.v)}</td><td class="amt num m-hide">${R ? (x.v / R * 100).toFixed(1) + '%' : '—'}</td><td class="amt num m-hide muted">${money(x.p)}</td><td class="amt num m-hide">${pctTxt(pct(x.v, x.p))}</td></tr>`;
  const tot = (t, v, p, strong) => `<tr class="${strong ? 'grand' : 'sub'}"><td>${t}</td><td class="amt num">${money(v)}</td><td class="amt num m-hide">${R ? (v / R * 100).toFixed(1) + '%' : '—'}</td><td class="amt num m-hide muted">${money(p)}</td><td class="amt num m-hide">${pctTxt(pct(v, p))}</td></tr>`;
  const sec = t => `<tr class="sec"><td colspan="5">${t}</td></tr>`;
  const net = R - C - O, netp = Rp - Cp - Op;
  return head('قائمة الدخل', `من <span class="num">${from}</span> إلى <span class="num">${to}</span> — مقارنة بالفترة السابقة (<span class="num">${pf}</span> – <span class="num">${pt}</span>)`) +
    `<div class="grid g3" style="margin-bottom:16px">${[['الإيرادات', R, Rp], ['مجمل الربح', R - C, Rp - Cp], ['صافي الربح', net, netp]].map(([t, v, p]) => `<div class="stat"><div class="label">${t}</div><div class="val num ${v < 0 ? 'down' : ''}">${money(v)}</div><div class="xs muted">السابقة <span class="num">${money(p)}</span> · <span class="num">${pctTxt(pct(v, p))}</span></div></div>`).join('')}</div>
    <div class="tbl-wrap"><table class="rep-tbl"><thead><tr><th>البند</th><th class="amt">الفترة الحالية</th><th class="amt m-hide">% من الإيرادات</th><th class="amt m-hide">الفترة السابقة</th><th class="amt m-hide">التغيّر</th></tr></thead><tbody>
    ${sec('الإيرادات')}${rev.map(row).join('')}${tot('إجمالي الإيرادات', R, Rp)}
    ${sec('تكلفة المبيعات')}${cogs.map(row).join('')}${tot('إجمالي تكلفة المبيعات', C, Cp)}${tot('مجمل الربح', R - C, Rp - Cp, true)}
    ${sec('المصاريف التشغيلية والأخرى')}${opx.map(row).join('')}${tot('إجمالي المصاريف', O, Op)}
    ${tot(net >= 0 ? 'صافي الربح' : 'صافي الخسارة', net, netp, true)}</tbody></table></div>
    ${!rev.length && !cogs.length && !opx.length ? '<p class="muted" style="margin-top:12px">لا توجد حركات مرحّلة في هذه الفترة.</p>' : ''}`;
}

async function bsReport(from, to, head) {
  const rows = await api.accountBalances(to, to);
  const byId = Object.fromEntries(rows.map(r => [r.account_id, r]));
  const top = r => { let x = r, g = groupCode(rows, r); while (g && g.parent_id && byId[g.parent_id]) { x = g; g = byId[g.parent_id]; } return g ? x : r; };
  const sec2 = r => { const g = byId[r.parent_id]; return g?.code?.length === 2 ? g : byId[g?.parent_id]?.code?.length === 2 ? byId[g.parent_id] : g; };
  const post = rows.filter(r => r.is_postable && r.closing);
  const block = (type, sign) => { const items = post.filter(r => r.type === type); const groups = {};
    items.forEach(r => { const g = sec2(r); const k = g?.id ? g.account_id : 'x'; (groups[k] ||= { name: g?.name_ar || '', code: g?.code || '', rows: [] }).rows.push({ ...r, v: sign * r.closing }); });
    return Object.values(groups).sort((a, b) => a.code.localeCompare(b.code)); };
  const earnings = -rows.filter(r => r.is_postable && ['revenue', 'expense'].includes(r.type)).reduce((a, r) => a + r.closing, 0);
  const A = block('asset', 1), L = block('liability', -1), E = block('equity', -1);
  const tA = A.reduce((s, g) => s + g.rows.reduce((t, r) => t + r.v, 0), 0), tL = L.reduce((s, g) => s + g.rows.reduce((t, r) => t + r.v, 0), 0), tE = E.reduce((s, g) => s + g.rows.reduce((t, r) => t + r.v, 0), 0) + earnings;
  const grp = g => `<tr class="sec"><td colspan="2">${esc(g.name)}</td></tr>${g.rows.sort((a, b) => a.code.localeCompare(b.code)).map(r => `<tr><td><span class="num muted">${esc(r.code)}</span> ${esc(r.name_ar)}</td><td class="amt num ${r.v < 0 ? 'down' : ''}">${money(r.v)}</td></tr>`).join('')}
    <tr class="sub"><td>إجمالي ${esc(g.name)}</td><td class="amt num">${money(g.rows.reduce((t, r) => t + r.v, 0))}</td></tr>`;
  const ok = Math.abs(tA - tL - tE) < 1;
  return head('قائمة المركز المالي', `كما في <span class="num">${to}</span> ${ok ? badge(['متوازنة ✓', 'b-ok']) : badge(['غير متوازنة', 'b-bad'])}`) +
    `<div class="grid g2" style="align-items:start"><div class="tbl-wrap"><table class="rep-tbl"><thead><tr><th>الأصول</th><th class="amt">المبلغ</th></tr></thead><tbody>${A.map(grp).join('') || '<tr><td colspan="2" class="muted">—</td></tr>'}
      <tr class="grand"><td>إجمالي الأصول</td><td class="amt num">${money(tA)}</td></tr></tbody></table></div>
    <div class="tbl-wrap"><table class="rep-tbl"><thead><tr><th>الخصوم وحقوق الملكية</th><th class="amt">المبلغ</th></tr></thead><tbody>${L.map(grp).join('')}
      <tr class="sub"><td>إجمالي الخصوم</td><td class="amt num">${money(tL)}</td></tr>
      ${E.map(grp).join('')}<tr><td>أرباح (خسائر) غير مُقفلة <span class="xs muted">— صافي الإيرادات والمصروفات حتى التاريخ</span></td><td class="amt num ${earnings < 0 ? 'down' : ''}">${money(earnings)}</td></tr>
      <tr class="sub"><td>إجمالي حقوق الملكية</td><td class="amt num">${money(tE)}</td></tr>
      <tr class="grand"><td>إجمالي الخصوم وحقوق الملكية</td><td class="amt num">${money(tL + tE)}</td></tr></tbody></table></div></div>`;
}

async function vatReport(from, to, head) {
  const v = await api.vatReturn(from, to), n = x => Number(x || 0);
  const r = (no, t, o, withVat = true) => `<tr><td class="num muted">${no}</td><td>${t}</td><td class="amt num">${money(n(o.net))}</td><td class="amt num">${money(n(o.adj_net))}</td><td class="amt num">${withVat ? money(n(o.vat) - n(o.adj_vat)) : '—'}</td></tr>`;
  const S = v.sales_standard, P = v.purchases_standard;
  const outV = n(S.vat) - n(S.adj_vat), inV = n(P.vat) - n(P.adj_vat), due = outV - inV;
  const sTot = n(S.net) + n(v.sales_zero.net) + n(v.sales_exempt.net), sAdj = n(S.adj_net) + n(v.sales_zero.adj_net) + n(v.sales_exempt.adj_net);
  const pTot = n(P.net) + n(v.purchases_zero.net), pAdj = n(P.adj_net) + n(v.purchases_zero.adj_net);
  return head('إقرار ضريبة القيمة المضافة', `الفترة من <span class="num">${from}</span> إلى <span class="num">${to}</span> — بنفس ترتيب نموذج هيئة الزكاة والضريبة والجمارك`) +
    `<div class="tbl-wrap"><table class="rep-tbl"><thead><tr><th>#</th><th>البند</th><th class="amt">المبلغ (ر.س)</th><th class="amt">التعديلات</th><th class="amt">مبلغ الضريبة</th></tr></thead><tbody>
      <tr class="sec"><td colspan="5">المبيعات</td></tr>
      ${r(1, 'المبيعات الخاضعة للنسبة الأساسية 15%', S)}${r(2, 'المبيعات المحلية الخاضعة للنسبة الصفرية والصادرات', v.sales_zero, false)}${r(3, 'المبيعات المعفاة وغير الخاضعة', v.sales_exempt, false)}
      <tr class="sub"><td class="num muted">4</td><td>إجمالي المبيعات</td><td class="amt num">${money(sTot)}</td><td class="amt num">${money(sAdj)}</td><td class="amt num">${money(outV)}</td></tr>
      <tr class="sec"><td colspan="5">المشتريات والمصروفات</td></tr>
      ${r(5, 'المشتريات والمصروفات الخاضعة للنسبة الأساسية 15%', P)}${r(6, 'المشتريات الخاضعة للنسبة الصفرية والمعفاة', v.purchases_zero, false)}
      <tr class="sub"><td class="num muted">7</td><td>إجمالي المشتريات</td><td class="amt num">${money(pTot)}</td><td class="amt num">${money(pAdj)}</td><td class="amt num">${money(inV)}</td></tr>
      <tr class="grand"><td class="num">8</td><td>${due >= 0 ? 'صافي الضريبة المستحقة للسداد' : 'صافي الضريبة القابلة للاسترداد'}</td><td></td><td></td><td class="amt num">${money(Math.abs(due))}</td></tr></tbody></table></div>
    <p class="note" style="margin-top:12px">التعديلات = الإشعارات الدائنة (مرتجعات المبيعات) ومرتجعات المشتريات. ضريبة المصروفات تُحتسب ضمن المشتريات إذا سُجّلت «شاملة ضريبة 15%». راجع الأرقام قبل تقديم الإقرار في بوابة الهيئة.</p>`;
}

async function agingReport(_f, _t, head) {
  const [ar, ap, ps] = await Promise.all([can('sales') ? api.openDocuments(['tax_invoice', 'simplified_invoice']) : [], can('purchases') ? api.openDocuments(['purchase_bill']) : [], api.listParties().catch(() => [])]);
  const PH = Object.fromEntries(ps.map(p => [p.id, p]));
  const remind = r => { const p = PH[r.id]; if (!p || r.t <= 0) return ''; const msg = `السلام عليكم ${p.name}، نود تذكيركم بأن الرصيد المستحق لدى ${ORG.name_ar} هو ${money(r.t)} ر.س. شاكرين تعاونكم.`;
    return `${p.phone ? `<a class="btn ghost sm" target="_blank" rel="noopener" href="${waLink(p.phone, msg)}" title="تذكير واتساب">واتساب</a>` : ''}${p.email ? `<a class="btn ghost sm" href="mailto:${esc(p.email)}?subject=${encodeURIComponent('تذكير بالرصيد المستحق')}&body=${encodeURIComponent(msg)}">بريد</a>` : ''}`; };
  const today = riyadhToday(), B = ['current', '1-30', '31-60', '61-90', '90+'], BN = { current: 'غير مستحقة', '1-30': '1–30 يوم', '31-60': '31–60', '61-90': '61–90', '90+': 'أكثر من 90' };
  const bucket = d => { const days = Math.round((new Date(today) - new Date(d.due_date || d.issue_date)) / 864e5); return days <= 0 ? 'current' : days <= 30 ? '1-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+'; };
  const table = (docs, title, side) => { const by = {}; docs.forEach(d => { const k = d.party_id || '_'; (by[k] ||= { name: d.party_name, id: d.party_id, b: Object.fromEntries(B.map(x => [x, 0])), t: 0 }); by[k].b[bucket(d)] += d.open; by[k].t += d.open; });
    const rows = Object.values(by).sort((a, b) => b.t - a.t), T = Object.fromEntries(B.map(x => [x, rows.reduce((s, r) => s + r.b[x], 0)])), TT = rows.reduce((s, r) => s + r.t, 0);
    return `<h3 style="margin:16px 0 8px">${title} <span class="muted xs">— الإجمالي <span class="num">${money(TT)}</span></span></h3>${rows.length ? `<div class="tbl-wrap"><table class="rep-tbl"><thead><tr><th>${side === 'ap' ? 'المورد' : 'العميل'}</th>${B.map(x => `<th class="amt">${BN[x]}</th>`).join('')}<th class="amt">الإجمالي</th>${side === 'ar' ? '<th class="no-print">تذكير</th>' : ''}</tr></thead><tbody>
      ${rows.map(r => `<tr><td>${r.id ? `<a href="#/${side === 'ap' ? 'suppliers' : 'customers'}/${esc(r.id)}">${esc(r.name)}</a>` : esc(r.name)}</td>${B.map(x => `<td class="amt num ${x !== 'current' && r.b[x] ? 'down' : ''}">${r.b[x] ? money(r.b[x]) : '—'}</td>`).join('')}<td class="amt num"><b>${money(r.t)}</b></td>${side === 'ar' ? `<td class="no-print">${remind(r)}</td>` : ''}</tr>`).join('')}
      <tr class="grand"><td>الإجمالي</td>${B.map(x => `<td class="amt num">${money(T[x])}</td>`).join('')}<td class="amt num">${money(TT)}</td>${side === 'ar' ? '<td></td>' : ''}</tr></tbody></table></div>` : '<p class="muted">لا توجد أرصدة مفتوحة.</p>'}`; };
  return head('أعمار الذمم', `كما في <span class="num">${today}</span> — حسب تاريخ الاستحقاق (أو تاريخ الفاتورة إن لم يُحدد)`) +
    (can('sales') ? table(ar, 'المستحق من العملاء', 'ar') : '') + (can('purchases') ? table(ap, 'المستحق للموردين', 'ap') : '');
}

async function stockReport(_f, _t, head) {
  const [items, bal, whs] = await Promise.all([api.listItems(), api.stockByWarehouse(), api.listWarehouses()]);
  const q = {}; bal.forEach(b => q[b.item_id + ':' + b.warehouse_id] = b.qty);
  const st = items.filter(i => i.track_stock), groups = [['raw_material', 'المواد الخام'], ['product', 'المنتجات التامة والبضاعة']];
  let grand = 0;
  const body = groups.map(([k, t]) => { const g = st.filter(i => (i.kind === 'raw_material') === (k === 'raw_material')); if (!g.length) return '';
    const tot = g.reduce((s, i) => s + Number(i.on_hand) * Number(i.avg_cost), 0); grand += tot;
    return `<tr class="sec"><td colspan="${whs.length + 4}">${t}</td></tr>${g.map(i => `<tr><td>${esc(i.name_ar)}${i.sku ? ` <span class="xs muted num">${esc(i.sku)}</span>` : ''}</td>${whs.map(w => `<td class="amt num m-hide">${fq(q[i.id + ':' + w.id] || 0)}</td>`).join('')}
      <td class="amt num ${i.on_hand < 0 ? 'down' : ''}">${fq(i.on_hand)} <span class="xs muted">${esc(i.unit)}</span></td><td class="amt num">${money(i.avg_cost)}</td><td class="amt num">${money(Number(i.on_hand) * Number(i.avg_cost))}</td></tr>`).join('')}
      <tr class="sub"><td colspan="${whs.length + 3}">إجمالي ${t}</td><td class="amt num">${money(tot)}</td></tr>`; }).join('');
  return head('تقييم المخزون', `كما في <span class="num">${riyadhToday()}</span> — بطريقة المتوسط المرجّح`) + (st.length ? `<div class="tbl-wrap"><table class="rep-tbl"><thead><tr><th>الصنف</th>${whs.map(w => `<th class="amt m-hide">${esc(w.name)}</th>`).join('')}<th class="amt">الكمية</th><th class="amt">متوسط التكلفة</th><th class="amt">القيمة</th></tr></thead><tbody>
    ${body}<tr class="grand"><td colspan="${whs.length + 3}">إجمالي قيمة المخزون</td><td class="amt num">${money(grand)}</td></tr></tbody></table></div>` : '<p class="muted">لا توجد أصناف مخزنية.</p>');
}

async function mfgReport(from, to, head) {
  const [ms, items] = await Promise.all([api.listMfg(), api.listItems()]); const I = Object.fromEntries(items.map(i => [i.id, i]));
  const f = ms.filter(m => m.status === 'posted' && m.order_date >= from && m.order_date <= to);
  const by = {}; f.forEach(m => { const k = m.item_id; const g = (by[k] ||= { name: m.items?.name_ar, unit: m.items?.unit, n: 0, qty: 0, mat: 0, wst: 0, ext: 0, tot: 0, price: Number(I[k]?.sale_price || 0) });
    g.n++; g.qty += m.qty; g.mat += m.material_cost; g.wst += m.waste_cost; g.ext += m.extra_cost; g.tot += m.total_cost; });
  const rows = Object.values(by).sort((a, b) => b.tot - a.tot), S = k => rows.reduce((s, r) => s + r[k], 0);
  return head('تقرير الإنتاج', `أوامر التصنيع المنفذة من <span class="num">${from}</span> إلى <span class="num">${to}</span>`) +
    `<div class="grid g4" style="margin-bottom:16px">${[['أوامر منفذة', f.length, 0], ['تكلفة الإنتاج', S('tot'), 1], ['تكلفة الهدر والتالف', S('wst'), 1], ['نسبة الهدر من المواد', S('mat') + S('wst') ? (S('wst') / (S('mat') + S('wst')) * 100).toFixed(1) + '%' : '—', 0]]
      .map(([t, v, m]) => `<div class="stat"><div class="label">${t}</div><div class="val num">${m ? money(v) : v}</div></div>`).join('')}</div>
    ${rows.length ? `<div class="tbl-wrap"><table class="rep-tbl"><thead><tr><th>المنتج</th><th class="amt">الأوامر</th><th class="amt">الكمية</th><th class="amt m-hide">المواد</th><th class="amt m-hide">الهدر</th><th class="amt m-hide">تكاليف إضافية</th><th class="amt">التكلفة الكلية</th><th class="amt">تكلفة الوحدة</th><th class="amt">سعر البيع</th><th class="amt">الهامش</th></tr></thead><tbody>
      ${rows.map(r => { const u = r.tot / r.qty, mg = r.price ? (r.price - u) / r.price * 100 : null; return `<tr><td>${esc(r.name)}</td><td class="amt num">${r.n}</td><td class="amt num">${fq(r.qty)} <span class="xs muted">${esc(r.unit || '')}</span></td>
        <td class="amt num m-hide">${money(r.mat)}</td><td class="amt num m-hide">${money(r.wst)}</td><td class="amt num m-hide">${money(r.ext)}</td><td class="amt num">${money(r.tot)}</td><td class="amt num">${money(u)}</td>
        <td class="amt num">${r.price ? money(r.price) : '—'}</td><td class="amt num ${mg != null && mg < 0 ? 'down' : ''}">${mg == null ? '—' : mg.toFixed(1) + '%'}</td></tr>`; }).join('')}
      <tr class="grand"><td>الإجمالي</td><td class="amt num">${f.length}</td><td></td><td class="amt num m-hide">${money(S('mat'))}</td><td class="amt num m-hide">${money(S('wst'))}</td><td class="amt num m-hide">${money(S('ext'))}</td><td class="amt num">${money(S('tot'))}</td><td colspan="3"></td></tr></tbody></table></div>`
      : '<p class="muted">لا توجد أوامر تصنيع منفذة في هذه الفترة.</p>'}`;
}

// ---------- dashboard insights ----------
function barChart(data) {   // data: [{label, a, b}] — a = revenue, b = expenses (+cogs)
  const W = 640, H = 220, pl = 8, pr = 56, pt = 12, pb = 28, max = Math.max(1, ...data.flatMap(d => [d.a, d.b]));
  const nice = (() => { const p = Math.pow(10, Math.floor(Math.log10(max))); return Math.ceil(max / p) * p; })();
  const cw = (W - pl - pr) / data.length, bw = Math.min(22, cw / 3), y = v => pt + (H - pt - pb) * (1 - v / nice);
  const ticks = [0, .5, 1].map(f => nice * f);
  const bar = (x, v, cls, lbl) => { const h = Math.max(0, y(0) - y(v)); if (h < .5) return '';
    const r = Math.min(4, bw / 2, h); const yy = y(v);
    return `<path class="${cls}" d="M${x},${y(0)} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + bw - r} Q${x + bw},${yy} ${x + bw},${yy + r} V${y(0)} Z"><title>${esc(lbl)}</title></path>`; };
  // RTL reading order: newest month on the left edge? keep chronological right→left like the page
  const xs = i => W - pr - cw * (i + 1) + (cw - bw * 2 - 2) / 2;
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="الإيرادات والمصروفات آخر ${data.length} أشهر">
    ${ticks.map(t => `<line x1="${pl}" x2="${W - pr}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${W - pr + 6}" y="${y(t) + 4}" class="tick">${Math.round(t / 100).toLocaleString('en-US')}</text>`).join('')}
    ${data.map((d, i) => `<g class="hov">${bar(xs(i), d.a, 's1', `${d.label}: الإيرادات ${money(d.a)}`)}${bar(xs(i) + bw + 2, d.b, 's2', `${d.label}: المصروفات ${money(d.b)}`)}
      <text x="${xs(i) + bw + 1}" y="${H - 8}" class="tick" text-anchor="middle">${esc(d.label.split(' ')[0])}</text></g>`).join('')}</svg>`;
}
async function dashInsights() {
  if (api.mode !== 'supabase' || !(can('reports') || can('accounting'))) return '';
  const ms = await api.monthlySummary(6);
  const data = ms.map(m => ({ label: monthName(m.month), a: m.revenue, b: m.cogs + m.expenses, net: m.revenue - m.cogs - m.expenses }));
  const cur = data.at(-1) || { a: 0, b: 0, net: 0 }, prev = data.at(-2) || { a: 0, b: 0, net: 0 };
  const extra = [];
  if (can('purchases')) { const ap = await api.openDocuments(['purchase_bill']); extra.push(['مستحق للموردين', money(ap.reduce((s, d) => s + d.open, 0)), `${ap.length} فاتورة مفتوحة`, '#/reports/aging']); }
  if (can('inventory')) { const it = await api.listItems(); extra.push(['قيمة المخزون', money(it.filter(i => i.track_stock).reduce((s, i) => s + Number(i.on_hand) * Number(i.avg_cost), 0)), `${it.filter(i => i.track_stock && i.on_hand < 0).length} صنف بالسالب`, '#/reports/stock']); }
  return `<div class="grid g3 dash-ins" style="margin-bottom:24px;grid-template-columns:2fr 1fr">
    <section class="card"><div class="row" style="justify-content:space-between;flex-wrap:wrap"><h2 style="margin:0">الإيرادات والمصروفات — آخر 6 أشهر</h2>
      <div class="legend"><span><i class="sw s1"></i>الإيرادات</span><span><i class="sw s2"></i>المصروفات وتكلفة المبيعات</span></div></div>
      ${barChart([...data].reverse().reverse())}
      <details><summary class="xs muted">عرض كجدول</summary><div class="tbl-wrap"><table><thead><tr><th>الشهر</th><th class="amt">الإيرادات</th><th class="amt">المصروفات</th><th class="amt">صافي الربح</th></tr></thead><tbody>
        ${data.map(d => `<tr><td>${esc(d.label)}</td><td class="amt num">${money(d.a)}</td><td class="amt num">${money(d.b)}</td><td class="amt num ${d.net < 0 ? 'down' : ''}">${money(d.net)}</td></tr>`).join('')}</tbody></table></div></details></section>
    <div class="grid" style="gap:16px;align-content:start">
      <a class="card stat" href="#/reports/pl" style="text-decoration:none;color:inherit"><div class="label">صافي ربح هذا الشهر</div><div class="val num ${cur.net < 0 ? 'down' : ''}">${money(cur.net)}</div><div class="xs muted">الشهر الماضي <span class="num">${money(prev.net)}</span></div></a>
      ${extra.map(([t, v, s, h]) => `<a class="card stat" href="${h}" style="text-decoration:none;color:inherit"><div class="label">${t}</div><div class="val num">${v}</div><div class="xs muted">${s}</div></a>`).join('')}</div></div>`;
}

// ---------- employees ----------
async function employeesView() {
  shell('employees', loading()); const [es, ccs] = await Promise.all([api.listEmployees(), api.listCostCenters()]);
  const act = es.filter(e => e.status !== 'terminated');
  const total = act.reduce((s, e) => s + e.basic_salary + e.housing_allowance + e.transport_allowance + Object.values(e.other_allowances || {}).reduce((a, v) => a + (Number(v) || 0), 0), 0);
  $('#main').innerHTML = `<div class="page-head"><h1>الموظفون</h1>${can('hr', 'create') ? `<button class="btn primary" id="newe">${icon('plus')}موظف جديد</button>` : ''}<a class="btn secondary" href="#/payroll">مسيرات الرواتب</a></div>
    <div class="grid g3" style="margin-bottom:20px"><div class="card stat"><div class="label">الموظفون النشطون</div><div class="val num">${act.length}</div><div class="xs muted">${act.filter(e => e.is_saudi).length} سعودي · ${act.filter(e => !e.is_saudi).length} غير سعودي</div></div>
      <div class="card stat"><div class="label">إجمالي الرواتب الشهرية</div><div class="val num">${money(total)}</div></div>
      <div class="card stat"><div class="label">نسبة السعودة</div><div class="val num">${act.length ? (act.filter(e => e.is_saudi).length / act.length * 100).toFixed(0) + '%' : '—'}</div></div></div>
    ${es.length ? `<div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>الاسم</th><th>المسمى</th><th>الجنسية</th><th>تاريخ المباشرة</th><th class="amt">الراتب الأساسي</th><th class="amt">الإجمالي</th><th>الحالة</th><th></th></tr></thead><tbody>
      ${es.map(e => `<tr><td><b>${esc(e.full_name)}</b></td><td class="m-sub">${esc(e.job_title || '')}</td><td class="m-hide">${e.is_saudi ? 'سعودي' : 'غير سعودي'}</td><td class="num m-hide">${esc(e.hire_date)}</td>
        <td class="amt num">${money(e.basic_salary)}</td><td class="amt num m-hide">${money(e.basic_salary + e.housing_allowance + e.transport_allowance + Object.values(e.other_allowances || {}).reduce((a, v) => a + (Number(v) || 0), 0))}</td>
        <td>${badge(e.status === 'active' ? ['على رأس العمل', 'b-ok'] : e.status === 'on_leave' ? ['إجازة', 'b-warn'] : ['منتهي', 'b-draft'])}</td><td>${can('hr', 'create') ? `<button class="btn ghost sm" data-edit="${esc(e.id)}">تعديل</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
    : empty('users', 'لا يوجد موظفون بعد', 'أضف موظفيك برواتبهم وبدلاتهم، ويُحسب مسير الرواتب والتأمينات ونهاية الخدمة تلقائياً كل شهر.', can('hr', 'create') ? `<button class="btn primary" id="newe2">${icon('plus')}إضافة موظف</button>` : '')}`;
  const open = e => employeeDrawer(e, ccs);
  ['#newe', '#newe2'].forEach(s => { if ($(s)) $(s).onclick = () => open(null); });
  $$('[data-edit]').forEach(b => b.onclick = () => open(es.find(e => e.id === b.dataset.edit)));
}
function employeeDrawer(e, ccs) {
  e = e || { is_saudi: true, hire_date: riyadhToday(), status: 'active', gosi_enrolled: true, other_allowances: {} };
  const oth = Object.entries(e.other_allowances || {});
  drawer(e.id ? 'تعديل موظف' : 'موظف جديد', `
    ${field('full_name', 'الاسم الكامل', { req: true, value: e.full_name || '' })}
    <div class="form-grid">${field('job_title', 'المسمى الوظيفي', { value: e.job_title || '', help: 'مثل: فني لحام، محاسب' })}${select('is_saudi', 'الجنسية', [['1', 'سعودي'], ['0', 'غير سعودي']], e.is_saudi ? '1' : '0')}
      ${field('national_id', 'رقم الهوية / الإقامة', { value: e.national_id || '', attrs: 'dir="ltr" inputmode="numeric" maxlength="10"' })}${field('phone', 'الجوال', { value: e.phone || '', attrs: 'dir="ltr" inputmode="tel"' })}
      ${field('hire_date', 'تاريخ المباشرة', { type: 'date', value: e.hire_date, req: true })}${select('status', 'الحالة', [['active', 'على رأس العمل'], ['on_leave', 'في إجازة'], ['terminated', 'منتهي الخدمة']], e.status)}</div>
    <fieldset><legend>الراتب الشهري (ر.س)</legend><div class="form-grid">
      ${field('basic_salary', 'الأساسي', { type: 'money', req: true, value: e.basic_salary != null ? money(e.basic_salary) : '' })}${field('housing_allowance', 'بدل السكن', { type: 'money', value: e.housing_allowance ? money(e.housing_allowance) : '', help: 'عادة 25% من الأساسي' })}
      ${field('transport_allowance', 'بدل النقل', { type: 'money', value: e.transport_allowance ? money(e.transport_allowance) : '' })}${field('other', 'بدلات أخرى', { type: 'money', value: oth.length ? money(oth.reduce((a, [, v]) => a + Number(v), 0)) : '', help: 'طعام، طبيعة عمل…' })}</div>
      <label class="row" style="gap:8px"><input type="checkbox" name="gosi_enrolled" ${e.gosi_enrolled ? 'checked' : ''}> مسجّل في التأمينات الاجتماعية</label>
      <p class="help" id="gosihint"></p></fieldset>
    ${field('iban', 'الآيبان (لتحويل الراتب)', { value: e.iban || '', attrs: 'dir="ltr" maxlength="34" placeholder="SA…"' })}
    ${ccs.length ? `<div class="field"><label for="f-cost_center_id">مركز التكلفة / المشروع</label><select class="input" id="f-cost_center_id" name="cost_center_id">${optList(ccs.map(c => [c.id, c.name]), e.cost_center_id, '— بدون —')}</select></div>` : ''}
    ${e.status === 'terminated' || e.end_date ? field('end_date', 'تاريخ انتهاء الخدمة', { type: 'date', value: e.end_date || '' }) : ''}`,
    async v => { const n = k => { const x = toHalalas(v[k] || 0); if (!Number.isFinite(x) || x < 0) throw new AppError('تحقق من مبالغ الراتب'); return x; };
      if (!v.full_name?.trim()) throw new AppError('الاسم مطلوب'); const basic = n('basic_salary'); if (!(basic > 0)) throw new AppError('الراتب الأساسي مطلوب');
      const iban = (v.iban || '').replace(/\s/g, '').toUpperCase(); if (iban && !/^SA\d{22}$/.test(iban)) throw new AppError('الآيبان السعودي يبدأ بـ SA ويتكون من 24 خانة');
      const other = n('other');
      await api.saveEmployee({ ...(e.id ? { id: e.id } : {}), full_name: v.full_name.trim(), job_title: v.job_title || null, is_saudi: v.is_saudi === '1', national_id: toLatin(v.national_id) || null, phone: toLatin(v.phone) || null,
        hire_date: v.hire_date, status: v.status, basic_salary: basic, housing_allowance: n('housing_allowance'), transport_allowance: n('transport_allowance'), other_allowances: other ? { other } : {},
        gosi_enrolled: !!v.gosi_enrolled, iban: iban || null, cost_center_id: v.cost_center_id || null, end_date: v.status === 'terminated' ? (v.end_date || riyadhToday()) : (v.end_date || null) });
      toast('تم حفظ الموظف'); employeesView(); });
  const hint = () => { const b = toHalalas($('#f-basic_salary').value || 0) || 0, h = toHalalas($('#f-housing_allowance').value || 0) || 0, base = Math.min(b + h, 4500000), sa = $('#f-is_saudi').value === '1';
    $('#gosihint').textContent = $('[name=gosi_enrolled]').checked ? (sa ? `التأمينات: على الموظف ${money(base * 0.0975)} · على المنشأة ${money(base * 0.1175)}` : `التأمينات (أخطار مهنية): على المنشأة ${money(base * 0.02)}`) : ''; };
  ['#f-basic_salary', '#f-housing_allowance', '#f-is_saudi', '[name=gosi_enrolled]'].forEach(s => $(s)?.addEventListener('input', hint)); $('#f-is_saudi').addEventListener('change', hint); hint();
}

// ---------- payroll ----------
const PAYST = { draft: ['مسودة', 'b-draft'], posted: ['مرحّل — لم يُصرف', 'b-warn'], paid: ['مصروف', 'b-ok'] };
async function payrollListView() {
  shell('payroll', loading()); const runs = await api.listPayrollRuns(); const t = riyadhToday();
  $('#main').innerHTML = `<div class="page-head"><h1>مسيرات الرواتب</h1><a class="btn secondary" href="#/employees">${icon('users')}الموظفون</a>
      ${can('hr', 'create') ? `<form id="newrun" class="row" style="gap:8px"><input class="input" type="month" id="f-month" value="${t.slice(0, 7)}" aria-label="الشهر" style="height:38px;width:auto"><button class="btn primary" type="submit">${icon('plus')}إعداد مسير الشهر</button></form>` : ''}</div>
    <p class="muted" style="margin:-8px 0 16px">يُحسب لكل موظف: الراتب والبدلات، التأمينات الاجتماعية (حصة الموظف والمنشأة)، ومخصص مكافأة نهاية الخدمة. أضف الإضافي والخصومات ثم رحّل واصرف.</p>
    ${runs.length ? `<div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>الشهر</th><th>الرقم</th><th class="amt">إجمالي الرواتب</th><th class="amt">التأمينات</th><th class="amt">صافي المستحق</th><th>الحالة</th></tr></thead><tbody>
      ${runs.map(r => `<tr class="click" data-href="#/payroll/${esc(r.id)}"><td><a class="rowlink" href="#/payroll/${esc(r.id)}">${monthName(r.period_month)}</a></td><td class="num m-hide">${esc(r.number || '—')}</td><td class="amt num">${money(r.total_gross)}</td><td class="amt num m-hide">${money(r.total_gosi)}</td><td class="amt num">${money(r.total_net)}</td>
        <td>${r.status === 'draft' && r.submitted_at ? badge(['بانتظار الاعتماد', 'b-warn']) : badge(PAYST[r.status])}</td></tr>`).join('')}</tbody></table></div>`
    : empty('users', 'لا توجد مسيرات بعد', 'أضف الموظفين أولاً، ثم اختر الشهر واضغط «إعداد مسير الشهر».', '<a class="btn secondary" href="#/employees">الموظفون</a>')}`;
  if ($('#newrun')) $('#newrun').onsubmit = async e => { e.preventDefault(); const b = $('[type=submit]', e.target); b.disabled = true;
    try { const id = await api.preparePayroll($('#f-month').value + '-01'); location.hash = '#/payroll/' + id; } catch (x) { fail(x); b.disabled = false; } };
}
async function payrollRunView(id) {
  shell('payroll', loading()); const [r, accs] = await Promise.all([api.getPayrollRun(id), api.listAccounts()]);
  const draft = r.status === 'draft', edit = draft && can('hr', 'create'), canPost = can('hr', 'post');
  const pa = accs.filter(a => a.is_postable && ['bank', 'cash'].includes(a.system_key));
  const T = k => r.payslips.reduce((s, p) => s + Number(p[k]), 0);
  $('#main').innerHTML = `<a class="crumb no-print" href="#/payroll">${icon('chev')} مسيرات الرواتب</a>
    <div class="page-head no-print"><h1>رواتب ${monthName(r.period_month)}</h1>${r.status === 'draft' && r.submitted_at ? badge(['بانتظار الاعتماد', 'b-warn']) : badge(PAYST[r.status])}
      <button class="btn secondary" onclick="window.print()">${icon('down')}طباعة</button><button class="btn secondary" id="csvp">${icon('down')}ملف التحويل (CSV)</button>
      ${edit ? '<button class="btn secondary" id="refresh">تحديث من بيانات الموظفين</button>' : ''}
      ${edit && !canPost && !r.submitted_at ? '<button class="btn secondary" id="submitp">إرسال للاعتماد</button>' : ''}
      ${draft && canPost ? '<button class="btn primary" id="postp">اعتماد وترحيل القيد</button>' : ''}
      ${r.status === 'posted' && canPost ? '<button class="btn primary" id="payp">صرف الرواتب</button>' : ''}</div>
    ${edit ? `<label class="row no-print" style="gap:8px;margin-bottom:12px"><input type="checkbox" id="eosb" ${r.include_eosb ? 'checked' : ''}> احتساب مخصص مكافأة نهاية الخدمة لهذا الشهر</label>` : ''}
    <div class="grid g4" style="margin-bottom:16px">${[['إجمالي الرواتب', r.total_gross], ['التأمينات (موظف + منشأة)', r.total_gosi], ['مخصص نهاية الخدمة', r.total_eosb], ['صافي المستحق للموظفين', r.total_net]].map(([t, v]) => `<div class="card stat"><div class="label">${t}</div><div class="val num">${money(v)}</div></div>`).join('')}</div>
    <div class="tbl-wrap editor"><table class="rep-tbl" id="pst"><thead><tr><th>الموظف</th><th class="amt">الراتب والبدلات</th><th style="width:120px">إضافي / مكافأة</th><th style="width:120px">خصم / سلفة</th><th class="amt">تأمينات الموظف</th><th class="amt m-hide">تأمينات المنشأة</th><th class="amt m-hide">نهاية الخدمة</th><th class="amt">الصافي</th><th class="m-hide">ملاحظة</th></tr></thead><tbody>
      ${r.payslips.map(p => `<tr data-p="${esc(p.id)}"><td><b>${esc(p.employees?.full_name)}</b><div class="xs muted">${esc(p.employees?.job_title || '')}${p.employees?.is_saudi ? ' · سعودي' : ''}</div></td><td class="amt num">${money(p.gross)}</td>
        <td>${edit ? `<input class="input num" data-k="additions" inputmode="decimal" value="${p.additions ? money(p.additions) : ''}" placeholder="0.00" aria-label="إضافي">` : `<span class="num">${money(p.additions)}</span>`}</td>
        <td>${edit ? `<input class="input num" data-k="deductions" inputmode="decimal" value="${p.deductions ? money(p.deductions) : ''}" placeholder="0.00" aria-label="خصم">` : `<span class="num">${money(p.deductions)}</span>`}</td>
        <td class="amt num">${money(p.gosi_employee)}</td><td class="amt num m-hide">${money(p.gosi_employer)}</td><td class="amt num m-hide">${money(p.eosb)}</td><td class="amt num"><b>${money(p.net)}</b></td>
        <td class="m-hide">${edit ? `<input class="input" data-k="note" value="${esc(p.note || '')}" aria-label="ملاحظة">` : esc(p.note || '')}</td></tr>`).join('')}
      <tr class="grand"><td>الإجمالي (${r.payslips.length} موظف)</td><td class="amt num">${money(T('gross'))}</td><td class="amt num">${money(T('additions'))}</td><td class="amt num">${money(T('deductions'))}</td><td class="amt num">${money(T('gosi_employee'))}</td><td class="amt num m-hide">${money(T('gosi_employer'))}</td><td class="amt num m-hide">${money(T('eosb'))}</td><td class="amt num">${money(T('net'))}</td><td class="m-hide"></td></tr></tbody></table></div>
    ${!r.payslips.length ? '<p class="note warn" style="margin-top:12px">لا يوجد موظفون نشطون في هذا الشهر. أضف الموظفين ثم اضغط «تحديث من بيانات الموظفين».</p>' : ''}
    ${edit ? '<p class="xs muted no-print" style="margin-top:8px">تُحفظ التعديلات تلقائياً عند الخروج من الخانة.</p>' : ''}
    ${draft && edit ? '<button class="btn ghost no-print" id="delp" style="color:var(--c-danger);margin-top:12px">حذف المسودة</button>' : ''}
    <div id="payw" hidden class="card no-print" style="margin-top:16px;max-width:520px"><h3>صرف الرواتب</h3><div class="form-grid">
      ${select('pay_acc', 'من حساب', pa.map(a => [a.id, `${a.code} — ${a.name_ar}`]), pa.find(a => a.system_key === 'bank')?.id)}${field('pay_date', 'تاريخ الصرف', { type: 'date', value: riyadhToday() })}</div>
      <button class="btn primary" id="payok">تأكيد صرف <span class="num">${money(r.total_net)}</span></button></div>`;
  $('#pst').addEventListener('change', async e => { const tr = e.target.closest('tr[data-p]'); if (!tr || !edit) return;
    const g = k => $(`[data-k=${k}]`, tr).value, a = toHalalas(g('additions') || 0), d = toHalalas(g('deductions') || 0);
    if (!Number.isFinite(a) || !Number.isFinite(d) || a < 0 || d < 0) return toast('مبلغ غير صحيح', 'bad');
    try { await api.updatePayslip(tr.dataset.p, a, d, g('note')); payrollRunView(id); } catch (x) { fail(x); } });
  const act = (sel, fn, msg) => { if ($(sel)) $(sel).onclick = async ev => { ev.target.disabled = true; try { await fn(); toast(msg); payrollRunView(id); } catch (x) { fail(x); ev.target.disabled = false; } }; };
  act('#refresh', () => api.preparePayroll(r.period_month), 'تم التحديث');
  act('#submitp', () => api.setPayrollOptions(id, null, true), 'أُرسل للاعتماد');
  act('#postp', () => api.postPayroll(id), 'تم ترحيل قيد الرواتب');
  act('#payok', () => api.payPayroll(id, $('#f-pay_acc').value, $('#f-pay_date').value), 'تم صرف الرواتب');
  if ($('#eosb')) $('#eosb').onchange = async e => { try { await api.setPayrollOptions(id, e.target.checked, false); payrollRunView(id); } catch (x) { fail(x); } };
  if ($('#payp')) $('#payp').onclick = () => { $('#payw').hidden = false; $('#payw').scrollIntoView({ behavior: 'smooth' }); };
  if ($('#delp')) $('#delp').onclick = async e => { if (!confirmBtn(e.target)) return; try { await api.deletePayroll(id); toast('حُذفت المسودة'); location.hash = '#/payroll'; } catch (x) { fail(x); } };
  $('#csvp').onclick = () => { const rows = [['الاسم', 'الآيبان', 'صافي الراتب', 'ملاحظة'], ...r.payslips.map(p => [p.employees?.full_name, p.employees?.iban || '', (p.net / 100).toFixed(2), p.note || ''])];
    const blob = new Blob(['﻿' + rows.map(x => x.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `رواتب ${r.period_month.slice(0, 7)}.csv`; document.body.append(a); a.click(); a.remove(); };
}

const REPORT_ROUTES = [
  [/^#\/reports(?:\/(\w+))?(\?.*)?$/, gate('reports', 'التقارير', 'reports', m => reportsView(m[1], new URLSearchParams((m[2] || '').slice(1))))],
  [/^#\/employees$/, gate('employees', 'الموظفون', 'hr', employeesView)],
  [/^#\/payroll$/, gate('payroll', 'الرواتب', 'hr', payrollListView)],
  [/^#\/payroll\/([\w-]+)$/, gate('payroll', 'الرواتب', 'hr', m => payrollRunView(m[1]))],
];
