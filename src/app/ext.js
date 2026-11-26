// =====================================================================
// Extended modules: ledger & chart editing, opening balances, fixed assets,
// custody, card settlement, CRM leads, tasks, commitments, calendar,
// leaves, attendance, evaluations. Inserted after pos.js by build.py.
// =====================================================================
const dl = (rows, name) => { const blob = new Blob(['﻿' + rows.map(x => x.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name + '.csv'; document.body.append(a); a.click(); a.remove(); };
const daysTo = d => Math.round((new Date(d + 'T00:00:00') - new Date(riyadhToday() + 'T00:00:00')) / 864e5);
const dueBadge = d => { const n = daysTo(d); return n < 0 ? badge([`منتهي منذ ${-n} يوم`, 'b-bad']) : n <= 30 ? badge([`باقي ${n} يوم`, 'b-warn']) : badge([`باقي ${n} يوم`, 'b-ok']); };
const waLink = (phone, text) => { let p = toLatin(phone || '').replace(/\D/g, ''); if (p.startsWith('05')) p = '966' + p.slice(1); else if (p.startsWith('5') && p.length === 9) p = '966' + p;
  return `https://wa.me/${p}?text=${encodeURIComponent(text)}`; };

// ---------- chart of accounts: add / edit, ledger link ----------
function accountDrawer(accs, a) {
  const groups = accs.filter(x => !x.is_postable);
  const sib = pid => accs.filter(x => x.parent_id === pid).map(x => Number(x.code)).filter(Number.isFinite);
  const nextCode = pid => { const p = accs.find(x => x.id === pid); const s = sib(pid); return s.length ? String(Math.max(...s) + 1) : (p ? p.code + '01' : ''); };
  const f = drawer(a ? 'تعديل حساب' : 'حساب جديد', `
    ${a ? '' : `<div class="field"><label for="f-parent_id">تحت الحساب الرئيسي</label><select class="input" id="f-parent_id" name="parent_id">${optList(groups.map(g => [g.id, `${g.code} — ${g.name_ar}`]), groups.find(g => g.code === '52')?.id)}</select></div>`}
    ${field('code', 'رمز الحساب', { req: true, value: a?.code || '', attrs: 'dir="ltr" inputmode="numeric" maxlength="12"' })}
    ${field('name_ar', 'اسم الحساب', { req: true, value: a?.name_ar || '', help: 'مثل: مصاريف الدعاية، بنك الراجحي، سيارة النقل' })}
    ${a ? '' : `<label class="row" style="gap:8px"><input type="checkbox" name="group"> حساب رئيسي (تجميعي) تُضاف تحته حسابات</label>`}
    ${a && !a.system_key ? '<button type="button" class="btn ghost" id="dela" style="color:var(--c-danger)">حذف الحساب</button>' : ''}`,
    async v => { if (!v.code?.trim() || !v.name_ar?.trim()) throw new AppError('الرمز والاسم مطلوبان');
      if (accs.some(x => x.code === v.code.trim() && x.id !== a?.id)) throw new AppError('هذا الرمز مستخدم');
      await api.saveAccount({ id: a?.id, parent_id: v.parent_id, code: v.code.trim(), name_ar: v.name_ar.trim(), type: accs.find(x => x.id === v.parent_id)?.type, is_postable: !v.group });
      toast('حُفظ الحساب'); accountsView(); });
  if (!a) { const sel = $('#f-parent_id', f), code = $('#f-code', f); code.value = nextCode(sel.value); sel.onchange = () => code.value = nextCode(sel.value); }
  if ($('#dela', f)) $('#dela', f).onclick = async e => { if (!confirmBtn(e.target)) return; try { await api.deleteAccount(a.id); f.closest('.drawer-bg').remove(); toast('حُذف'); accountsView(); } catch (x) { toast(x.message, 'bad'); } };
}
function enhanceAccounts(accs) {
  if (api.mode !== 'supabase') return;
  const head = $('#main .page-head');
  if (head && can('accounting', 'create')) { const b = document.createElement('button'); b.className = 'btn primary'; b.innerHTML = icon('plus') + 'حساب جديد'; b.onclick = () => accountDrawer(accs); head.append(b);
    const o = document.createElement('a'); o.className = 'btn secondary'; o.href = '#/opening'; o.textContent = 'الأرصدة الافتتاحية'; head.append(o); }
  $$('#main .tree-tbl tbody tr').forEach((tr, i) => { const a = accs.sorted?.[i]; if (!a) return;
    const td = tr.children[0]; if (a.is_postable) td.innerHTML = `<a href="#/ledger/${esc(a.id)}">${td.innerHTML}</a>`;
    if (can('accounting', 'create')) { const e = document.createElement('td'); e.innerHTML = `<button class="btn ghost sm" data-ea="${esc(a.id)}">تعديل</button>`; tr.append(e); } });
  const th = $('#main .tree-tbl thead tr'); if (th && can('accounting', 'create')) th.insertAdjacentHTML('beforeend', '<th></th>');
  $$('[data-ea]').forEach(b => b.onclick = () => accountDrawer(accs, accs.find(x => x.id === b.dataset.ea)));
}

// ---------- ledger (account statement) ----------
async function ledgerView(id, qs) {
  shell('accounts', loading());
  const [accs, parties] = await Promise.all([api.listAccounts(), api.listParties()]);
  const a = accs.find(x => x.id === id); if (!a) throw new AppError('الحساب غير موجود');
  const y = riyadhToday().slice(0, 4), from = qs?.get('from') || `${y}-01-01`, to = qs?.get('to') || riyadhToday(), party = qs?.get('party') || '';
  const rows = await api.accountStatement(id, from, to, party);
  const SRC = { manual: 'قيد يدوي', document: 'مستند', payment: 'سند', expense: 'مصروف', stock: 'مخزون', reversal: 'عكس', opening: 'افتتاحي', payroll: 'رواتب', depreciation: 'إهلاك', custody: 'عهدة', card_settlement: 'تسوية شبكة' };
  const sign = ['asset', 'expense'].includes(a.type) ? 1 : -1, last = rows.at(-1)?.balance || 0;
  const D = rows.reduce((s, r) => s + r.debit, 0), C = rows.reduce((s, r) => s + r.credit, 0);
  $('#main').innerHTML = `<a class="crumb no-print" href="#/accounts">${icon('chev')} شجرة الحسابات</a>
    <div class="page-head no-print"><h1>كشف حساب: ${esc(a.name_ar)} <span class="num muted" style="font-size:var(--fs-md)">${esc(a.code)}</span></h1>
      <button class="btn secondary" id="csvl">${icon('down')}Excel (CSV)</button><button class="btn secondary" onclick="window.print()">${icon('down')}طباعة</button></div>
    <form class="row no-print" id="lf" style="flex-wrap:wrap;gap:8px;margin-bottom:16px;align-items:flex-end">
      <div class="field" style="margin:0"><label for="f-acc">الحساب</label><select class="input" id="f-acc" style="height:38px">${optList(accs.filter(x => x.is_postable).map(x => [x.id, `${x.code} — ${x.name_ar}`]), id)}</select></div>
      <div class="field" style="margin:0"><label for="f-from">من</label><input class="input" type="date" id="f-from" value="${esc(from)}" style="height:38px"></div>
      <div class="field" style="margin:0"><label for="f-to">إلى</label><input class="input" type="date" id="f-to" value="${esc(to)}" style="height:38px"></div>
      <div class="field" style="margin:0"><label for="f-pt">الطرف</label><select class="input" id="f-pt" style="height:38px">${optList(parties.map(p => [p.id, p.name]), party, '— الكل —')}</select></div>
      <button class="btn primary" type="submit">عرض</button></form>
    <section class="card"><div class="rep-head"><b>${esc(ORG.name_ar)}</b><h2 style="margin:4px 0">كشف حساب ${esc(a.code)} — ${esc(a.name_ar)}</h2><p class="muted" style="margin:0 0 12px">من <span class="num">${from}</span> إلى <span class="num">${to}</span>${party ? ' — ' + esc(parties.find(p => p.id === party)?.name || '') : ''}</p></div>
    <div class="grid g4" style="margin-bottom:12px">${[['الرصيد الافتتاحي', (rows[0]?.balance || 0) * sign], ['إجمالي المدين', D], ['إجمالي الدائن', C], ['الرصيد الختامي', last * sign]].map(([t, v]) => `<div class="stat"><div class="label">${t}</div><div class="val num ${v < 0 ? 'down' : ''}">${money(v)}</div></div>`).join('')}</div>
    <div class="tbl-wrap"><table class="rep-tbl" id="ledt"><thead><tr><th>التاريخ</th><th>رقم القيد</th><th>البيان</th><th class="m-hide">النوع</th><th class="m-hide">الطرف</th><th class="amt">مدين</th><th class="amt">دائن</th><th class="amt">الرصيد</th></tr></thead><tbody>
      ${rows.map(r => `<tr${r.source_type === 'opening' ? ' class="sec"' : ''}><td class="num">${esc(r.entry_date)}</td><td class="num">${r.entry_id ? `<a href="#/journal/${esc(r.entry_id)}">${esc(r.entry_no)}</a>` : ''}</td><td style="white-space:normal">${esc(r.memo || '')}</td>
        <td class="m-hide">${esc(SRC[r.source_type] || '')}</td><td class="m-hide">${esc(r.party_name || '')}</td><td class="amt num">${r.debit ? money(r.debit) : ''}</td><td class="amt num">${r.credit ? money(r.credit) : ''}</td><td class="amt num">${money(r.balance * sign)}</td></tr>`).join('')}
      <tr class="grand"><td colspan="5">الإجمالي</td><td class="amt num">${money(D)}</td><td class="amt num">${money(C)}</td><td class="amt num">${money(last * sign)}</td></tr></tbody></table></div></section>`;
  const go = () => { const q = new URLSearchParams({ from: $('#f-from').value, to: $('#f-to').value }); if ($('#f-pt').value) q.set('party', $('#f-pt').value); location.hash = `#/ledger/${$('#f-acc').value}?${q}`; };
  $('#lf').onsubmit = e => { e.preventDefault(); go(); }; $('#f-acc').onchange = go;
  $('#csvl').onclick = () => dl([['التاريخ', 'القيد', 'البيان', 'الطرف', 'مدين', 'دائن', 'الرصيد'], ...rows.map(r => [r.entry_date, r.entry_no || '', r.memo || '', r.party_name || '', (r.debit / 100).toFixed(2), (r.credit / 100).toFixed(2), (r.balance * sign / 100).toFixed(2)])], `كشف ${a.code} ${from}_${to}`);
}

// ---------- opening balances ----------
async function openingView() {
  shell('accounts', loading());
  if (!can('accounting', 'post')) { location.hash = '#/accounts'; return; }
  const [accs, ps] = await Promise.all([api.listAccounts(), api.listParties()]);
  const list = accs.filter(a => a.is_postable && ['asset', 'liability', 'equity'].includes(a.type) && !['inventory', 'raw_materials', 'opening_balance', 'retained_earnings', 'acc_depreciation'].includes(a.system_key) && !/^16/.test(a.code));
  const needsParty = a => ['ar', 'ap', 'custody', 'supplier_advances', 'customer_advances'].includes(a.system_key);
  let rows = list.filter(a => !needsParty(a)).map(a => ({ account_id: a.id, party_id: '', amount: 0 }));
  $('#main').innerHTML = `<a class="crumb" href="#/accounts">${icon('chev')} شجرة الحسابات</a><div class="page-head"><h1>الأرصدة الافتتاحية</h1></div>
    <p class="note" style="margin-bottom:16px">أدخل أرصدة الحسابات يوم بدء استخدام النظام. المخزون يُدخل من «حركات المخزون ← رصيد افتتاحي»، والأصول الثابتة من صفحة «الأصول الثابتة». الفرق يُرحَّل تلقائياً لحساب «الأرصدة الافتتاحية» في حقوق الملكية.</p>
    <form class="card" id="obf" novalidate><div class="grid g3" style="margin-bottom:12px">${field('date', 'تاريخ الأرصدة', { type: 'date', value: `${riyadhToday().slice(0, 4)}-01-01`, req: true })}</div>
      <div class="tbl-wrap editor"><table><thead><tr><th>الحساب</th><th>الطرف (للعملاء والموردين والعهد)</th><th style="width:170px">الرصيد</th><th style="width:44px"></th></tr></thead><tbody id="obl"></tbody></table></div>
      <button type="button" class="btn ghost sm" id="obadd" style="margin-top:8px">${icon('plus')}رصيد عميل / مورد / عهدة</button>
      <div class="totals"><div><span class="muted">مجموع الأصول (مدين)</span><span class="num" id="obD"></span></div><div><span class="muted">مجموع الخصوم وحقوق الملكية (دائن)</span><span class="num" id="obC"></span></div><div class="grand"><span>يُرحّل للأرصدة الافتتاحية</span><span class="num" id="obX"></span></div></div>
      <p class="help err" id="oberr" role="alert"></p><div class="row" style="justify-content:flex-end"><button class="btn primary" type="submit">ترحيل الأرصدة الافتتاحية</button></div></form>`;
  const A = Object.fromEntries(accs.map(a => [a.id, a]));
  const draw = () => { $('#obl').innerHTML = rows.map((r, i) => { const a = A[r.account_id];
    return `<tr data-i="${i}"><td>${r.extra ? `<select class="input" data-k="account_id" aria-label="الحساب">${optList(list.filter(needsParty).map(x => [x.id, `${x.code} — ${x.name_ar}`]), r.account_id)}</select>` : `<span class="num muted">${esc(a.code)}</span> ${esc(a.name_ar)}`}</td>
      <td>${r.extra || needsParty(a) ? `<select class="input" data-k="party_id" aria-label="الطرف">${optList(ps.map(p => [p.id, p.name]), r.party_id, '— اختر —')}</select>` : '<span class="muted">—</span>'}</td>
      <td><input class="input num" data-k="amount" inputmode="decimal" value="${r.amount ? money(r.amount) : ''}" placeholder="0.00" aria-label="الرصيد"></td><td>${r.extra ? `<button type="button" class="btn ghost icon sm" data-del aria-label="حذف">${icon('trash')}</button>` : ''}</td></tr>`; }).join(''); sum(); };
  const sum = () => { let d = 0, c = 0; rows.forEach(r => { const a = A[r.account_id]; if (!a || !(r.amount > 0)) return; if (a.type === 'asset') d += r.amount; else c += r.amount; });
    $('#obD').textContent = money(d); $('#obC').textContent = money(c); $('#obX').textContent = money(d - c); };
  $('#obl').addEventListener('input', e => { const tr = e.target.closest('tr'); if (tr && e.target.dataset.k === 'amount') { const v = toHalalas(e.target.value || 0); rows[tr.dataset.i].amount = Number.isFinite(v) ? v : NaN; sum(); } });
  $('#obl').addEventListener('change', e => { const tr = e.target.closest('tr'); if (tr && e.target.tagName === 'SELECT') { rows[tr.dataset.i][e.target.dataset.k] = e.target.value; sum(); } });
  $('#obl').addEventListener('click', e => { if (e.target.closest('[data-del]')) { rows.splice(e.target.closest('tr').dataset.i, 1); draw(); } });
  $('#obadd').onclick = () => { rows.push({ account_id: list.find(a => a.system_key === 'ar')?.id, party_id: '', amount: 0, extra: true }); draw(); };
  $('#obf').onsubmit = async e => { e.preventDefault(); const err = $('#oberr'); err.textContent = '';
    if (rows.some(r => !Number.isFinite(r.amount) || r.amount < 0)) return err.textContent = 'مبلغ غير صحيح';
    const real = rows.filter(r => r.amount > 0); if (!real.length) return err.textContent = 'أدخل رصيداً واحداً على الأقل';
    if (real.some(r => needsParty(A[r.account_id]) && !r.party_id)) return err.textContent = 'اختر الطرف لأرصدة العملاء والموردين والعهد';
    const lines = real.map(r => { const a = A[r.account_id]; return a.type === 'asset' ? { account_id: a.id, debit: r.amount, credit: 0, party_id: r.party_id || null } : { account_id: a.id, debit: 0, credit: r.amount, party_id: r.party_id || null }; });
    const d = lines.reduce((s, l) => s + l.debit, 0), c = lines.reduce((s, l) => s + l.credit, 0), ob = accs.find(a => a.system_key === 'opening_balance');
    if (d !== c) lines.push(d > c ? { account_id: ob.id, debit: 0, credit: d - c } : { account_id: ob.id, debit: c - d, credit: 0 });
    $('[type=submit]', e.target).disabled = true;
    try { const id = await api.postManualEntry($('#f-date').value, 'أرصدة افتتاحية', lines); toast('رُحّلت الأرصدة الافتتاحية'); location.hash = '#/journal/' + id; }
    catch (x) { err.textContent = x.message; $('[type=submit]', e.target).disabled = false; } };
  draw();
}

// ---------- fixed assets ----------
async function assetsView() {
  shell('assets', loading()); const [as, accs, ccs] = await Promise.all([api.listAssets(), api.listAccounts(), api.listCostCenters()]);
  const act = as.filter(a => a.status === 'active'), editable = can('accounting', 'create'), canPost = can('accounting', 'post');
  const T = k => act.reduce((s, a) => s + (k === 'book' ? a.cost - a.depreciated : a[k]), 0);
  $('#main').innerHTML = `<div class="page-head"><h1>الأصول الثابتة</h1>${canPost ? `<button class="btn secondary" id="rundep">احتساب الإهلاك حتى هذا الشهر</button>` : ''}${editable ? `<button class="btn primary" id="newfa">${icon('plus')}أصل جديد</button>` : ''}</div>
    <p class="muted" style="margin:-8px 0 16px">المكائن، المعدات، السيارات، الأثاث… يُحسب الإهلاك الشهري بالقسط الثابت ويُسجَّل قيده تلقائياً.</p>
    <div class="grid g3" style="margin-bottom:20px">${[['تكلفة الأصول', T('cost')], ['مجمع الإهلاك', T('depreciated')], ['القيمة الدفترية', T('book')]].map(([t, v]) => `<div class="card stat"><div class="label">${t}</div><div class="val num">${money(v)}</div></div>`).join('')}</div>
    ${as.length ? `<div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>الرمز</th><th>الأصل</th><th class="m-hide">الفئة</th><th class="num m-hide">الشراء</th><th class="amt">التكلفة</th><th class="amt m-hide">الإهلاك الشهري</th><th class="amt">المجمع</th><th class="amt">الدفترية</th><th>الحالة</th><th></th></tr></thead><tbody>
      ${as.map(a => `<tr><td class="num">${esc(a.code)}</td><td style="white-space:normal"><b>${esc(a.name)}</b><div class="xs muted">${a.life_months} شهراً${a.last_month ? ' · آخر إهلاك ' + esc(a.last_month.slice(0, 7)) : ''}</div></td><td class="m-hide">${esc(a.accounts?.name_ar || '')}</td>
        <td class="num m-hide">${esc(a.acquisition_date)}</td><td class="amt num">${money(a.cost)}</td><td class="amt num m-hide">${money(Math.round((a.cost - a.salvage) / a.life_months))}</td><td class="amt num">${money(a.depreciated)}</td><td class="amt num"><b>${money(a.cost - a.depreciated)}</b></td>
        <td>${a.status === 'active' ? badge(['قيد الاستخدام', 'b-ok']) : badge(['مستبعد', 'b-draft'])}</td>
        <td>${a.status === 'active' ? `${editable ? `<button class="btn ghost sm" data-ed="${esc(a.id)}">تعديل</button>` : ''}${canPost ? `<button class="btn ghost sm" data-dis="${esc(a.id)}">بيع / استبعاد</button>` : ''}` : ''}</td></tr>`).join('')}</tbody></table></div>`
    : empty('box', 'لا توجد أصول بعد', 'سجّل مكائن الورشة والسيارات والمعدات لتحسب إهلاكها شهرياً.', editable ? `<button class="btn primary" id="newfa2">${icon('plus')}أصل جديد</button>` : '')}`;
  const cats = accs.filter(a => a.is_postable && a.type === 'asset' && /^1[26]/.test(a.code) && a.system_key !== 'acc_depreciation' && !['ar', 'retention_receivable', 'custody', 'supplier_advances'].includes(a.system_key));
  const open = a => { a = a || { code: 'FA-' + String(as.length + 1).padStart(3, '0'), acquisition_date: riyadhToday(), depreciation_start: riyadhToday().slice(0, 8) + '01', life_months: 60, salvage: 0 };
    const locked = a.depreciated > 0;
    drawer(a.id ? 'تعديل أصل' : 'أصل ثابت جديد', `<div class="form-grid">${field('code', 'الرمز', { req: true, value: a.code, attrs: 'dir="ltr"' })}
        <div class="field"><label for="f-account_id">الفئة (حساب الأصل)</label><select class="input" id="f-account_id" name="account_id">${acctOpts(cats, a.account_id || cats[0]?.id)}</select></div></div>
      ${field('name', 'اسم الأصل', { req: true, value: a.name || '', help: 'مثل: ماكينة قص ليزر، شاحنة نقل، رافعة شوكية' })}
      <div class="form-grid">${field('acquisition_date', 'تاريخ الشراء', { type: 'date', value: a.acquisition_date, req: true })}${field('depreciation_start', 'بداية الإهلاك', { type: 'date', value: a.depreciation_start, req: true, attrs: locked ? 'disabled' : '' })}
        ${field('cost', 'التكلفة قبل الضريبة', { type: 'money', req: true, value: a.cost ? money(a.cost) : '', attrs: locked ? 'disabled' : '' })}${field('salvage', 'القيمة المتبقية (الخردة)', { type: 'money', value: a.salvage ? money(a.salvage) : '', attrs: locked ? 'disabled' : '' })}
        ${field('life_months', 'العمر الإنتاجي (بالأشهر)', { value: a.life_months, req: true, help: 'السيارات عادة 48–60، المكائن 60–120', attrs: `inputmode="numeric" ${locked ? 'disabled' : ''}` })}
        ${ccs.length ? `<div class="field"><label for="f-cost_center_id">مركز التكلفة</label><select class="input" id="f-cost_center_id" name="cost_center_id">${optList(ccs.map(c => [c.id, c.name]), a.cost_center_id, '— بدون —')}</select></div>` : ''}</div>
      ${field('notes', 'ملاحظات', { value: a.notes || '' })}
      ${!a.id ? '<p class="note">تسجيل الأصل لا يُنشئ قيد الشراء — سجّل الشراء بفاتورة مشتريات على حساب الأصل، أو كرصيد افتتاحي.</p>' : ''}${locked ? '<p class="note warn">عليه إهلاك مرحّل؛ لا تتغير التكلفة والعمر.</p>' : ''}`,
      async v => { const life = parseInt(toLatin(v.life_months ?? a.life_months), 10); const cost = v.cost != null ? toHalalas(v.cost) : a.cost, salvage = v.salvage != null ? toHalalas(v.salvage || 0) : a.salvage;
        if (!v.name?.trim()) throw new AppError('الاسم مطلوب'); if (!(cost > 0)) throw new AppError('أدخل التكلفة'); if (!(salvage >= 0) || salvage >= cost) throw new AppError('القيمة المتبقية أقل من التكلفة');
        if (!(life >= 1 && life <= 600)) throw new AppError('العمر الإنتاجي بين 1 و600 شهر');
        await api.saveAsset({ ...(a.id ? { id: a.id } : {}), code: v.code.trim(), name: v.name.trim(), account_id: v.account_id, acquisition_date: v.acquisition_date, notes: v.notes, cost_center_id: v.cost_center_id || null,
          ...(locked ? {} : { cost, salvage, life_months: life, depreciation_start: v.depreciation_start }) });
        toast('حُفظ الأصل'); assetsView(); }); };
  ['#newfa', '#newfa2'].forEach(s => { if ($(s)) $(s).onclick = () => open(null); });
  $$('[data-ed]').forEach(b => b.onclick = () => open(as.find(a => a.id === b.dataset.ed)));
  if ($('#rundep')) $('#rundep').onclick = async e => { e.target.disabled = true; try { const n = await api.runDepreciation(riyadhToday()); toast(n ? `سُجّل ${n} قسط إهلاك` : 'الإهلاك محتسب حتى هذا الشهر'); assetsView(); } catch (x) { fail(x); e.target.disabled = false; } };
  const pa = payAccts(accs);
  $$('[data-dis]').forEach(b => b.onclick = () => { const a = as.find(x => x.id === b.dataset.dis);
    drawer('بيع / استبعاد أصل', `<p>${esc(a.name)} — القيمة الدفترية <b class="num">${money(a.cost - a.depreciated)}</b></p>${field('date', 'التاريخ', { type: 'date', value: riyadhToday(), req: true })}
      ${field('proceeds', 'مبلغ البيع (0 إن كان تالفاً)', { type: 'money', value: '' })}${select('account', 'استُلم في', pa.map(x => [x.id, `${x.code} — ${x.name_ar}`]), pa.find(x => x.system_key === 'bank')?.id)}
      <p class="note">احتسب إهلاك الأشهر السابقة أولاً. الفرق بين البيع والقيمة الدفترية يُسجَّل ربحاً أو خسارة.</p>`,
      async v => { const p = toHalalas(v.proceeds || 0); if (!(p >= 0)) throw new AppError('مبلغ غير صحيح'); await api.disposeAsset(a.id, v.date, p, v.account); toast('استُبعد الأصل'); assetsView(); }, 'استبعاد'); });
}

// ---------- custody ----------
async function custodyView() {
  shell('custody', loading()); const [bal, emps, accs] = await Promise.all([api.custodyBalances(), api.listEmployees().catch(() => []), api.listAccounts()]);
  const pa = payAccts(accs).filter(a => ['cash', 'bank'].includes(a.system_key)), cus = accs.find(a => a.system_key === 'custody'), canPost = can('expenses', 'post');
  $('#main').innerHTML = `<div class="page-head"><h1>الصندوق والعهد النقدية</h1>${canPost ? `<button class="btn primary" id="iss">${icon('plus')}صرف عهدة</button>` : ''}</div>
    <p class="muted" style="margin:-8px 0 16px">اصرف عهدة نقدية لموظف، وسجّل ما يصرفه منها كمصروف «دُفع من: عهد الموظفين» مع اسمه، ثم استرد المتبقي.</p>
    <div class="grid g3" style="margin-bottom:20px"><div class="card stat"><div class="label">إجمالي العهد القائمة</div><div class="val num">${money(bal.reduce((s, b) => s + b.balance, 0))}</div><div class="xs muted">${bal.length} موظف</div></div>
      ${pa.slice(0, 2).map(a => `<a class="card stat" href="#/ledger/${esc(a.id)}" style="text-decoration:none;color:inherit"><div class="label">${esc(a.name_ar)}</div><div class="val num" data-bal="${esc(a.id)}">…</div><div class="xs muted">كشف الحساب ←</div></a>`).join('')}</div>
    ${bal.length ? `<div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>الموظف</th><th class="amt">رصيد العهدة</th><th></th></tr></thead><tbody>
      ${bal.map(b => `<tr><td><b>${esc(b.name)}</b></td><td class="amt num">${money(b.balance)}</td><td><a class="btn ghost sm" href="#/ledger/${esc(cus.id)}?party=${esc(b.party_id)}&from=2000-01-01">كشف</a>${canPost ? `<button class="btn ghost sm" data-ret="${esc(b.party_id)}" data-amt="${b.balance}">استرداد المتبقي</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
    : empty('receipt', 'لا توجد عهد قائمة', 'اصرف عهدة لموظف لشراء مستلزمات الورشة أو مصاريف الطريق.')}`;
  const tb = await api.trialBalance().catch(() => []); $$('[data-bal]').forEach(el => { const r = tb.find(x => x.account_id === el.dataset.bal); el.textContent = money(Number(r?.balance || 0)); });
  const move = (kind, party, amt) => drawer(kind === 'issue' ? 'صرف عهدة' : 'استرداد عهدة', `
    ${kind === 'issue' ? `<div class="field"><label for="f-emp">الموظف</label><select class="input" id="f-emp" name="emp">${optList(emps.filter(e => e.status !== 'terminated').map(e => [e.id, e.full_name]), '', '— اختر —')}</select>
      ${!emps.length ? '<span class="help">أضف الموظف أولاً من «الموظفون».</span>' : ''}</div>` : ''}
    ${field('date', 'التاريخ', { type: 'date', value: riyadhToday(), req: true })}${field('amount', 'المبلغ', { type: 'money', req: true, value: amt ? money(amt) : '' })}
    ${select('cash', kind === 'issue' ? 'صُرفت من' : 'أُودعت في', pa.map(a => [a.id, `${a.code} — ${a.name_ar}`]), pa[0]?.id)}${field('memo', 'البيان', { help: 'مثل: عهدة مشتريات الورشة' })}`,
    async v => { const a = toHalalas(v.amount); if (!(a > 0)) throw new AppError('أدخل المبلغ'); let p = party;
      if (kind === 'issue') { if (!v.emp) throw new AppError('اختر الموظف'); p = await api.employeeParty(v.emp); }
      await api.custodyMove(p, v.date, a, v.cash, kind, v.memo); toast(kind === 'issue' ? 'صُرفت العهدة' : 'استُردت العهدة'); custodyView(); }, kind === 'issue' ? 'صرف' : 'استرداد');
  if ($('#iss')) $('#iss').onclick = () => move('issue');
  $$('[data-ret]').forEach(b => b.onclick = () => move('return', b.dataset.ret, Number(b.dataset.amt)));
}

// ---------- card network settlement ----------
async function cardSettleView() {
  shell('card-settle', loading()); const [accs, tb] = await Promise.all([api.listAccounts(), api.trialBalance()]);
  const cc = accs.find(a => a.system_key === 'card_clearing'), banks = accs.filter(a => a.is_postable && a.system_key === 'bank'), open = Number(tb.find(r => r.account_id === cc?.id)?.balance || 0);
  $('#main').innerHTML = `<div class="page-head"><h1>تسوية مدفوعات الشبكة (مدى / البطاقات)</h1><a class="btn secondary" href="#/ledger/${esc(cc.id)}?from=2000-01-01">كشف حساب الشبكة</a></div>
    <p class="muted" style="margin:-8px 0 16px">مبيعات الشبكة تُسجَّل في «مدفوعات الشبكة تحت التسوية». عند إيداع البنك للمبلغ سجّل التسوية هنا: المبلغ الصافي للبنك والعمولة مصروفاً بنكياً.</p>
    <div class="grid g3" style="margin-bottom:20px"><div class="card stat"><div class="label">بانتظار التسوية</div><div class="val num">${money(open)}</div></div></div>
    <form class="card" id="csf" style="max-width:var(--l-form-max)" novalidate><div class="form-grid">${field('date', 'تاريخ الإيداع', { type: 'date', value: riyadhToday(), req: true })}
      ${field('gross', 'إجمالي المبيعات المسوّاة', { type: 'money', req: true, value: open > 0 ? money(open) : '' })}${field('fee', 'عمولة البنك', { type: 'money', value: '' })}
      ${select('bank', 'أُودع في', banks.map(a => [a.id, `${a.code} — ${a.name_ar}`]), banks[0]?.id)}${field('ref', 'المرجع', { help: 'رقم كشف الشبكة أو التاريخ' })}</div>
      <p class="muted" id="csnet"></p><p class="help err" id="cserr" role="alert"></p>
      <div class="row" style="justify-content:flex-end"><button class="btn primary" type="submit">تسجيل التسوية</button></div></form>`;
  const net = () => { const g = toHalalas($('#f-gross').value || 0), f = toHalalas($('#f-fee').value || 0); $('#csnet').textContent = g > 0 ? `الصافي المودع: ${money(g - (f || 0))} ر.س${g > 0 && f > 0 ? ` · نسبة العمولة ${(f / g * 100).toFixed(2)}%` : ''}` : ''; };
  $('#f-gross').oninput = $('#f-fee').oninput = net; net();
  $('#csf').onsubmit = async e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)), err = $('#cserr'); err.textContent = '';
    const g = toHalalas(f.gross), fee = toHalalas(f.fee || 0); if (!(g > 0)) return err.textContent = 'أدخل المبلغ'; if (!(fee >= 0) || fee >= g) return err.textContent = 'العمولة غير صحيحة';
    $('[type=submit]', e.target).disabled = true;
    try { const id = await api.settleCards(f.date, g, fee, f.bank, f.ref); toast('سُجّلت التسوية'); location.hash = '#/journal/' + id; } catch (x) { err.textContent = x.message; $('[type=submit]', e.target).disabled = false; } };
}

// ---------- CRM: leads ----------
const LEAD_ST = [['new', 'جديد', 'b-info'], ['contacted', 'تم التواصل', 'b-draft'], ['qualified', 'مهتم', 'b-warn'], ['proposal', 'عرض سعر', 'b-warn'], ['won', 'تم البيع', 'b-ok'], ['lost', 'خسرناه', 'b-bad']];
async function leadsView() {
  shell('leads', loading()); const ls = await api.listLeads(), editable = can('sales', 'create');
  const pipe = ls.filter(l => !['won', 'lost'].includes(l.status));
  $('#main').innerHTML = `<div class="page-head"><h1>العملاء المحتملون</h1>${editable ? `<button class="btn primary" id="newl">${icon('plus')}عميل محتمل</button>` : ''}</div>
    <div class="grid g4" style="margin-bottom:20px">${[['في المتابعة', pipe.length, 0], ['قيمة الفرص', pipe.reduce((s, l) => s + (l.expected_value || 0), 0), 1], ['تم البيع', ls.filter(l => l.status === 'won').length, 0],
      ['متابعات اليوم والمتأخرة', pipe.filter(l => l.next_followup && l.next_followup <= riyadhToday()).length, 0]].map(([t, v, m]) => `<div class="card stat"><div class="label">${t}</div><div class="val num">${m ? money(v) : v}</div></div>`).join('')}</div>
    <div class="kanban">${LEAD_ST.map(([k, t, c]) => { const g = ls.filter(l => l.status === k); return `<section class="kcol"><h3>${badge([t, c])} <span class="muted num">${g.length}</span></h3>
      ${g.map(l => `<article class="card kcard" data-l="${esc(l.id)}"><b>${esc(l.name)}</b>${l.company ? `<div class="xs muted">${esc(l.company)}</div>` : ''}${l.expected_value ? `<div class="num xs">${money(l.expected_value)} ر.س</div>` : ''}
        ${l.next_followup ? `<div class="xs ${l.next_followup <= riyadhToday() && !['won', 'lost'].includes(l.status) ? 'down' : 'muted'}">متابعة: <span class="num">${esc(l.next_followup)}</span></div>` : ''}
        <div class="row" style="gap:4px;margin-top:6px">${l.phone ? `<a class="btn ghost sm" href="${waLink(l.phone, `السلام عليكم ${l.name}، معك ${ORG.name_ar}`)}" target="_blank" rel="noopener">واتساب</a><a class="btn ghost sm" href="tel:${esc(toLatin(l.phone))}">اتصال</a>` : ''}</div></article>`).join('') || '<p class="muted xs">—</p>'}</section>`; }).join('')}</div>`;
  const open = l => { l = l || { status: 'new' };
    const f = drawer(l.id ? 'عميل محتمل' : 'عميل محتمل جديد', `${field('name', 'الاسم', { req: true, value: l.name || '' })}${field('company', 'المنشأة', { value: l.company || '' })}
      <div class="form-grid">${field('phone', 'الجوال', { value: l.phone || '', attrs: 'dir="ltr" inputmode="tel"' })}${field('email', 'البريد', { type: 'email', value: l.email || '', attrs: 'dir="ltr"' })}
        ${select('status', 'المرحلة', LEAD_ST.map(([k, t]) => [k, t]), l.status)}${field('source', 'المصدر', { value: l.source || '', help: 'معرض، إنستقرام، توصية…' })}
        ${field('expected_value', 'القيمة المتوقعة', { type: 'money', value: l.expected_value ? money(l.expected_value) : '' })}${field('next_followup', 'موعد المتابعة', { type: 'date', value: l.next_followup || '' })}</div>
      ${field('notes', 'ملاحظات', { value: l.notes || '' })}
      ${l.id && !l.party_id && editable ? '<button type="button" class="btn secondary" id="tocust">تحويل لعميل</button>' : ''}${l.party_id ? `<p><a href="#/customers/${esc(l.party_id)}">صفحة العميل ←</a></p>` : ''}
      ${l.id && editable ? '<button type="button" class="btn ghost" id="dell" style="color:var(--c-danger)">حذف</button>' : ''}`,
      async v => { if (!v.name?.trim()) throw new AppError('الاسم مطلوب'); const ev = v.expected_value ? toHalalas(v.expected_value) : null;
        await api.saveLead({ ...(l.id ? { id: l.id } : {}), name: v.name.trim(), company: v.company || null, phone: toLatin(v.phone) || null, email: v.email || null, status: v.status, source: v.source || null, expected_value: ev, next_followup: v.next_followup || null, notes: v.notes || null });
        toast('حُفظ'); leadsView(); });
    if ($('#tocust', f)) $('#tocust', f).onclick = async () => { try { const p = await api.saveParty({ kind: 'customer', name: l.company || l.name, phone: l.phone, email: l.email });
        await api.saveLead({ id: l.id, party_id: p.id, status: 'won' }); toast('أُنشئ العميل'); location.hash = '#/customers/' + p.id; } catch (x) { fail(x); } };
    if ($('#dell', f)) $('#dell', f).onclick = async e => { if (!confirmBtn(e.target)) return; await api.deleteLead(l.id); f.closest('.drawer-bg').remove(); leadsView(); };
  };
  if ($('#newl')) $('#newl').onclick = () => open(null);
  $$('[data-l]').forEach(c => c.onclick = e => { if (e.target.closest('a')) return; open(ls.find(l => l.id === c.dataset.l)); });
}

// ---------- tasks ----------
const TASK_ST = [['todo', 'للتنفيذ', 'b-draft'], ['doing', 'قيد التنفيذ', 'b-warn'], ['done', 'منجزة', 'b-ok']];
async function tasksView(qs) {
  shell('tasks', loading()); const [ts, ccs, ms] = await Promise.all([api.listTasks(), api.listCostCenters(), can('users') ? api.listMembers().catch(() => []) : []]);
  const proj = qs?.get('project') || '', f = proj ? ts.filter(t => t.cost_center_id === proj) : ts, M = Object.fromEntries(ms.map(m => [m.user_id, m.email]));
  const editable = can_any_write();
  $('#main').innerHTML = `<div class="page-head"><h1>المهام</h1>${editable ? `<button class="btn primary" id="newt">${icon('plus')}مهمة</button>` : ''}</div>
    <div class="row" style="gap:8px;margin-bottom:16px;flex-wrap:wrap"><select class="input" id="tproj" style="height:38px;width:auto" aria-label="المشروع">${optList(ccs.map(c => [c.id, `${c.code} — ${c.name}`]), proj, '— كل المشاريع —')}</select>
      <span class="muted xs">${f.filter(t => t.status !== 'done' && t.due_date && t.due_date < riyadhToday()).length} متأخرة</span></div>
    <div class="kanban k3">${TASK_ST.map(([k, t, c]) => { const g = f.filter(x => x.status === k); return `<section class="kcol" data-drop="${k}"><h3>${badge([t, c])} <span class="muted num">${g.length}</span></h3>
      ${g.map(x => `<article class="card kcard" data-t="${esc(x.id)}"><b>${esc(x.title)}</b>${x.priority === 'high' ? ' ' + badge(['عاجل', 'b-bad']) : ''}
        ${x.cost_centers ? `<div class="xs muted">${esc(x.cost_centers.name)}</div>` : ''}${x.assignee ? `<div class="xs muted" dir="ltr" style="text-align:start">${esc(M[x.assignee] || '')}</div>` : ''}
        ${x.due_date ? `<div class="xs ${x.status !== 'done' && x.due_date < riyadhToday() ? 'down' : 'muted'}">الاستحقاق <span class="num">${esc(x.due_date)}</span></div>` : ''}
        <div class="row" style="gap:4px;margin-top:6px">${TASK_ST.filter(s => s[0] !== k).map(([s, st]) => `<button class="btn ghost sm" data-mv="${s}">${st}</button>`).join('')}</div></article>`).join('') || '<p class="muted xs">—</p>'}</section>`; }).join('')}</div>`;
  $('#tproj').onchange = e => location.hash = '#/tasks' + (e.target.value ? '?project=' + e.target.value : '');
  const open = t => { t = t || { status: 'todo', priority: 'normal', cost_center_id: proj };
    const fd = drawer(t.id ? 'مهمة' : 'مهمة جديدة', `${field('title', 'المهمة', { req: true, value: t.title || '' })}
      <div class="form-grid">${select('cost_center_id', 'المشروع', [['', '— بدون —'], ...ccs.map(c => [c.id, c.name])], t.cost_center_id || '')}${field('due_date', 'تاريخ الاستحقاق', { type: 'date', value: t.due_date || '' })}
        ${select('priority', 'الأولوية', [['low', 'منخفضة'], ['normal', 'عادية'], ['high', 'عاجلة']], t.priority)}${select('status', 'الحالة', TASK_ST.map(([k, s]) => [k, s]), t.status)}
        ${ms.length ? select('assignee', 'المسؤول', [['', '— بدون —'], ...ms.map(m => [m.user_id, m.email])], t.assignee || '') : ''}</div>
      ${field('notes', 'التفاصيل', { value: t.notes || '' })}${t.id ? '<button type="button" class="btn ghost" id="delt" style="color:var(--c-danger)">حذف</button>' : ''}`,
      async v => { if (!v.title?.trim()) throw new AppError('اكتب المهمة');
        await api.saveTask({ ...(t.id ? { id: t.id } : {}), title: v.title.trim(), cost_center_id: v.cost_center_id || null, due_date: v.due_date || null, priority: v.priority, status: v.status, assignee: v.assignee || null, notes: v.notes || null });
        toast('حُفظت المهمة'); tasksView(qs); });
    if ($('#delt', fd)) $('#delt', fd).onclick = async e => { if (!confirmBtn(e.target)) return; await api.deleteTask(t.id); fd.closest('.drawer-bg').remove(); tasksView(qs); };
  };
  if ($('#newt')) $('#newt').onclick = () => open(null);
  $('#main').addEventListener('click', async e => { const card = e.target.closest('[data-t]'); if (!card) return; const t = ts.find(x => x.id === card.dataset.t);
    const mv = e.target.closest('[data-mv]'); if (mv) { try { await api.saveTask({ id: t.id, status: mv.dataset.mv }); tasksView(qs); } catch (x) { fail(x); } return; }
    if (editable) open(t); });
}
const can_any_write = () => api.mode !== 'supabase' || ORG?.perms?._owner || Object.entries(ORG?.perms || {}).some(([k, v]) => k[0] !== '_' && Array.isArray(v) && v.some(a => a !== 'view'));

// ---------- commitments & renewals ----------
const COMMIT_KIND = { cr: 'سجل تجاري', license: 'رخصة', iqama: 'إقامة', passport: 'جواز سفر', insurance: 'تأمين', rent: 'إيجار', subscription: 'اشتراك', vehicle: 'استمارة / سيارة', contract: 'عقد', other: 'أخرى' };
async function commitmentsView() {
  shell('commitments', loading()); const [cs, emps] = await Promise.all([api.listCommitments(), can('hr') ? api.listEmployees().catch(() => []) : []]);
  const soon = cs.filter(c => daysTo(c.expiry_date) <= c.remind_days), editable = can('settings', 'create') || can('hr', 'create');
  $('#main').innerHTML = `<div class="page-head"><h1>الالتزامات والتجديدات</h1>${editable ? `<button class="btn primary" id="newc">${icon('plus')}التزام جديد</button>` : ''}</div>
    <p class="muted" style="margin:-8px 0 16px">السجل التجاري، الرخص، إقامات الموظفين، التأمين، الإيجارات والاشتراكات — يذكّرك النظام قبل انتهائها.</p>
    ${soon.length ? `<p class="note warn" style="margin-bottom:16px">${soon.length} التزام ينتهي قريباً أو منتهٍ — جدّده.</p>` : ''}
    ${cs.length ? `<div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>الالتزام</th><th>النوع</th><th class="m-hide">الموظف</th><th class="m-hide">الرقم</th><th>الانتهاء</th><th></th><th class="amt m-hide">التكلفة</th><th></th></tr></thead><tbody>
      ${cs.map(c => `<tr><td><b>${esc(c.title)}</b></td><td>${esc(COMMIT_KIND[c.kind])}</td><td class="m-hide">${esc(c.employees?.full_name || '—')}</td><td class="num m-hide">${esc(c.ref_number || '')}</td><td class="num">${esc(c.expiry_date)}</td><td>${dueBadge(c.expiry_date)}</td>
        <td class="amt num m-hide">${c.amount ? money(c.amount) : '—'}</td><td>${editable ? `<button class="btn ghost sm" data-ec="${esc(c.id)}">تعديل / تجديد</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
    : empty('bell', 'لا توجد التزامات', 'أضف السجل التجاري والرخص وإقامات العمال لتتابع تواريخ انتهائها.', editable ? `<button class="btn primary" id="newc2">${icon('plus')}التزام جديد</button>` : '')}`;
  const open = c => { c = c || { kind: 'cr', remind_days: 30 };
    const fd = drawer(c.id ? 'تعديل التزام' : 'التزام جديد', `${field('title', 'الاسم', { req: true, value: c.title || '', help: 'مثل: السجل التجاري الرئيسي، إقامة محمد' })}
      <div class="form-grid">${select('kind', 'النوع', Object.entries(COMMIT_KIND), c.kind)}${emps.length ? select('employee_id', 'الموظف (اختياري)', [['', '—'], ...emps.map(e => [e.id, e.full_name])], c.employee_id || '') : ''}
        ${field('ref_number', 'الرقم', { value: c.ref_number || '', attrs: 'dir="ltr"' })}${field('expiry_date', 'تاريخ الانتهاء', { type: 'date', value: c.expiry_date || '', req: true })}
        ${field('remind_days', 'التذكير قبل (يوم)', { value: c.remind_days, attrs: 'inputmode="numeric"' })}${field('amount', 'تكلفة التجديد', { type: 'money', value: c.amount ? money(c.amount) : '' })}</div>
      ${field('notes', 'ملاحظات', { value: c.notes || '' })}${c.id ? '<button type="button" class="btn ghost" id="delc" style="color:var(--c-danger)">حذف</button>' : ''}`,
      async v => { if (!v.title?.trim() || !v.expiry_date) throw new AppError('الاسم وتاريخ الانتهاء مطلوبان'); const rd = parseInt(toLatin(v.remind_days || '30'), 10);
        await api.saveCommitment({ ...(c.id ? { id: c.id } : {}), title: v.title.trim(), kind: v.kind, employee_id: v.employee_id || null, ref_number: v.ref_number || null, expiry_date: v.expiry_date, remind_days: Number.isFinite(rd) ? rd : 30, amount: v.amount ? toHalalas(v.amount) : null, notes: v.notes || null });
        toast('حُفظ'); commitmentsView(); });
    if ($('#delc', fd)) $('#delc', fd).onclick = async e => { if (!confirmBtn(e.target)) return; await api.deleteCommitment(c.id); fd.closest('.drawer-bg').remove(); commitmentsView(); };
  };
  ['#newc', '#newc2'].forEach(s => { if ($(s)) $(s).onclick = () => open(null); });
  $$('[data-ec]').forEach(b => b.onclick = () => open(cs.find(c => c.id === b.dataset.ec)));
}

// ---------- dashboard: calendar, alerts, top balances ----------
async function dashCalendar() {
  if (api.mode !== 'supabase') return '';
  const t = riyadhToday(), y = +t.slice(0, 4), m = +t.slice(5, 7) - 1, first = monthStart(y, m), last = monthEnd(y, m);
  const [notes, cs, docs] = await Promise.all([api.listNotes(first, last).catch(() => []), api.listCommitments().catch(() => []), can('sales') ? api.openDocuments(['tax_invoice', 'simplified_invoice']).catch(() => []) : []]);
  const ev = {}; const add = (d, h) => (ev[d] ||= []).push(h);
  notes.forEach(n => add(n.note_date, `<li class="${n.done ? 'muted' : ''}">📝 ${esc(n.title)}</li>`));
  cs.filter(c => c.expiry_date >= first && c.expiry_date <= last).forEach(c => add(c.expiry_date, `<li>⏳ انتهاء ${esc(c.title)}</li>`));
  docs.filter(d => d.due_date && d.due_date >= first && d.due_date <= last).forEach(d => add(d.due_date, `<li>💰 استحقاق <span class="num">${esc(d.number)}</span></li>`));
  const start = new Date(y, m, 1).getDay(), days = new Date(y, m + 1, 0).getDate();   // Sunday-first week
  const overdue = docs.filter(d => (d.due_date || d.issue_date) < t), expiring = cs.filter(c => daysTo(c.expiry_date) <= c.remind_days);
  let hijri = ''; try { hijri = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date()); } catch { hijri = ''; }
  return `${overdue.length || expiring.length ? `<section class="card" style="margin-bottom:24px;border-color:var(--c-danger)"><h2 style="margin-bottom:8px">${icon('alert')} تنبيهات</h2><ul style="margin:0;padding-inline-start:18px">
      ${overdue.length ? `<li><a href="#/reports/aging">${overdue.length} فاتورة متأخرة السداد</a> بإجمالي <b class="num">${money(overdue.reduce((s, d) => s + d.open, 0))}</b></li>` : ''}
      ${expiring.slice(0, 5).map(c => `<li><a href="#/commitments">${esc(c.title)}</a> — ${dueBadge(c.expiry_date)}</li>`).join('')}</ul></section>` : ''}
    <section class="card" style="margin-bottom:24px"><div class="row" style="justify-content:space-between;flex-wrap:wrap"><h2 style="margin:0">التقويم — ${AR_MONTHS[m]} ${y}</h2><span class="muted xs">${esc(hijri)}</span>
      <button class="btn ghost sm" id="addnote">${icon('plus')}ملاحظة / تذكير</button></div>
      <div class="cal">${['أحد', 'اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'].map(d => `<div class="cal-h">${d}</div>`).join('')}${'<div></div>'.repeat(start)}
        ${Array.from({ length: days }, (_, i) => { const d = `${y}-${String(m + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`; return `<div class="cal-d${d === t ? ' today' : ''}${ev[d] ? ' has' : ''}" data-day="${d}"><span class="num">${i + 1}</span>${ev[d] ? `<ul>${ev[d].join('')}</ul>` : ''}</div>`; }).join('')}</div></section>`;
}
function wireCalendar() {
  const note = day => drawer('ملاحظة / تذكير', `${field('note_date', 'التاريخ', { type: 'date', value: day || riyadhToday(), req: true })}${field('title', 'الملاحظة', { req: true })}
    <label class="row" style="gap:8px"><input type="checkbox" name="shared"> مشاركة مع فريق الشركة</label>`, async v => { if (!v.title?.trim()) throw new AppError('اكتب الملاحظة');
    await api.saveNote({ note_date: v.note_date, title: v.title.trim(), shared: !!v.shared }); toast('حُفظت'); dashboardView(); });
  if ($('#addnote')) $('#addnote').onclick = () => note();
  $$('.cal-d').forEach(c => c.ondblclick = () => note(c.dataset.day));
}
async function topBalances() {
  if (api.mode !== 'supabase') return '';
  const [ar, ap] = await Promise.all([can('sales') ? api.openDocuments(['tax_invoice', 'simplified_invoice']).catch(() => []) : [], can('purchases') ? api.openDocuments(['purchase_bill']).catch(() => []) : []]);
  const top = docs => { const by = {}; docs.forEach(d => { const k = d.party_id || '_'; (by[k] ||= { id: d.party_id, name: d.party_name, v: 0, n: 0 }); by[k].v += d.open; by[k].n++; }); return Object.values(by).sort((a, b) => b.v - a.v).slice(0, 5); };
  const card = (t, rows, link, color) => { const max = Math.max(1, ...rows.map(r => r.v)); return `<section class="card"><h3 style="margin-bottom:10px">${t}</h3>${rows.length ? rows.map((r, i) => `<div style="margin-bottom:10px"><div class="row" style="justify-content:space-between"><span><span class="muted num">${i + 1}.</span> ${r.id ? `<a href="#/${link}/${esc(r.id)}">${esc(r.name)}</a>` : esc(r.name)} <span class="xs muted">(${r.n} فاتورة)</span></span><b class="num">${money(r.v)}</b></div>
      <div class="bar" style="margin-top:4px"><i style="width:${(r.v / max * 100).toFixed(0)}%;background:${color}"></i></div></div>`).join('') : '<p class="muted">لا توجد أرصدة مفتوحة.</p>'}</section>`; };
  if (!can('sales') && !can('purchases')) return '';
  return `<div class="grid g2" style="margin-bottom:24px">${can('sales') ? card('أعلى 5 أرصدة عملاء', top(ar), 'customers', '#257de0') : ''}${can('purchases') ? card('أعلى 5 أرصدة موردين', top(ap), 'suppliers', '#f47230') : ''}</div>`;
}

// ---------- HR: leaves ----------
const LEAVE_KIND = { annual: 'سنوية', sick: 'مرضية', unpaid: 'بدون راتب', emergency: 'اضطرارية', hajj: 'حج', maternity: 'وضع', other: 'أخرى' };
async function leavesView(qs) {
  shell('leaves', loading()); const y = +riyadhToday().slice(0, 4);
  const [ls, bal, emps] = await Promise.all([api.listLeaves(), api.leaveBalances(y), api.listEmployees()]);
  const tab = qs?.get('tab') || 'req', canPost = can('hr', 'post'), editable = can('hr', 'create');
  const pend = ls.filter(l => l.status === 'pending'), now = riyadhToday(), onLeave = ls.filter(l => l.status === 'approved' && l.start_date <= now && l.end_date >= now);
  $('#main').innerHTML = `<div class="page-head"><h1>الإجازات</h1>${editable ? `<button class="btn primary" id="newlv">${icon('plus')}طلب إجازة</button>` : ''}</div>
    <div class="grid g4" style="margin-bottom:20px">${[['بانتظار الاعتماد', pend.length], ['في إجازة اليوم', onLeave.length], ['أيام مستخدمة هذه السنة', bal.reduce((s, b) => s + b.used, 0)], ['أيام متبقية للجميع', bal.reduce((s, b) => s + b.remaining, 0)]].map(([t, v]) => `<div class="card stat"><div class="label">${t}</div><div class="val num">${v}</div></div>`).join('')}</div>
    <div class="tabs"><a href="#/leaves" class="${tab === 'req' ? 'on' : ''}">الطلبات</a><a href="#/leaves?tab=bal" class="${tab === 'bal' ? 'on' : ''}">أرصدة الموظفين ${y}</a></div>
    ${tab === 'bal' ? `<div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>الموظف</th><th class="amt">الاستحقاق السنوي</th><th class="amt">المستخدم</th><th class="amt">المتبقي</th><th></th></tr></thead><tbody>
        ${bal.map(b => `<tr><td>${esc(b.full_name)}</td><td class="amt num">${b.entitlement}</td><td class="amt num">${b.used}</td><td class="amt num"><b class="${b.remaining < 0 ? 'down' : ''}">${b.remaining}</b></td><td><div class="bar"><i style="width:${Math.min(100, b.used / Math.max(1, b.entitlement) * 100).toFixed(0)}%"></i></div></td></tr>`).join('')}</tbody></table></div>
      <p class="xs muted" style="margin-top:8px">حسب نظام العمل: 21 يوماً، و30 يوماً لمن أمضى 5 سنوات. يمكن تعديل الاستحقاق من ملف الموظف.</p>`
    : ls.length ? `<div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>الموظف</th><th>النوع</th><th>من</th><th>إلى</th><th class="amt">الأيام</th><th>الحالة</th><th></th></tr></thead><tbody>
        ${ls.map(l => `<tr><td>${esc(l.employees?.full_name)}</td><td>${esc(LEAVE_KIND[l.kind])}</td><td class="num">${esc(l.start_date)}</td><td class="num">${esc(l.end_date)}</td><td class="amt num">${fq(l.days)}</td>
          <td>${badge(l.status === 'pending' ? ['بانتظار الاعتماد', 'b-warn'] : l.status === 'approved' ? ['معتمدة', 'b-ok'] : ['مرفوضة', 'b-bad'])}</td>
          <td>${l.status === 'pending' ? `${canPost ? `<button class="btn secondary sm" data-ap="${esc(l.id)}">اعتماد</button><button class="btn ghost sm" data-rj="${esc(l.id)}">رفض</button>` : ''}${editable ? `<button class="btn ghost sm" data-dl="${esc(l.id)}" style="color:var(--c-danger)">حذف</button>` : ''}` : ''}</td></tr>`).join('')}</tbody></table></div>`
    : empty('users', 'لا توجد طلبات إجازة', 'سجّل طلبات الإجازات ليعتمدها المدير، ويُحسب الرصيد المتبقي لكل موظف تلقائياً.')}`;
  if ($('#newlv')) $('#newlv').onclick = () => drawer('طلب إجازة', `<div class="field"><label for="f-employee_id">الموظف</label><select class="input" id="f-employee_id" name="employee_id">${optList(emps.filter(e => e.status !== 'terminated').map(e => [e.id, e.full_name]), '', '— اختر —')}</select></div>
      ${select('kind', 'النوع', Object.entries(LEAVE_KIND), 'annual')}<div class="form-grid">${field('start_date', 'من', { type: 'date', req: true, value: now })}${field('end_date', 'إلى', { type: 'date', req: true, value: now })}</div>${field('note', 'ملاحظة', {})}`,
    async v => { if (!v.employee_id) throw new AppError('اختر الموظف'); if (!v.start_date || !v.end_date || v.end_date < v.start_date) throw new AppError('تحقق من التواريخ');
      await api.saveLeave({ employee_id: v.employee_id, kind: v.kind, start_date: v.start_date, end_date: v.end_date, note: v.note || null }); toast('أُرسل الطلب للاعتماد'); leavesView(qs); }, 'إرسال');
  const act = (sel, fn, msg) => $$(sel).forEach(b => b.onclick = async () => { b.disabled = true; try { await fn(b); toast(msg); leavesView(qs); } catch (x) { fail(x); b.disabled = false; } });
  act('[data-ap]', b => api.decideLeave(b.dataset.ap, true), 'اعتُمدت الإجازة'); act('[data-rj]', b => api.decideLeave(b.dataset.rj, false), 'رُفض الطلب'); act('[data-dl]', b => api.deleteLeave(b.dataset.dl), 'حُذف');
}

// ---------- HR: attendance ----------
async function attendanceView(qs) {
  shell('attendance', loading()); const day = qs?.get('day') || riyadhToday();
  const [emps, rows, leaves] = await Promise.all([api.listEmployees(), api.listAttendance(day), api.listLeaves()]);
  const act = emps.filter(e => e.status !== 'terminated' && e.hire_date <= day), R = Object.fromEntries(rows.map(r => [r.employee_id, r])), editable = can('hr', 'create');
  const onLeave = new Set(leaves.filter(l => l.status === 'approved' && l.start_date <= day && l.end_date >= day).map(l => l.employee_id));
  const ST = { present: 'حاضر', late: 'متأخر', absent: 'غائب', leave: 'إجازة', holiday: 'عطلة' };
  $('#main').innerHTML = `<div class="page-head"><h1>الحضور والانصراف</h1><input class="input" type="date" id="aday" value="${esc(day)}" style="height:38px;width:auto" aria-label="اليوم">
      <button class="btn secondary" id="amon">${icon('down')}ملخص الشهر (CSV)</button></div>
    <div class="grid g4" style="margin-bottom:16px">${Object.entries(ST).slice(0, 4).map(([k, t]) => `<div class="card stat"><div class="label">${t}</div><div class="val num">${act.filter(e => (R[e.id]?.status || (onLeave.has(e.id) ? 'leave' : '')) === k).length}</div></div>`).join('')}</div>
    ${act.length ? `<form id="atf"><div class="tbl-wrap editor"><table><thead><tr><th>الموظف</th><th style="width:130px">الدخول</th><th style="width:130px">الخروج</th><th style="width:140px">الحالة</th><th>ملاحظة</th></tr></thead><tbody>
      ${act.map(e => { const r = R[e.id] || { status: onLeave.has(e.id) ? 'leave' : 'present' }; return `<tr data-e="${esc(e.id)}"><td><b>${esc(e.full_name)}</b><div class="xs muted">${esc(e.job_title || '')}</div></td>
        <td><input class="input num" type="time" data-k="check_in" value="${esc((r.check_in || '').slice(0, 5))}" ${editable ? '' : 'disabled'} aria-label="الدخول"></td><td><input class="input num" type="time" data-k="check_out" value="${esc((r.check_out || '').slice(0, 5))}" ${editable ? '' : 'disabled'} aria-label="الخروج"></td>
        <td><select class="input" data-k="status" ${editable ? '' : 'disabled'} aria-label="الحالة">${optList(Object.entries(ST), r.status)}</select></td><td><input class="input" data-k="note" value="${esc(r.note || '')}" ${editable ? '' : 'disabled'} aria-label="ملاحظة"></td></tr>`; }).join('')}</tbody></table></div>
      ${editable ? `<div class="row" style="justify-content:space-between;margin-top:12px"><button type="button" class="btn ghost sm" id="allp">الكل حاضر 7:30 – 16:30</button><button class="btn primary" type="submit">حفظ حضور اليوم</button></div>` : ''}</form>`
    : empty('users', 'لا يوجد موظفون', 'أضف الموظفين أولاً.', '<a class="btn primary" href="#/employees">الموظفون</a>')}`;
  $('#aday').onchange = e => location.hash = '#/attendance?day=' + e.target.value;
  if ($('#allp')) $('#allp').onclick = () => $$('#atf tr[data-e]').forEach(tr => { const s = $('[data-k=status]', tr); if (s.value === 'leave') return; s.value = 'present'; $('[data-k=check_in]', tr).value ||= '07:30'; $('[data-k=check_out]', tr).value ||= '16:30'; });
  if ($('#atf')) $('#atf').onsubmit = async e => { e.preventDefault(); const rs = $$('#atf tr[data-e]').map(tr => ({ employee_id: tr.dataset.e, day, check_in: $('[data-k=check_in]', tr).value || null, check_out: $('[data-k=check_out]', tr).value || null, status: $('[data-k=status]', tr).value, note: $('[data-k=note]', tr).value || null }));
    if (rs.some(r => r.check_in && r.check_out && r.check_out < r.check_in)) return toast('وقت الخروج قبل الدخول', 'bad');
    $('[type=submit]', e.target).disabled = true; try { await api.saveAttendance(rs); toast('حُفظ الحضور'); attendanceView(qs); } catch (x) { fail(x); $('[type=submit]', e.target).disabled = false; } };
  $('#amon').onclick = async () => { const m = day.slice(0, 7), y = +m.slice(0, 4), mo = +m.slice(5) - 1, rs = await api.attendanceRange(monthStart(y, mo), monthEnd(y, mo));
    dl([['الموظف', 'حاضر', 'متأخر', 'غائب', 'إجازة', 'ساعات العمل'], ...act.map(e => { const mine = rs.filter(r => r.employee_id === e.id), c = k => mine.filter(r => r.status === k).length;
      const h = mine.reduce((s, r) => s + (r.check_in && r.check_out ? (new Date(`2000-01-01T${r.check_out}`) - new Date(`2000-01-01T${r.check_in}`)) / 36e5 : 0), 0);
      return [e.full_name, c('present'), c('late'), c('absent'), c('leave'), h.toFixed(1)]; })], `حضور ${m}`); };
}

// ---------- HR: performance evaluations ----------
const EVAL_ITEMS = ['المهارات الوظيفية والمعرفة اللازمة', 'الإنتاجية وجودة العمل', 'تقبّل التوجيهات وسرعة الاستجابة', 'دقة إنجاز المهام', 'المبادرة', 'القدرة على التعلم', 'تحمّل المسؤولية والالتزام بالمواعيد', 'التعاون مع الزملاء وروح الفريق', 'الالتزام بالسلوكيات ولوائح العمل', 'الحضور والانصراف'];
const EVAL_DEC = { continue: 'الاستمرار في العمل', promote: 'ترقية', raise: 'زيادة راتب', extend_probation: 'تمديد فترة التجربة', warning: 'إنذار', terminate: 'إنهاء الخدمة' };
async function evaluationsView() {
  shell('evaluations', loading()); const [es, emps] = await Promise.all([api.listEvaluations(), api.listEmployees()]), editable = can('hr', 'create');
  const grade = t => t >= 90 ? ['ممتاز', 'b-ok'] : t >= 75 ? ['جيد جداً', 'b-ok'] : t >= 60 ? ['جيد', 'b-info'] : t >= 50 ? ['مقبول', 'b-warn'] : ['ضعيف', 'b-bad'];
  $('#main').innerHTML = `<div class="page-head"><h1>تقييم أداء الموظفين</h1>${editable ? `<button class="btn primary" id="newev">${icon('plus')}تقييم جديد</button>` : ''}</div>
    ${es.length ? `<div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>الموظف</th><th>التاريخ</th><th>النوع</th><th class="amt">الدرجة</th><th>التقدير</th><th>القرار</th></tr></thead><tbody>
      ${es.map(e => { const t = e.scores.reduce((a, b) => a + b, 0); return `<tr><td>${esc(e.employees?.full_name)}</td><td class="num">${esc(e.eval_date)}</td><td>${e.kind === 'annual' ? 'سنوي' : e.kind === 'probation' ? 'فترة تجربة' : 'ربع سنوي'}</td><td class="amt num">${t} / 100</td><td>${badge(grade(t))}</td><td>${esc(EVAL_DEC[e.decision] || '—')}</td></tr>`; }).join('')}</tbody></table></div>`
    : empty('users', 'لا توجد تقييمات بعد', '10 معايير من 0 إلى 10 لكل موظف، مع نقاط القوة والتطوير والقرار.')}`;
  if ($('#newev')) $('#newev').onclick = () => { const f = drawer('تقييم أداء', `<div class="field"><label for="f-employee_id">الموظف</label><select class="input" id="f-employee_id" name="employee_id">${optList(emps.filter(e => e.status !== 'terminated').map(e => [e.id, e.full_name]), '', '— اختر —')}</select></div>
      <div class="form-grid">${select('kind', 'نوع التقييم', [['annual', 'سنوي'], ['probation', 'فترة تجربة'], ['quarterly', 'ربع سنوي']], 'annual')}${field('eval_date', 'التاريخ', { type: 'date', value: riyadhToday() })}</div>
      ${EVAL_ITEMS.map((t, i) => `<div class="field"><label for="sc${i}">${i + 1}. ${t} — <b class="num" id="sv${i}">7</b>/10</label><input type="range" min="0" max="10" value="7" id="sc${i}" name="s${i}" style="width:100%"></div>`).join('')}
      <p><b>المجموع: <span class="num" id="stot">70</span> / 100</b></p>${field('strengths', 'نقاط القوة', {})}${field('improvements', 'توجيهات التطوير', {})}${select('decision', 'القرار / التوصية', Object.entries(EVAL_DEC), 'continue')}`,
    async v => { if (!v.employee_id) throw new AppError('اختر الموظف'); const scores = EVAL_ITEMS.map((_, i) => parseInt(v['s' + i], 10));
      await api.saveEvaluation({ employee_id: v.employee_id, kind: v.kind, eval_date: v.eval_date, scores, strengths: v.strengths || null, improvements: v.improvements || null, decision: v.decision }); toast('حُفظ التقييم'); evaluationsView(); }, 'حفظ التقييم');
    $$('input[type=range]', f).forEach((r, i) => r.oninput = () => { $(`#sv${i}`, f).textContent = r.value; $('#stot', f).textContent = $$('input[type=range]', f).reduce((s, x) => s + +x.value, 0); }); };
}

const EXT_ROUTES = [
  [/^#\/ledger\/([\w-]+)(\?.*)?$/, gate('accounts', 'كشف الحساب', 'accounting|reports', m => ledgerView(m[1], new URLSearchParams((m[2] || '').slice(1))))],
  [/^#\/opening$/, gate('accounts', 'الأرصدة الافتتاحية', 'accounting', openingView)],
  [/^#\/assets$/, gate('assets', 'الأصول الثابتة', 'accounting', assetsView)],
  [/^#\/custody$/, gate('custody', 'العهد', 'expenses', custodyView)],
  [/^#\/card-settlement$/, gate('card-settle', 'تسوية الشبكة', 'sales|accounting', cardSettleView)],
  [/^#\/leads$/, gate('leads', 'العملاء المحتملون', 'sales', leadsView)],
  [/^#\/tasks(\?.*)?$/, gate('tasks', 'المهام', 'sales|purchases|expenses|inventory|manufacturing|accounting|reports|hr|settings|users', m => tasksView(new URLSearchParams((m[1] || '').slice(1))))],
  [/^#\/commitments$/, gate('commitments', 'الالتزامات والتجديدات', 'settings|hr|accounting|sales|purchases|inventory|manufacturing|expenses|reports|users', commitmentsView)],
  [/^#\/leaves(\?.*)?$/, gate('leaves', 'الإجازات', 'hr', m => leavesView(new URLSearchParams((m[1] || '').slice(1))))],
  [/^#\/attendance(\?.*)?$/, gate('attendance', 'الحضور', 'hr', m => attendanceView(new URLSearchParams((m[1] || '').slice(1))))],
  [/^#\/evaluations$/, gate('evaluations', 'تقييم الأداء', 'hr', evaluationsView)],
  ...docRoutes('delivery-notes'),
];
