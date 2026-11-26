// =====================================================================
// Wave 4 reports: cash flow, 12-month comparison, budget vs actual,
// financial ratios & KPIs (incl. Altman Z'' and a simplified zakat base).
// Inserted after reports.js; registered as extra tabs of the reports page.
// =====================================================================
const topGroup = (byId, r) => { let x = r; while (x && x.code?.length > 2 && byId[x.parent_id]) x = byId[x.parent_id]; return x?.code?.length === 2 ? x.code : (x?.code || '').slice(0, 1); };

// ---------- cash flow (direct method, from the cash, bank and card accounts) ----------
const CF_CAT = { document: 'op', payment: 'op', expense: 'op', payroll: 'op', custody: 'op', card_settlement: 'op', stock: 'op', depreciation: 'inv', manual: 'fin', reversal: 'op' };
const CF_NAME = { document: 'مبيعات ومشتريات نقدية', payment: 'سندات القبض والصرف', expense: 'المصروفات', payroll: 'الرواتب', custody: 'العهد النقدية', card_settlement: 'عمولات الشبكة', stock: 'حركات مخزون', reversal: 'قيود عكسية', depreciation: 'بيع أصول ثابتة', manual: 'قيود يدوية (رأس مال، جاري المالك، قروض…)' };
async function cfReport(from, to, head) {
  const accs = (await api.listAccounts()).filter(a => a.is_postable && ['cash', 'bank', 'card_clearing'].includes(a.system_key) || (a.is_postable && a.type === 'asset' && /^110/.test(a.code)));
  const sts = await Promise.all(accs.map(a => api.accountStatement(a.id, from, to)));
  const open = sts.reduce((s, r) => s + (r[0]?.balance || 0), 0), close = sts.reduce((s, r) => s + (r.at(-1)?.balance || 0), 0);
  // internal transfers between cash accounts net to zero, so drop entries that only move money between them
  const cashIds = new Set(accs.map(a => a.id)), lines = sts.flat().filter(r => r.entry_id);
  const byEntry = {}; lines.forEach(r => (byEntry[r.entry_id] ||= []).push(r));
  const g = {}; Object.values(byEntry).forEach(ls => { const net = ls.reduce((s, r) => s + r.debit - r.credit, 0); if (!net && ls.length > 1) return;
    const st = ls[0].source_type, k = CF_CAT[st] || 'op'; ((g[k] ||= {})[st] ||= { in: 0, out: 0 }); net > 0 ? g[k][st].in += net : g[k][st].out -= net; });
  const T = k => Object.values(g[k] || {}).reduce((s, x) => s + x.in - x.out, 0);
  const sec = (k, t) => `<tr class="sec"><td colspan="4">${t}</td></tr>${Object.entries(g[k] || {}).map(([st, x]) => `<tr><td>${esc(CF_NAME[st] || st)}</td><td class="amt num">${x.in ? money(x.in) : '—'}</td><td class="amt num">${x.out ? money(x.out) : '—'}</td><td class="amt num ${x.in - x.out < 0 ? 'down' : ''}">${money(x.in - x.out)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">لا توجد حركات</td></tr>'}
    <tr class="sub"><td colspan="3">صافي ${t}</td><td class="amt num">${money(T(k))}</td></tr>`;
  const net = T('op') + T('inv') + T('fin');
  return head('قائمة التدفقات النقدية', `من <span class="num">${from}</span> إلى <span class="num">${to}</span> — الطريقة المباشرة من حركات الصندوق والبنك والشبكة`) +
    `<div class="grid g4" style="margin-bottom:16px">${[['النقدية أول الفترة', open], ['التدفق التشغيلي', T('op')], ['صافي التغير', net], ['النقدية آخر الفترة', close]].map(([t, v]) => `<div class="stat"><div class="label">${t}</div><div class="val num ${v < 0 ? 'down' : ''}">${money(v)}</div></div>`).join('')}</div>
    <div class="tbl-wrap"><table class="rep-tbl"><thead><tr><th>البند</th><th class="amt">داخل</th><th class="amt">خارج</th><th class="amt">الصافي</th></tr></thead><tbody>
      ${sec('op', 'الأنشطة التشغيلية')}${sec('inv', 'الأنشطة الاستثمارية')}${sec('fin', 'الأنشطة التمويلية والأخرى')}
      <tr class="grand"><td colspan="3">صافي التغير في النقدية</td><td class="amt num">${money(net)}</td></tr>
      <tr><td colspan="3">النقدية أول الفترة</td><td class="amt num">${money(open)}</td></tr><tr class="grand"><td colspan="3">النقدية آخر الفترة</td><td class="amt num">${money(close)}</td></tr></tbody></table></div>
    ${open + net !== close ? '<p class="note warn">يوجد فرق في المطابقة — راجع القيود اليدوية على حسابات النقدية.</p>' : ''}
    <p class="xs muted" style="margin-top:8px">ملاحظة: شراء الأصول الثابتة بفاتورة مشتريات يظهر ضمن «مبيعات ومشتريات نقدية» إن دُفع فوراً.</p>`;
}

// ---------- 12-month comparison ----------
async function cmpReport(_f, _t, head) {
  const ms = await api.monthlySummary(12);
  const rows = ms.map(m => ({ ...m, gross: m.revenue - m.cogs, net: m.revenue - m.cogs - m.expenses, label: AR_MONTHS[+m.month.slice(5, 7) - 1] + ' ' + m.month.slice(2, 4) }));
  const S = k => rows.reduce((s, r) => s + r[k], 0);
  const best = rows.reduce((b, r) => r.revenue > (b?.revenue ?? -1) ? r : b, null);
  const avg = rows.length ? S('revenue') / rows.length : 0, last3 = rows.slice(-3), prev3 = rows.slice(-6, -3);
  const tr = pct(last3.reduce((s, r) => s + r.revenue, 0), prev3.reduce((s, r) => s + r.revenue, 0));
  return head('التحليل المقارن — آخر 12 شهراً', 'الإيرادات والتكاليف وصافي الربح شهرياً، مع اتجاه آخر 3 أشهر مقابل الثلاثة قبلها') +
    `<div class="grid g4" style="margin-bottom:16px">${[['إيرادات 12 شهراً', money(S('revenue'))], ['صافي ربح 12 شهراً', money(S('net'))], ['متوسط الإيراد الشهري', money(Math.round(avg))], ['اتجاه آخر 3 أشهر', pctTxt(tr)]].map(([t, v]) => `<div class="stat"><div class="label">${t}</div><div class="val num">${v}</div></div>`).join('')}</div>
    <div style="margin-bottom:12px">${barChart(rows.map(r => ({ label: r.label, a: r.revenue, b: r.cogs + r.expenses })))}<div class="legend"><span><i class="s1"></i>الإيرادات</span><span><i class="s2"></i>التكاليف والمصروفات</span></div></div>
    <div class="tbl-wrap"><table class="rep-tbl"><thead><tr><th>الشهر</th><th class="amt">الإيرادات</th><th class="amt m-hide">تكلفة المبيعات</th><th class="amt">مجمل الربح</th><th class="amt m-hide">المصروفات</th><th class="amt">صافي الربح</th><th class="amt m-hide">الهامش</th><th class="amt m-hide">مقبوضات</th><th class="amt m-hide">مدفوعات</th></tr></thead><tbody>
      ${rows.map(r => `<tr${r === best && r.revenue ? ' class="sec"' : ''}><td>${esc(r.label)}</td><td class="amt num">${money(r.revenue)}</td><td class="amt num m-hide">${money(r.cogs)}</td><td class="amt num">${money(r.gross)}</td><td class="amt num m-hide">${money(r.expenses)}</td><td class="amt num ${r.net < 0 ? 'down' : ''}">${money(r.net)}</td>
        <td class="amt num m-hide">${r.revenue ? (r.net / r.revenue * 100).toFixed(1) + '%' : '—'}</td><td class="amt num m-hide">${money(r.cash_in)}</td><td class="amt num m-hide">${money(r.cash_out)}</td></tr>`).join('')}
      <tr class="grand"><td>الإجمالي</td><td class="amt num">${money(S('revenue'))}</td><td class="amt num m-hide">${money(S('cogs'))}</td><td class="amt num">${money(S('gross'))}</td><td class="amt num m-hide">${money(S('expenses'))}</td><td class="amt num">${money(S('net'))}</td><td class="m-hide"></td><td class="amt num m-hide">${money(S('cash_in'))}</td><td class="amt num m-hide">${money(S('cash_out'))}</td></tr></tbody></table></div>
    ${best?.revenue ? `<p class="xs muted" style="margin-top:8px">أفضل شهر: ${esc(best.label)} بإيرادات ${money(best.revenue)}.</p>` : ''}`;
}

// ---------- budget vs actual ----------
async function budgetReport(_f, _t, head) {
  const y = +(sessionStorage.getItem('budget-y') || riyadhToday().slice(0, 4)), today = riyadhToday(), curM = String(y) < today.slice(0, 4) ? 12 : String(y) > today.slice(0, 4) ? 0 : +today.slice(5, 7);
  const [accs, bs, act] = await Promise.all([api.listAccounts(), api.listBudgets(y), api.accountBalances(`${y}-01-01`, `${y}-12-31` < today ? `${y}-12-31` : today)]);
  const B = Object.fromEntries(bs.map(b => [b.account_id, b.amounts.map(Number)])), A = Object.fromEntries(act.map(r => [r.account_id, r]));
  const list = accs.filter(a => a.is_postable && ['revenue', 'expense'].includes(a.type));
  const actual = a => { const r = A[a.id]; return r ? (a.type === 'revenue' ? r.credit - r.debit : r.debit - r.credit) : 0; };
  const editable = can('accounting', 'create');
  const row = a => { const b = B[a.id] || Array(12).fill(0), yr = b.reduce((s, v) => s + v, 0), ytd = b.slice(0, curM).reduce((s, v) => s + v, 0), ac = actual(a), v = a.type === 'revenue' ? ac - ytd : ytd - ac;
    return `<tr data-a="${esc(a.id)}"><td><span class="num muted">${esc(a.code)}</span> ${esc(a.name_ar)}</td><td class="amt">${editable ? `<input class="input num" data-bud value="${yr ? money(yr) : ''}" placeholder="0.00" inputmode="decimal" aria-label="موازنة ${esc(a.name_ar)}" style="max-width:150px">` : `<span class="num">${money(yr)}</span>`}</td>
      <td class="amt num">${money(ytd)}</td><td class="amt num">${money(ac)}</td><td class="amt num ${v < 0 ? 'down' : ''}">${ytd || ac ? money(v) : '—'}</td><td class="m-hide">${ytd ? `<div class="bar"><i style="width:${Math.min(100, ac / ytd * 100).toFixed(0)}%;${ac > ytd && a.type === 'expense' ? 'background:var(--c-danger)' : ''}"></i></div>` : ''}</td></tr>`; };
  const tot = (type) => { const l = list.filter(a => a.type === type); const ytd = l.reduce((s, a) => s + (B[a.id] || []).slice(0, curM).reduce((x, v) => x + v, 0), 0), ac = l.reduce((s, a) => s + actual(a), 0);
    return `<tr class="sub"><td>الإجمالي</td><td class="amt num">${money(l.reduce((s, a) => s + (B[a.id] || []).reduce((x, v) => x + v, 0), 0))}</td><td class="amt num">${money(ytd)}</td><td class="amt num">${money(ac)}</td><td class="amt num">${money(type === 'revenue' ? ac - ytd : ytd - ac)}</td><td class="m-hide"></td></tr>`; };
  setTimeout(() => { const ys = $('#budy'); if (!ys) return; ys.onchange = e => { sessionStorage.setItem('budget-y', e.target.value); location.hash = '#/reports/budget?' + Date.now(); };
    if ($('#budsave')) $('#budsave').onclick = async e => { const rows = $$('#rep tr[data-a]'); e.target.disabled = true;
      try { for (const tr of rows) { const inp = $('[data-bud]', tr), v = toHalalas(inp.value || 0); if (!Number.isFinite(v) || v < 0) throw new AppError('مبلغ غير صحيح: ' + inp.value);
          const old = (B[tr.dataset.a] || []).reduce((s, x) => s + x, 0); if (v === old) continue;
          const base = Math.floor(v / 12), months = Array.from({ length: 12 }, (_, i) => base + (i < v - base * 12 ? 1 : 0)); await api.saveBudget(y, tr.dataset.a, months); }
        toast('حُفظت الموازنة'); location.hash = '#/reports/budget?' + Date.now(); } catch (x) { fail(x); e.target.disabled = false; } }; }, 0);
  const th = `<thead><tr><th>الحساب</th><th class="amt">الموازنة السنوية</th><th class="amt">المستهدف حتى الآن</th><th class="amt">الفعلي</th><th class="amt">الانحراف</th><th class="m-hide"></th></tr></thead>`;
  return head(`الموازنة التقديرية مقابل الفعلي — ${y}`, `المستهدف حتى نهاية الشهر ${curM} — الموازنة السنوية تُوزّع بالتساوي على 12 شهراً. الانحراف الموجب = أفضل من المستهدف.`) +
    `<div class="row no-print" style="gap:8px;margin-bottom:12px"><label for="budy">السنة</label><select class="input" id="budy" style="height:38px;width:auto">${[y - 1, y, y + 1].map(v => `<option${v === y ? ' selected' : ''}>${v}</option>`).join('')}</select>
      ${editable ? '<span class="sp"></span><button class="btn primary" id="budsave">حفظ الموازنة</button>' : ''}</div>
    <h3 style="margin:8px 0">الإيرادات</h3><div class="tbl-wrap"><table class="rep-tbl">${th}<tbody>${list.filter(a => a.type === 'revenue').map(row).join('')}${tot('revenue')}</tbody></table></div>
    <h3 style="margin:16px 0 8px">المصروفات والتكاليف</h3><div class="tbl-wrap"><table class="rep-tbl">${th}<tbody>${list.filter(a => a.type === 'expense').map(row).join('')}${tot('expense')}</tbody></table></div>`;
}

// ---------- ratios, KPIs, Altman Z'', zakat base ----------
async function kpiReport(_f, to, head) {
  const y1 = new Date(to + 'T00:00:00'); y1.setFullYear(y1.getFullYear() - 1); y1.setDate(y1.getDate() + 1); const from12 = ymd(y1);
  const [bal, yr, ar] = await Promise.all([api.accountBalances(to, to), api.accountBalances(from12, to), can('sales') ? api.openDocuments(['tax_invoice', 'simplified_invoice']).catch(() => []) : []]);
  const byId = Object.fromEntries(bal.map(r => [r.account_id, r])), post = bal.filter(r => r.is_postable), G = r => topGroup(byId, r);
  const sumBy = (pred, sign = 1) => post.filter(pred).reduce((s, r) => s + sign * r.closing, 0);
  const CA = sumBy(r => r.type === 'asset' && G(r) === '11'), FA = sumBy(r => r.type === 'asset' && G(r) !== '11'), TA = CA + FA;
  const CL = sumBy(r => r.type === 'liability' && G(r) === '21', -1), LL = sumBy(r => r.type === 'liability' && G(r) !== '21', -1), TL = CL + LL;
  const earnAll = -post.filter(r => ['revenue', 'expense'].includes(r.type)).reduce((s, r) => s + r.closing, 0);
  const EQ = sumBy(r => r.type === 'equity', -1) + earnAll, RE = sumBy(r => r.system_key === 'retained_earnings', -1) + earnAll;
  const cash = sumBy(r => ['cash', 'bank', 'card_clearing'].includes(r.system_key)), inv = sumBy(r => ['inventory', 'raw_materials', 'wip'].includes(r.system_key));
  const yp = yr.filter(r => r.is_postable), Y = Object.fromEntries(bal.map(r => [r.account_id, r])), cogsIds = new Set(yp.filter(r => topGroup(Y, r) === '51').map(r => r.account_id));
  const REV = yp.filter(r => r.type === 'revenue').reduce((s, r) => s + r.credit - r.debit, 0), COGS = yp.filter(r => cogsIds.has(r.account_id)).reduce((s, r) => s + r.debit - r.credit, 0);
  const EXP = yp.filter(r => r.type === 'expense' && !cogsIds.has(r.account_id)).reduce((s, r) => s + r.debit - r.credit, 0), NET = REV - COGS - EXP;
  const DEP = yp.filter(r => r.system_key === 'depreciation').reduce((s, r) => s + r.debit - r.credit, 0), EBIT = NET; // no interest/tax lines in this chart
  const AR = ar.reduce((s, d) => s + d.open, 0);
  const r2 = (a, b) => b ? a / b : null, f = (v, d = 2) => v == null || !Number.isFinite(v) ? '—' : v.toFixed(d), pc = v => v == null || !Number.isFinite(v) ? '—' : (v * 100).toFixed(1) + '%';
  // Altman Z'' (non-manufacturing / private firms): 6.56 X1 + 3.26 X2 + 6.72 X3 + 1.05 X4
  const X1 = r2(CA - CL, TA), X2 = r2(RE, TA), X3 = r2(EBIT, TA), X4 = r2(EQ, TL);
  const Z = [X1, X2, X3, X4].every(v => v != null && Number.isFinite(v)) ? 6.56 * X1 + 3.26 * X2 + 6.72 * X3 + 1.05 * X4 : null;
  const zone = Z == null ? ['بيانات غير كافية', 'b-draft'] : Z > 2.6 ? ['منطقة آمنة', 'b-ok'] : Z >= 1.1 ? ['منطقة رمادية — راقب', 'b-warn'] : ['منطقة خطر', 'b-bad'];
  // simplified zakat base (indicative only): equity + long-term liabilities − net fixed assets; positive net profit already inside equity
  const zbase = Math.max(0, EQ + LL - Math.max(0, FA)), zakat = Math.round(zbase * 0.025);
  const kpi = (t, v, hint, cls = '') => `<div class="card stat"><div class="label">${t}</div><div class="val num ${cls}">${v}</div>${hint ? `<div class="xs muted">${hint}</div>` : ''}</div>`;
  return head('المؤشرات المالية والتحليل', `المركز كما في <span class="num">${to}</span> · الأداء عن 12 شهراً من <span class="num">${from12}</span>`) +
    `<h3 style="margin:0 0 8px">السيولة</h3><div class="grid g4" style="margin-bottom:16px">
      ${kpi('نسبة التداول', f(r2(CA, CL)), 'الأصول المتداولة ÷ الخصوم المتداولة — الأفضل فوق 1.5')}${kpi('النسبة السريعة', f(r2(CA - inv, CL)), 'بدون المخزون — الأفضل فوق 1')}
      ${kpi('النقدية المتاحة', money(cash), 'الصندوق + البنك + الشبكة')}${kpi('رأس المال العامل', money(CA - CL), '', CA - CL < 0 ? 'down' : '')}</div>
    <h3 style="margin:0 0 8px">الربحية (آخر 12 شهراً)</h3><div class="grid g4" style="margin-bottom:16px">
      ${kpi('الإيرادات', money(REV))}${kpi('هامش مجمل الربح', pc(r2(REV - COGS, REV)))}${kpi('هامش صافي الربح', pc(r2(NET, REV)), '', NET < 0 ? 'down' : '')}${kpi('العائد على حقوق الملكية', pc(r2(NET, EQ)))}</div>
    <h3 style="margin:0 0 8px">النشاط والمديونية</h3><div class="grid g4" style="margin-bottom:16px">
      ${kpi('متوسط فترة التحصيل', REV ? Math.round(AR / (REV / 365)) + ' يوم' : '—', 'كم يوماً يتأخر العملاء في السداد')}${kpi('دوران المخزون', COGS && inv ? f(COGS / inv, 1) + ' مرة' : '—', inv && COGS ? `≈ ${Math.round(365 / (COGS / inv))} يوماً لبيع المخزون` : '')}
      ${kpi('الديون إلى حقوق الملكية', f(r2(TL, EQ)), 'الأفضل أقل من 1')}${kpi('الإهلاك السنوي', money(DEP))}</div>
    <div class="grid g2" style="align-items:start"><section class="card"><h3 style="margin-bottom:6px">مؤشر ألتمان Z″ للملاءة المالية</h3>
        <div class="row" style="gap:12px;align-items:baseline"><b class="num" style="font-size:28px">${f(Z)}</b>${badge(zone)}</div>
        <table class="rep-tbl" style="margin-top:8px"><tbody>${[['X1 رأس المال العامل ÷ الأصول', X1, 6.56], ['X2 الأرباح المبقاة ÷ الأصول', X2, 3.26], ['X3 الربح التشغيلي ÷ الأصول', X3, 6.72], ['X4 حقوق الملكية ÷ الخصوم', X4, 1.05]].map(([t, v, w]) => `<tr><td>${t}</td><td class="amt num">${f(v, 3)}</td><td class="amt num muted">× ${w}</td></tr>`).join('')}</tbody></table>
        <p class="xs muted">فوق 2.6 آمن · 1.1–2.6 رمادي · أقل من 1.1 خطر. صيغة Z″ للشركات غير المدرجة.</p></section>
      <section class="card"><h3 style="margin-bottom:6px">تقدير وعاء الزكاة (مبسّط)</h3><table class="rep-tbl"><tbody>
        <tr><td>حقوق الملكية (شاملة ربح الفترة)</td><td class="amt num">${money(EQ)}</td></tr><tr><td>+ الخصوم طويلة الأجل</td><td class="amt num">${money(LL)}</td></tr><tr><td>− صافي الأصول الثابتة وغير المتداولة</td><td class="amt num">${money(Math.max(0, FA))}</td></tr>
        <tr class="sub"><td>الوعاء التقديري</td><td class="amt num">${money(zbase)}</td></tr><tr class="grand"><td>الزكاة التقديرية 2.5%</td><td class="amt num">${money(zakat)}</td></tr></tbody></table>
        <p class="xs muted">تقدير استرشادي فقط على أساس السنة الهجرية — الإقرار الفعلي يُعدّ وفق لائحة هيئة الزكاة والضريبة والجمارك وبمراجعة محاسبك.</p></section></div>`;
}

const REPORTS2 = [['cf', 'التدفقات النقدية', cfReport, 'period'], ['cmp', 'التحليل المقارن', cmpReport], ['budget', 'الموازنة التقديرية', budgetReport], ['kpi', 'المؤشرات المالية', kpiReport, 'asof']];
