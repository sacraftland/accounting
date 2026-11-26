// =====================================================================
// Report builder: pick a data source, columns, filters, grouping with
// totals / averages / counts, a pivot by month (or any field), sorting
// and top-N; see it as a table and a bar chart; export to Excel / CSV /
// print; save, pin, start from ready templates, or ask an AI to write the
// definition (copy the prompt, paste the reply). Inserted after backup.js.
// =====================================================================
const RB_L = { date: ['التاريخ', 'date'], month: ['الشهر', 'month'], number: ['رقم المستند', 'text'], doc_kind: ['نوع المستند', 'text'], party: ['العميل', 'text'], party_city: ['المدينة', 'text'],
  item: ['الصنف', 'text'], sku: ['رمز الصنف', 'text'], item_kind: ['نوع الصنف', 'text'], qty: ['الكمية', 'qty'], net: ['الصافي قبل الضريبة', 'money'], vat: ['الضريبة', 'money'], total: ['الإجمالي', 'money'],
  cost: ['التكلفة', 'money'], profit: ['الربح', 'money'], branch: ['الفرع', 'text'], cost_center: ['المشروع / مركز التكلفة', 'text'], payment_status: ['حالة السداد', 'text'], paid: ['المدفوع', 'money'],
  open: ['المتبقي', 'money'], due_date: ['تاريخ الاستحقاق', 'date'], days_late: ['أيام التأخير', 'int'], account: ['الحساب', 'text'], description: ['البيان', 'text'], employee: ['الموظف', 'text'],
  amount: ['المبلغ', 'money'], entry_no: ['رقم القيد', 'int'], account_code: ['رمز الحساب', 'text'], account_type: ['نوع الحساب', 'text'], debit: ['مدين', 'money'], credit: ['دائن', 'money'], memo: ['البيان', 'text'],
  warehouse: ['المستودع', 'text'], move_type: ['نوع الحركة', 'text'], qty_in: ['وارد', 'qty'], qty_out: ['صادر', 'qty'], value: ['القيمة', 'money'], unit: ['الوحدة', 'text'], sale_price: ['سعر البيع', 'money'],
  avg_cost: ['متوسط التكلفة', 'money'], on_hand: ['الرصيد', 'qty'], stock_value: ['قيمة المخزون', 'money'], active: ['الحالة', 'text'], party_kind: ['النوع', 'text'], phone: ['الجوال', 'text'], vat_number: ['الرقم الضريبي', 'text'],
  receivable: ['مستحق منه', 'money'], payable: ['مستحق له', 'money'], code: ['الرمز', 'text'], project: ['المشروع', 'text'], project_type: ['نوع المشروع', 'text'], status: ['الحالة', 'text'], start_date: ['البداية', 'date'],
  contract_value: ['قيمة العقد', 'money'], revenue: ['الإيرادات', 'money'], materials: ['المواد', 'money'], expenses: ['المصروفات', 'money'], job_title: ['المهنة', 'text'], task: ['المهمة', 'text'], hours: ['الساعات', 'qty'],
  rate: ['أجر الساعة', 'money'], posted: ['الترحيل', 'text'], gross: ['إجمالي الراتب', 'money'], additions: ['الإضافات', 'money'], deductions: ['الخصومات', 'money'], gosi_employee: ['تأمينات الموظف', 'money'],
  gosi_employer: ['تأمينات المنشأة', 'money'], phase: ['المرحلة', 'text'], priority: ['الأولوية', 'text'], done_date: ['تاريخ الإنجاز', 'date'], late: ['التأخير', 'text'], est_hours: ['الساعات المقدرة', 'qty'], workers: ['عدد العمال', 'int'] };
const rbF = (...keys) => keys.map(k => { const [key, over] = k.split(':'); return [key, over || RB_L[key][0], RB_L[key][1]]; });
const RB_DS = {
  sales_lines: { t: 'بنود المبيعات', perm: 'sales', hint: 'كل سطر في الفواتير، والإشعارات الدائنة بالسالب. فيه التكلفة والربح لكل سطر.',
    f: rbF('date', 'month', 'number', 'doc_kind', 'party', 'party_city:مدينة العميل', 'item', 'sku', 'item_kind', 'qty', 'net', 'vat', 'total', 'cost', 'profit', 'branch', 'cost_center', 'payment_status') },
  sales_docs: { t: 'فواتير المبيعات', perm: 'sales', hint: 'فاتورة لكل سطر مع المدفوع والمتبقي وأيام التأخير.',
    f: rbF('date', 'month', 'number', 'doc_kind', 'party', 'party_city:مدينة العميل', 'net', 'vat', 'total', 'paid', 'open', 'due_date', 'days_late', 'payment_status', 'branch', 'cost_center') },
  purchase_lines: { t: 'بنود المشتريات', perm: 'purchases', hint: 'كل سطر في فواتير المشتريات، والمرتجعات بالسالب.', f: rbF('date', 'month', 'number', 'doc_kind', 'party:المورد', 'item', 'sku', 'qty', 'net', 'vat', 'total', 'cost_center', 'branch') },
  expenses: { t: 'المصروفات', perm: 'expenses', hint: 'سندات الصرف المعتمدة.', f: rbF('date', 'month', 'number', 'account', 'description', 'party:المورد', 'employee', 'cost_center', 'branch', 'amount', 'vat', 'total') },
  journal: { t: 'القيود اليومية', perm: 'accounting', hint: 'كل سطر في القيود المرحّلة — أشمل مصدر: يغطي كل الحسابات.', f: rbF('date', 'month', 'entry_no', 'account_code', 'account', 'account_type', 'cost_center', 'party:الطرف', 'debit', 'credit', 'net:الصافي (مدين − دائن)', 'memo') },
  stock_moves: { t: 'حركات المخزون', perm: 'inventory', hint: 'كل حركة وارد وصادر بالكمية والقيمة.', f: rbF('date', 'month', 'item', 'sku', 'warehouse', 'move_type', 'qty_in', 'qty_out', 'qty:الصافي', 'value') },
  items: { t: 'الأصناف والأرصدة', perm: 'inventory', snap: true, hint: 'رصيد وقيمة كل صنف كما في تاريخ النهاية.', f: rbF('item', 'sku', 'item_kind', 'unit', 'sale_price', 'avg_cost', 'on_hand', 'stock_value', 'active') },
  parties: { t: 'العملاء والموردون', perm: 'sales|purchases', snap: true, hint: 'أرصدة كل طرف كما في تاريخ النهاية.', f: rbF('party:الاسم', 'party_kind', 'party_city', 'phone', 'vat_number', 'receivable', 'payable') },
  projects: { t: 'المشاريع', perm: 'accounting|reports|manufacturing', hint: 'إيرادات وتكاليف وربح كل مشروع خلال الفترة.', f: rbF('code', 'project', 'project_type', 'status', 'party', 'start_date', 'due_date', 'contract_value', 'revenue', 'materials', 'expenses', 'profit') },
  timesheets: { t: 'ساعات العمل', perm: 'hr|manufacturing|accounting', hint: 'ساعات العمال على المشاريع وتكلفتها.', f: rbF('date', 'month', 'project', 'employee', 'job_title', 'task', 'hours', 'rate', 'amount:التكلفة', 'posted') },
  payslips: { t: 'الرواتب', perm: 'hr', hint: 'قسائم المسيرات المعتمدة.', f: rbF('month', 'employee', 'job_title', 'gross', 'additions', 'deductions', 'gosi_employee', 'gosi_employer', 'net:صافي الراتب') },
  tasks: { t: 'المهام', perm: null, hint: 'المهام المفتوحة وما يستحق خلال الفترة.', f: rbF('task', 'project', 'phase', 'status', 'priority', 'start_date', 'due_date', 'done_date', 'late', 'est_hours', 'workers') },
};
const RB_NUM = ['money', 'qty', 'int'], RB_AGG = { sum: 'المجموع', avg: 'المتوسط', count: 'العدد', min: 'الأقل', max: 'الأعلى' };
const RB_OPS = { eq: 'يساوي', neq: 'لا يساوي', has: 'يحتوي', nhas: 'لا يحتوي', gt: 'أكبر من', gte: 'أكبر أو يساوي', lt: 'أقل من', lte: 'أقل أو يساوي', empty: 'فارغ', nempty: 'غير فارغ' };
const rbOk = k => { const d = RB_DS[k]; return d && (!d.perm || d.perm.split('|').some(m => can(m))); };
const rbDef = (ds = 'sales_lines') => ({ name: '', ds, period: 'this-month', from: '', to: '', columns: RB_DS[ds].f.slice(0, 8).map(f => f[0]), filters: [], group: [], measures: [], pivot: '', sort: null, limit: 0 });
const RB_TPL = [
  ['مبيعات حسب العميل', { ds: 'sales_lines', period: 'this-y', group: ['party'], measures: [{ f: 'net', agg: 'sum' }, { f: 'profit', agg: 'sum' }, { f: '*', agg: 'count' }], sort: { f: 'net', dir: 'desc' } }],
  ['ربحية الأصناف', { ds: 'sales_lines', period: 'this-y', group: ['item'], measures: [{ f: 'qty', agg: 'sum' }, { f: 'net', agg: 'sum' }, { f: 'cost', agg: 'sum' }, { f: 'profit', agg: 'sum' }], sort: { f: 'profit', dir: 'desc' } }],
  ['مبيعات العملاء شهراً بشهر', { ds: 'sales_lines', period: 'this-y', group: ['party'], pivot: 'month', measures: [{ f: 'net', agg: 'sum' }] }],
  ['الفواتير المتأخرة', { ds: 'sales_docs', period: 'this-y', columns: ['number', 'date', 'party', 'total', 'open', 'due_date', 'days_late'], filters: [{ f: 'days_late', op: 'gt', v: '0' }], sort: { f: 'days_late', dir: 'desc' } }],
  ['المشتريات حسب المورد', { ds: 'purchase_lines', period: 'this-y', group: ['party'], measures: [{ f: 'net', agg: 'sum' }, { f: 'vat', agg: 'sum' }], sort: { f: 'net', dir: 'desc' } }],
  ['المصروفات حسب الحساب والمشروع', { ds: 'expenses', period: 'this-y', group: ['account', 'cost_center'], measures: [{ f: 'amount', agg: 'sum' }], sort: { f: 'amount', dir: 'desc' } }],
  ['المصروفات شهرياً', { ds: 'journal', period: 'this-y', group: ['account'], pivot: 'month', measures: [{ f: 'net', agg: 'sum' }], filters: [{ f: 'account_type', op: 'eq', v: 'مصروفات' }] }],
  ['ربحية المشاريع', { ds: 'projects', period: 'this-y', columns: ['code', 'project', 'project_type', 'status', 'party', 'revenue', 'materials', 'expenses', 'profit'], sort: { f: 'profit', dir: 'desc' } }],
  ['ساعات العمال حسب المشروع', { ds: 'timesheets', period: 'this-month', group: ['employee', 'project'], measures: [{ f: 'hours', agg: 'sum' }, { f: 'amount', agg: 'sum' }] }],
  ['حركة المخزون حسب الصنف', { ds: 'stock_moves', period: 'this-month', group: ['item'], measures: [{ f: 'qty_in', agg: 'sum' }, { f: 'qty_out', agg: 'sum' }, { f: 'value', agg: 'sum' }] }],
  ['أرصدة العملاء', { ds: 'parties', columns: ['party', 'party_city', 'phone', 'receivable'], filters: [{ f: 'receivable', op: 'gt', v: '0' }], sort: { f: 'receivable', dir: 'desc' } }],
  ['تكلفة الرواتب شهرياً', { ds: 'payslips', period: 'this-y', group: ['month'], measures: [{ f: 'gross', agg: 'sum' }, { f: 'gosi_employer', agg: 'sum' }, { f: 'net', agg: 'sum' }] }],
  ['المهام المتأخرة', { ds: 'tasks', columns: ['task', 'project', 'phase', 'due_date', 'priority', 'workers'], filters: [{ f: 'late', op: 'eq', v: 'متأخرة' }], sort: { f: 'due_date', dir: 'asc' } }],
];
const rbTpl = i => { const [name, d] = RB_TPL[i]; const base = rbDef(d.ds); return { ...base, columns: d.columns || base.columns, ...d, name }; };
const rbPeriod = d => { if (RB_DS[d.ds]?.snap) return ['2000-01-01', d.to || riyadhToday()];
  if (d.period === 'custom' && d.from && d.to) return [d.from, d.to]; const p = periodPresets().find(x => x[0] === d.period) || periodPresets()[0]; return [p[2], p[3]]; };
// normalise any definition (saved, template, or written by an AI) against the catalogue
function rbClean(x) {
  const ds = RB_DS[x?.ds] ? x.ds : 'sales_lines', F = Object.fromEntries(RB_DS[ds].f.map(f => [f[0], f])), d = rbDef(ds);
  const has = k => !!F[k], num = k => has(k) && RB_NUM.includes(F[k][2]);
  d.name = String(x?.name || '').slice(0, 200);
  d.period = ['custom', ...periodPresets().map(p => p[0])].includes(x?.period) ? x.period : 'this-month';
  d.from = /^\d{4}-\d{2}-\d{2}$/.test(x?.from || '') ? x.from : ''; d.to = /^\d{4}-\d{2}-\d{2}$/.test(x?.to || '') ? x.to : '';
  if (Array.isArray(x?.columns)) { const c = x.columns.filter(has); if (c.length) d.columns = [...new Set(c)]; }
  d.group = (Array.isArray(x?.group) ? x.group : []).filter(has).slice(0, 2);
  d.measures = (Array.isArray(x?.measures) ? x.measures : []).filter(m => m && RB_AGG[m.agg] && (m.f === '*' ? m.agg === 'count' : num(m.f))).slice(0, 6).map(m => ({ f: m.f, agg: m.agg }));
  if (d.group.length && !d.measures.length) d.measures = [{ f: '*', agg: 'count' }];
  d.pivot = d.group.length && has(x?.pivot) && !d.group.includes(x.pivot) ? x.pivot : '';
  d.filters = (Array.isArray(x?.filters) ? x.filters : []).filter(f => f && has(f.f) && RB_OPS[f.op]).slice(0, 10).map(f => ({ f: f.f, op: f.op, v: String(f.v ?? '').slice(0, 200) }));
  d.sort = x?.sort && (has(x.sort.f) || d.measures.some(m => rbMKey(m) === x.sort.f || m.f === x.sort.f)) ? { f: x.sort.f, dir: x.sort.dir === 'asc' ? 'asc' : 'desc' } : null;
  d.limit = Math.max(0, Math.min(1000, parseInt(x?.limit) || 0));
  return d;
}
const rbMKey = m => m.f === '*' ? 'count' : m.agg + ':' + m.f;
const rbMLabel = (m, F) => m.f === '*' ? 'عدد السجلات' : `${RB_AGG[m.agg]} ${F[m.f][1]}`;

// ---------- the engine ----------
function rbCompute(d, rows) {
  const F = Object.fromEntries(RB_DS[d.ds].f.map(f => [f[0], f]));
  const test = (val, fl) => { const t = F[fl.f][2], isNum = RB_NUM.includes(t);
    if (fl.op === 'empty') return val == null || val === ''; if (fl.op === 'nempty') return !(val == null || val === '');
    if (isNum) { const n = Number(toLatin(fl.v).replace(/,/g, '')) * (t === 'money' ? 100 : 1), v = Number(val) || 0; if (!Number.isFinite(n)) return true;
      return { eq: v === n, neq: v !== n, gt: v > n, gte: v >= n, lt: v < n, lte: v <= n, has: String(val).includes(fl.v), nhas: !String(val).includes(fl.v) }[fl.op]; }
    const a = String(val ?? ''), b = fl.v;
    return { eq: a === b, neq: a !== b, has: a.includes(b), nhas: !a.includes(b), gt: a > b, gte: a >= b, lt: a < b, lte: a <= b }[fl.op]; };
  let r = rows.filter(x => d.filters.every(fl => test(x[fl.f], fl)));
  const n = r.length;
  let cols, out;
  if (!d.group.length) {
    cols = d.columns.map(k => ({ k, label: F[k][1], type: F[k][2] }));
    out = r.map(x => cols.map(c => x[c.k]));
  } else {
    const ms = d.measures, acc = new Map(), pv = d.pivot ? [...new Set(r.map(x => String(x[d.pivot] ?? '—')))].sort() : null;
    const blank = () => ms.map(() => ({ s: 0, c: 0, mn: Infinity, mx: -Infinity }));
    const add = (a, x) => ms.forEach((m, i) => { const v = m.f === '*' ? 1 : Number(x[m.f]) || 0; a[i].s += v; a[i].c++; a[i].mn = Math.min(a[i].mn, v); a[i].mx = Math.max(a[i].mx, v); });
    const val = (a, m) => m.agg === 'count' ? a.c : m.agg === 'sum' ? a.s : m.agg === 'avg' ? (a.c ? a.s / a.c : 0) : m.agg === 'min' ? (a.c ? a.mn : 0) : (a.c ? a.mx : 0);
    for (const x of r) { const key = JSON.stringify(d.group.map(g => x[g] ?? '—'));
      let g = acc.get(key); if (!g) acc.set(key, g = { keys: d.group.map(g2 => x[g2] ?? '—'), all: blank(), pv: {} });
      add(g.all, x); if (pv) add(g.pv[String(x[d.pivot] ?? '—')] ||= blank(), x); }
    const mt = m => m.f === '*' || m.agg === 'count' ? 'int' : F[m.f][2];
    cols = d.group.map(k => ({ k, label: F[k][1], type: F[k][2] }));
    if (pv) { const m = ms[0]; cols.push(...pv.map(p => ({ k: 'pv:' + p, label: F[d.pivot][2] === 'month' ? monthName(p + '-01') : p, type: mt(m) })), { k: rbMKey(m), label: 'الإجمالي', type: mt(m) });
      out = [...acc.values()].map(g => [...g.keys, ...pv.map(p => g.pv[p] ? val(g.pv[p][0], m) : 0), val(g.all[0], m)]); }
    else { cols.push(...ms.map(m => ({ k: rbMKey(m), label: rbMLabel(m, F), type: mt(m), agg: m.agg })));
      out = [...acc.values()].map(g => [...g.keys, ...ms.map((m, i) => val(g.all[i], m))]); }
  }
  if (d.sort) { const i = cols.findIndex(c => c.k === d.sort.f || c.k.endsWith(':' + d.sort.f)), dir = d.sort.dir === 'asc' ? 1 : -1;
    if (i >= 0) out.sort((a, b) => { const x = a[i], y = b[i]; return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''), 'ar')) * dir; }); }
  else if (d.group.length) { const i = d.group.length; out.sort((a, b) => ['month', 'date'].includes(cols[0].type) ? String(a[0]).localeCompare(String(b[0])) : (Number(b[i]) || 0) - (Number(a[i]) || 0)); }
  if (d.limit) out = out.slice(0, d.limit);
  const total = cols.map((c, i) => RB_NUM.includes(c.type) && !['avg', 'min', 'max'].includes(c.agg) && !['days_late', 'entry_no', 'workers', 'sale_price', 'avg_cost', 'rate'].includes(c.k) ? out.reduce((s, row) => s + (Number(row[i]) || 0), 0) : null);
  return { cols, rows: out, total, n };
}
const rbFmt = (v, t) => v == null || v === '' ? '' : t === 'money' ? money(v) : t === 'qty' ? fq(v) : t === 'int' ? Number(v).toLocaleString('en-US') : t === 'month' ? monthName(v + '-01') : String(v);
function rbChart(res) {
  const ok = c => RB_NUM.includes(c.type) && !c.k.startsWith('pv:'), m1 = res.cols.findIndex(c => ok(c) && c.type === 'money'), vi = m1 > 0 ? m1 : res.cols.findIndex(ok), li = 0;
  if (vi < 1 || res.rows.length < 2) return '';
  const rows = res.rows.slice(0, 15), mx = Math.max(1, ...rows.map(r => Math.abs(Number(r[vi]) || 0))), c = res.cols[vi];
  return `<figure class="rb-chart" aria-label="رسم: ${esc(c.label)} حسب ${esc(res.cols[li].label)}"><figcaption class="xs muted">${esc(c.label)} حسب ${esc(res.cols[li].label)}${res.rows.length > 15 ? ' — أعلى 15' : ''}</figcaption>
    ${rows.map(r => { const v = Number(r[vi]) || 0; return `<div class="rb-bar" title="${esc(rbFmt(r[li], res.cols[li].type))}: ${esc(rbFmt(v, c.type))}"><span class="rb-l">${esc(rbFmt(r[li], res.cols[li].type))}</span><span class="rb-t"><i class="${v < 0 ? 'neg' : ''}" style="width:${(Math.abs(v) / mx * 100).toFixed(1)}%"></i></span><span class="rb-v num">${esc(rbFmt(v, c.type))}</span></div>`; }).join('')}</figure>`;
}

// ---------- home: saved reports + templates ----------
async function reportBuilderHome() {
  shell('report-builder', loading());
  const saved = await api.listReports().catch(() => []), ed = can('reports', 'create');
  const okSaved = saved.filter(s => rbOk(s.definition?.ds));
  $('#main').innerHTML = `<div class="page-head"><h1>منشئ التقارير</h1>${ed ? `<a class="btn primary" href="#/report-builder/new">${icon('plus')}تقرير جديد</a>` : ''}</div>
    <p class="muted" style="margin:-8px 0 16px">اختر مصدر البيانات والأعمدة والفلاتر والتجميع، واحفظ التقرير ليرجع لك بضغطة — بأرقام محدثة كل مرة. يمكن تصديره إلى Excel أو طباعته.</p>
    <h3>تقاريري المحفوظة</h3>${okSaved.length ? `<div class="grid g3" style="margin-bottom:24px">${okSaved.map(s => `<a class="card rb-card" href="#/report-builder/${esc(s.id)}"><b>${s.pinned ? '★ ' : ''}${esc(s.name)}</b><span class="xs muted">${esc(RB_DS[s.definition.ds].t)}${s.definition.group?.length ? ' · مجمّع' : ''}</span></a>`).join('')}</div>`
      : `<p class="muted" style="margin-bottom:24px">لا توجد تقارير محفوظة بعد — ابدأ من قالب أو تقرير جديد.</p>`}
    <h3>قوالب جاهزة</h3><div class="grid g3">${RB_TPL.map(([n, d], i) => rbOk(d.ds) ? `<a class="card rb-card" href="#/report-builder/new?t=${i}"><b>${esc(n)}</b><span class="xs muted">${esc(RB_DS[d.ds].t)}</span></a>` : '').join('')}</div>`;
}

// ---------- the builder ----------
const RB_CACHE = new Map();
async function reportBuilderView(id, qs) {
  shell('report-builder', loading());
  const ed = can('reports', 'create');
  let rec = null, d;
  if (id && id !== 'new') { rec = await api.getReport(id); d = rbClean({ ...rec.definition, name: rec.name }); }
  else { const t = qs?.get('t'); d = t != null && RB_TPL[+t] ? rbClean(rbTpl(+t)) : rbClean(rbDef(Object.keys(RB_DS).find(rbOk) || 'tasks')); }
  if (!rbOk(d.ds)) { $('#main').innerHTML = empty('lock', 'ليست لديك صلاحية على مصدر هذا التقرير', 'اطلب من المالك صلاحية القسم المرتبط بالتقرير.'); return; }
  let res = null, rows = [];
  const F = () => Object.fromEntries(RB_DS[d.ds].f.map(f => [f[0], f]));
  const opts = (list, cur, blank) => (blank ? `<option value="">${blank}</option>` : '') + list.map(([v, t]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(t)}</option>`).join('');
  const drawCfg = () => {
    const f = RB_DS[d.ds].f, nums = f.filter(x => RB_NUM.includes(x[2])), snap = RB_DS[d.ds].snap;
    $('#rbcfg').innerHTML = `
      ${field('rbname', 'اسم التقرير', { value: d.name, attrs: `maxlength="200" placeholder="مثل: مبيعات الكرفانات حسب المدينة" ${ed ? '' : 'readonly'}` })}
      <div class="field"><label for="rbds">مصدر البيانات</label><select class="input" id="rbds">${opts(Object.entries(RB_DS).filter(([k]) => rbOk(k)).map(([k, v]) => [k, v.t]), d.ds)}</select><span class="help">${esc(RB_DS[d.ds].hint)}</span></div>
      ${snap ? field('rbto', 'كما في تاريخ', { type: 'date', value: d.to || riyadhToday() }) : `<div class="field"><label for="rbper">الفترة</label><select class="input" id="rbper">${opts([...periodPresets().map(p => [p[0], p[1]]), ['custom', 'فترة محددة']], d.period)}</select></div>
        ${d.period === 'custom' ? `<div class="form-grid">${field('rbfrom', 'من', { type: 'date', value: d.from })}${field('rbto', 'إلى', { type: 'date', value: d.to })}</div>` : ''}`}
      <fieldset><legend>التجميع</legend><div class="form-grid">${[0, 1].map(i => `<div class="field"><label for="rbg${i}">${i ? 'ثم حسب' : 'جمّع حسب'}</label><select class="input" id="rbg${i}" ${i && !d.group[0] ? 'disabled' : ''}>${opts(f.filter(x => !RB_NUM.includes(x[2]) || x[2] === 'int').map(x => [x[0], x[1]]), d.group[i] || '', i ? '—' : 'بدون (عرض السجلات)')}</select></div>`).join('')}</div>
        ${d.group.length ? `<div class="grid" style="gap:6px">${d.measures.map((m, i) => `<div class="rb-m"><select class="input" data-ma="${i}" aria-label="العملية">${opts(Object.entries(RB_AGG), m.agg)}</select><select class="input" data-mf="${i}" aria-label="الحقل">${opts([['*', 'عدد السجلات'], ...nums.map(x => [x[0], x[1]])], m.f)}</select><button type="button" class="btn ghost icon sm" data-mdel="${i}" aria-label="حذف">${icon('x')}</button></div>`).join('')}
          <button type="button" class="btn ghost sm" id="rbmadd" style="justify-self:start">${icon('plus')}إضافة قيمة</button></div>
          <div class="field" style="margin-top:8px"><label for="rbpv">توزيع على أعمدة حسب</label><select class="input" id="rbpv">${opts(f.filter(x => ['text', 'month', 'date'].includes(x[2]) && !d.group.includes(x[0])).map(x => [x[0], x[1]]), d.pivot, 'بدون')}</select><span class="help">مثل: الشهر — يعرض القيمة الأولى لكل شهر في عمود.</span></div>` : ''}</fieldset>
      ${d.group.length ? '' : `<fieldset><legend>الأعمدة</legend><div class="rb-cols">${f.map(x => `<label class="row" style="gap:6px"><input type="checkbox" data-col="${x[0]}" ${d.columns.includes(x[0]) ? 'checked' : ''}> ${esc(x[1])}</label>`).join('')}</div></fieldset>`}
      <fieldset><legend>الفلاتر</legend><div class="grid" style="gap:6px">${d.filters.map((fl, i) => { const t = F()[fl.f][2], ops = RB_NUM.includes(t) ? ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'] : ['eq', 'neq', 'has', 'nhas', 'empty', 'nempty', ...(['date', 'month'].includes(t) ? ['gte', 'lte'] : [])];
          return `<div class="rb-flt"><select class="input" data-ff="${i}" aria-label="الحقل">${opts(f.map(x => [x[0], x[1]]), fl.f)}</select><select class="input" data-fo="${i}" aria-label="الشرط">${opts(ops.map(o => [o, RB_OPS[o]]), fl.op)}</select>
          ${['empty', 'nempty'].includes(fl.op) ? '<span></span>' : `<input class="input" data-fv="${i}" value="${esc(fl.v)}" list="rbdl-${esc(fl.f)}" aria-label="القيمة" ${t === 'date' ? 'type="date"' : ''} placeholder="${t === 'money' ? 'بالريال' : t === 'month' ? 'YYYY-MM' : ''}">`}<button type="button" class="btn ghost icon sm" data-fdel="${i}" aria-label="حذف الفلتر">${icon('x')}</button></div>`; }).join('')}
        <button type="button" class="btn ghost sm" id="rbfadd" style="justify-self:start">${icon('plus')}إضافة فلتر</button></div></fieldset>
      <div class="form-grid"><div class="field"><label for="rbsort">الترتيب حسب</label><select class="input" id="rbsort">${opts([...(d.group.length ? [...d.group.map(g => [g, F()[g][1]]), ...d.measures.map(m => [rbMKey(m), rbMLabel(m, F())])] : d.columns.map(c => [c, F()[c][1]]))], d.sort?.f || '', 'تلقائي')}</select></div>
        <div class="field"><label for="rbdir">الاتجاه</label><select class="input" id="rbdir">${opts([['desc', 'من الأعلى'], ['asc', 'من الأقل']], d.sort?.dir || 'desc')}</select></div></div>
      ${field('rblim', 'أعلى عدد صفوف (0 = الكل)', { value: d.limit || 0, attrs: 'inputmode="numeric"' })}
      <datalist id="rbdl-x"></datalist>${[...new Set(d.filters.map(x => x.f))].map(k => `<datalist id="rbdl-${esc(k)}">${[...new Set(rows.map(r => r[k]).filter(v => v != null && v !== ''))].slice(0, 200).map(v => `<option value="${esc(v)}">`).join('')}</datalist>`).join('')}`;
  };
  const drawOut = () => {
    const [from, to] = rbPeriod(d);
    if (!res) { $('#rbout').innerHTML = loading(); return; }
    $('#rbout').innerHTML = `<div class="rep-head"><b style="font-size:16px">${esc(ORG.name_ar)}</b><h2 style="margin:4px 0">${esc(d.name || RB_DS[d.ds].t)}</h2>
      <p class="muted" style="margin:0 0 8px">${RB_DS[d.ds].snap ? `كما في <span class="num">${to}</span>` : `من <span class="num">${from}</span> إلى <span class="num">${to}</span>`} · ${res.n.toLocaleString('en-US')} سجل${d.filters.length ? ` بعد ${d.filters.length} فلتر` : ''}${res.rows.length !== res.n ? ` · ${res.rows.length.toLocaleString('en-US')} صف` : ''}</p></div>
      ${res.rows.length ? `${d.group.length ? rbChart(res) : ''}<div class="tbl-wrap"><table class="list-tbl rep-tbl" id="rbtbl"><thead><tr>${res.cols.map((c, i) => `<th class="${RB_NUM.includes(c.type) ? 'amt' : ''}"><button type="button" class="rb-sort" data-sort="${esc(c.k)}">${esc(c.label)}${d.sort && (d.sort.f === c.k) ? (d.sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>`).join('')}</tr></thead>
        <tbody>${res.rows.slice(0, 2000).map(r => `<tr>${r.map((v, i) => { const t = res.cols[i].type, n = RB_NUM.includes(t); return `<td class="${n ? 'amt num' : ''} ${n && v < 0 ? 'down' : ''}">${esc(rbFmt(v, t))}</td>`; }).join('')}</tr>`).join('')}</tbody>
        ${res.total.some(x => x != null) ? `<tfoot><tr>${res.total.map((v, i) => `<td class="${v != null ? 'amt num' : ''}"><b>${i === 0 ? 'الإجمالي' : v != null ? esc(rbFmt(v, res.cols[i].type)) : ''}</b></td>`).join('')}</tr></tfoot>` : ''}</table></div>
        ${res.rows.length > 2000 ? `<p class="help">يُعرض أول 2,000 صف — التصدير إلى Excel يشمل الكل.</p>` : ''}` : empty('chart', 'لا توجد بيانات', 'غيّر الفترة أو الفلاتر.')}`;
    $$('#rbout [data-sort]').forEach(b => b.onclick = () => { const k = b.dataset.sort, fk = k.includes(':') && !k.startsWith('pv:') ? k : k; d.sort = { f: fk, dir: d.sort?.f === fk && d.sort.dir === 'desc' ? 'asc' : 'desc' }; compute(); drawCfg(); });
  };
  const compute = () => { res = rbCompute(d, rows); drawOut(); };
  const load = async () => { const [from, to] = rbPeriod(d), key = `${ORG.id}|${d.ds}|${from}|${to}`; res = null; drawOut();
    try { rows = RB_CACHE.get(key) || await api.dataset(d.ds, from, to); RB_CACHE.set(key, rows); if (RB_CACHE.size > 12) RB_CACHE.delete(RB_CACHE.keys().next().value); compute(); }
    catch (e) { $('#rbout').innerHTML = `<p class="help err">${esc(e.message)}</p>`; } };

  $('#main').innerHTML = `<a class="crumb no-print" href="#/report-builder">${icon('chev')} منشئ التقارير</a>
    <div class="page-head no-print"><h1>${rec ? esc(rec.name) : 'تقرير جديد'}</h1><div class="row" style="gap:8px;flex-wrap:wrap">
      ${ed ? `<button class="btn primary" id="rbsave">حفظ</button>${rec ? `<button class="btn secondary" id="rbsaveas">حفظ كنسخة</button><label class="row" style="gap:6px"><input type="checkbox" id="rbpin" ${rec.pinned ? 'checked' : ''}> مثبّت</label>` : ''}` : ''}
      <button class="btn secondary" id="rbxl">${icon('down')}Excel</button><button class="btn secondary" id="rbcsv">CSV</button><button class="btn secondary" onclick="window.print()">${icon('down')}طباعة / PDF</button>
      ${ed ? `<button class="btn ghost" id="rbai">اطلب من الذكاء الاصطناعي</button><button class="btn ghost" id="rbaiin">لصق تعريف</button>` : ''}${rec && ed ? `<button class="btn ghost" id="rbdel">${icon('trash')}حذف</button>` : ''}</div></div>
    <div class="rb-grid"><form class="card grid no-print" id="rbcfg" style="gap:12px" novalidate onsubmit="return false"></form><section class="card" id="rbout"></section></div>`;
  drawCfg(); load();

  const cfg = $('#rbcfg');
  const reset = ds => { const n = d.name; d = rbClean({ ...rbDef(ds), name: n, period: d.period, from: d.from, to: d.to }); };
  cfg.addEventListener('change', e => { const t = e.target; let reload = false;
    if (t.dataset.fv != null || t.id === 'f-rbname') { if (t.id === 'f-rbname') d.name = t.value.trim(); return; }
    if (t.id === 'rbds') { reset(t.value); reload = true; }
    else if (t.id === 'rbper') { d.period = t.value; if (t.value === 'custom') { const [a, b] = rbPeriod({ ...d, period: 'this-month' }); d.from ||= a; d.to ||= b; } reload = true; }
    else if (t.id === 'f-rbfrom') { d.from = t.value; reload = true; } else if (t.id === 'f-rbto') { d.to = t.value; reload = true; }
    else if (t.id === 'rbg0' || t.id === 'rbg1') { d.group = [$('#rbg0').value, t.id === 'rbg0' && !t.value ? '' : $('#rbg1').value].filter(Boolean); d = rbClean(d); }
    else if (t.dataset.ma != null) { d.measures[+t.dataset.ma].agg = t.value; d = rbClean(d); } else if (t.dataset.mf != null) { d.measures[+t.dataset.mf].f = t.value; if (t.value === '*') d.measures[+t.dataset.mf].agg = 'count'; else if (d.measures[+t.dataset.mf].agg === 'count') d.measures[+t.dataset.mf].agg = 'sum'; d = rbClean(d); }
    else if (t.id === 'rbpv') d.pivot = t.value;
    else if (t.dataset.col) d.columns = RB_DS[d.ds].f.map(x => x[0]).filter(k => k === t.dataset.col ? t.checked : d.columns.includes(k));
    else if (t.dataset.ff != null) { d.filters[+t.dataset.ff] = { f: t.value, op: RB_NUM.includes(F()[t.value][2]) ? 'gt' : 'eq', v: '' }; }
    else if (t.dataset.fo != null) d.filters[+t.dataset.fo].op = t.value;
    else if (t.id === 'rbsort' || t.id === 'rbdir') d.sort = $('#rbsort').value ? { f: $('#rbsort').value, dir: $('#rbdir').value } : null;
    else if (t.id === 'f-rblim') d.limit = Math.max(0, parseInt(toLatin(t.value)) || 0);
    else if (t.id === 'f-rbname') { d.name = t.value.trim(); }
    if (!d.columns.length) d.columns = [RB_DS[d.ds].f[0][0]];
    drawCfg(); reload ? load() : compute(); });
  cfg.addEventListener('input', e => { const t = e.target;
    if (t.dataset.fv != null) { d.filters[+t.dataset.fv].v = t.value; clearTimeout(cfg._t); cfg._t = setTimeout(compute, 250); }
    if (t.id === 'f-rbname') { d.name = t.value.trim(); } });
  cfg.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'rbmadd') d.measures.push({ f: '*', agg: 'count' }); else if (b.dataset.mdel != null) { d.measures.splice(+b.dataset.mdel, 1); d = rbClean(d); }
    else if (b.id === 'rbfadd') { const f0 = RB_DS[d.ds].f.find(x => x[2] === 'text') || RB_DS[d.ds].f[0]; d.filters.push({ f: f0[0], op: 'eq', v: '' }); }
    else if (b.dataset.fdel != null) d.filters.splice(+b.dataset.fdel, 1); else return;
    drawCfg(); compute(); });

  const def = () => { const { name, ...rest } = d; return rest; };
  const save = async asNew => { const name = (d.name || '').trim(); if (!name) { $('#f-rbname')?.focus(); return toast('اكتب اسم التقرير أولاً', 'warn'); }
    try { const row = await api.saveReport({ id: asNew ? null : rec?.id, name, definition: def(), pinned: asNew ? false : !!$('#rbpin')?.checked }); toast('حُفظ التقرير'); if (!rec || asNew) location.hash = '#/report-builder/' + row.id; else rec = row; } catch (x) { fail(x); } };
  if ($('#rbsave')) $('#rbsave').onclick = () => save(false);
  if ($('#rbsaveas')) $('#rbsaveas').onclick = () => { d.name = (d.name || '') + ' (نسخة)'; save(true); };
  if ($('#rbpin')) $('#rbpin').onchange = () => save(false);
  if ($('#rbdel')) $('#rbdel').onclick = () => drawer('حذف التقرير', `<p>حذف «${esc(rec.name)}»؟ البيانات نفسها لا تتأثر.</p>`, async () => { await api.deleteReport(rec.id); toast('حُذف'); location.hash = '#/report-builder'; }, 'حذف');
  const title = () => (d.name || RB_DS[d.ds].t) + ' ' + rbPeriod(d).join('_');
  $('#rbcsv').onclick = () => { const t = $('#rbtbl'); t ? tableToCsv(t, title()) : toast('لا توجد بيانات', 'warn'); };
  $('#rbxl').onclick = () => { if (!res?.rows.length) return toast('لا توجد بيانات', 'warn');
    const conv = (v, t) => v == null ? '' : t === 'money' ? Math.round(Number(v)) / 100 : RB_NUM.includes(t) ? Number(v) : t === 'month' ? monthName(v + '-01') : v;
    const sheet = [res.cols.map(c => c.label + (c.type === 'money' ? ' (ر.س)' : '')), ...res.rows.map(r => r.map((v, i) => conv(v, res.cols[i].type)))];
    if (res.total.some(x => x != null)) sheet.push(res.total.map((v, i) => i === 0 ? 'الإجمالي' : v == null ? '' : conv(v, res.cols[i].type)));
    dlBlob(xlsxBlob([{ name: (d.name || RB_DS[d.ds].t).slice(0, 31), rows: sheet }]), title().replace(/[\\/:*?"<>|]/g, '') + '.xlsx'); };

  // AI: the prompt carries the catalogue and the format; the reply is a definition we validate
  if ($('#rbai')) $('#rbai').onclick = () => {
    const cat = Object.entries(RB_DS).filter(([k]) => rbOk(k)).map(([k, v]) => `- ${k} (${v.t}): ${v.f.map(f => `${f[0]}=${f[1]}[${f[2]}]`).join('، ')}`).join('\n');
    const form = drawer('اطلب تقريراً من الذكاء الاصطناعي', `<p class="help" style="margin:0">اكتب التقرير اللي تبيه بكلامك، انسخ النص لبرنامج الذكاء الاصطناعي من حسابك، ثم الصق رده عبر «لصق تعريف». ما يُرسل أي بيانات من شركتك — فقط أسماء الحقول.</p>
      <div class="field"><label for="rbq">وش التقرير اللي تبيه؟</label><textarea class="input" id="rbq" rows="3" style="height:auto;padding:8px 12px" placeholder="مثل: أبي ربح كل صنف هذه السنة مرتب من الأعلى، بس للمنتجات"></textarea></div>
      <div class="field"><label for="rbqp">النص الجاهز</label><textarea class="input" id="rbqp" rows="8" readonly style="height:auto;padding:8px 12px;font-size:12px"></textarea></div>`, async () => {
      const t = $('#rbqp', form).value; try { await navigator.clipboard.writeText(t); } catch { $('#rbqp', form).select(); document.execCommand?.('copy'); } toast('نُسخ النص — الصقه في برنامج الذكاء الاصطناعي'); }, 'نسخ النص');
    const gen = () => { $('#rbqp', form).value = `أنت مساعد يكتب تعريفات تقارير لنظام محاسبي. الطلب: ${$('#rbq', form).value.trim() || '(اكتب الطلب)'}\n\nمصادر البيانات المتاحة وحقولها (المفتاح=الاسم[النوع]):\n${cat}\n\n` +
      `القواعد: الأنواع money بالهللة لكن قيم الفلاتر تُكتب بالريال. العمليات: ${Object.keys(RB_AGG).join(', ')}. شروط الفلاتر: ${Object.keys(RB_OPS).join(', ')}. الفترات: ${periodPresets().map(p => p[0]).join(', ')} أو custom مع from و to بصيغة YYYY-MM-DD. group حتى حقلين، وpivot حقل نصي أو month لتوزيع القيمة الأولى على أعمدة.\n\n` +
      'أرجع كتلة JSON واحدة فقط داخل ```json بهذا الشكل:\n```json\n{"name": "اسم التقرير", "ds": "sales_lines", "period": "this-y", "columns": ["date", "party", "net"], "group": ["party"], "measures": [{"f": "net", "agg": "sum"}], "pivot": "", "filters": [{"f": "item_kind", "op": "eq", "v": "منتج"}], "sort": {"f": "sum:net", "dir": "desc"}, "limit": 0}\n```\nإذا ما فيه تجميع اترك group و measures فارغة واستخدم columns. مفتاح الترتيب لقيمة مجمّعة يكون agg:field مثل sum:net، وللعدد count.'; };
    $('#rbq', form).addEventListener('input', gen); gen(); };
  if ($('#rbaiin')) $('#rbaiin').onclick = () => drawer('لصق تعريف التقرير', `<div class="field"><label for="rbpaste">رد الذكاء الاصطناعي</label><textarea class="input" id="rbpaste" rows="8" style="height:auto;padding:8px 12px;font-size:12px" placeholder="الصق الرد كاملاً…"></textarea></div>`, async () => {
    const txt = $('#rbpaste').value || '', m = txt.match(/```(?:json)?\s*([\s\S]*?)```/i), raw = m ? m[1] : txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1);
    let j; try { j = JSON.parse(raw.trim()); } catch { throw new Error('ما قدرت أقرأ JSON من الرد — انسخ الرد كاملاً مع كتلة ```json'); }
    if (!j || typeof j !== 'object' || !RB_DS[j.ds]) throw new Error('الرد ما فيه مصدر بيانات معروف (ds)');
    if (!rbOk(j.ds)) throw new Error('ليست لديك صلاحية على هذا المصدر');
    const keepName = d.name; d = rbClean(j); if (!d.name) d.name = keepName; drawCfg(); load(); toast('طُبّق تعريف التقرير — راجعه ثم احفظ'); }, 'تطبيق');
}

const RB_ROUTES = [
  [/^#\/report-builder$/, gate('report-builder', 'منشئ التقارير', 'reports|accounting', reportBuilderHome)],
  [/^#\/report-builder\/([\w-]+)(\?.*)?$/, m => gate('report-builder', 'منشئ التقارير', 'reports|accounting', reportBuilderView)(m[1], new URLSearchParams((m[2] || '').slice(1)))],
];
window.__rb = { rbCompute, rbClean, rbTpl, RB_TPL, xlsxBlob, remapBackup };   // exposed for tests
