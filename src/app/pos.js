// =====================================================================
// Point of sale (cashier) and projects / cost centers.
// Inserted into app.js by build.py after reports.js — shares its helpers.
// =====================================================================

// ---------- point of sale ----------
const POS_CART = 'daftar-pos-cart', POS_PAPER = 'daftar-pos-paper';
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
function posReceipt(d, method, paid, opt = {}) {
  let qr = ''; try { const ts = `${d.issue_date}T${(d.issue_time || '00:00:00').slice(0, 8)}+03:00`;
    qr = QR.svg(QR.encode(QR.ascii(QR.zatcaTLV({ seller: ORG.name_ar, vatNo: ORG.vat_number || '', timestamp: new Date(ts).toISOString().replace('.000', ''), total: (d.total / 100).toFixed(2), vat: (d.vat_total / 100).toFixed(2) }))), 3); } catch { qr = ''; }
  const bg = document.createElement('div'); bg.className = 'drawer-bg receipt-bg';
  const paper = () => { try { return localStorage.getItem(POS_PAPER) === '58' ? '58' : '80'; } catch { return '80'; } };
  bg.innerHTML = `<div class="receipt-wrap"><div class="row no-print rc-paper" role="group" aria-label="مقاس ورق الطابعة" style="gap:6px;justify-content:center;margin-bottom:10px"><span class="xs" style="color:#fff">مقاس الورق:</span>${['58', '80'].map(w => `<button type="button" class="btn sm ${paper() === w ? 'primary' : 'secondary'}" data-paper="${w}" aria-pressed="${paper() === w}">${w} ملم</button>`).join('')}</div><div class="receipt80${paper() === '58' ? ' rc58' : ''}" id="rcpt">
      <div style="text-align:center"><b style="font-size:15px">${esc(ORG.name_ar)}</b><br>${ORG.vat_number ? `الرقم الضريبي <span class="num">${esc(ORG.vat_number)}</span><br>` : ''}${esc(ORG.city || '')}
        <div style="margin:6px 0;font-weight:700">${d.kind === 'tax_invoice' ? 'فاتورة ضريبية<br><span style="font-weight:400">Tax Invoice</span>' : 'فاتورة ضريبية مبسطة<br><span style="font-weight:400">Simplified Tax Invoice</span>'}</div>${opt.reprint ? '<div style="font-size:11px">(نسخة)</div>' : ''}</div>
      <div class="rc-row"><span>الرقم</span><span class="num">${esc(d.number)}</span></div><div class="rc-row"><span>التاريخ</span><span class="num">${esc(d.issue_date)} ${esc((d.issue_time || '').slice(0, 5))}</span></div>
      ${d.party ? `<div class="rc-row"><span>العميل</span><span>${esc(d.party.name)}</span></div>` : ''}<hr>
      ${d.lines.map(l => `<div>${esc(l.description)}</div><div class="rc-row xs"><span class="num">${fq(l.qty)} × ${money(l.unit_price)}</span><span class="num">${money(Number(l.line_net) + Number(l.line_vat))}</span></div>`).join('')}<hr>
      <div class="rc-row"><span>الإجمالي قبل الضريبة</span><span class="num">${money(d.subtotal)}</span></div><div class="rc-row"><span>ضريبة القيمة المضافة 15%</span><span class="num">${money(d.vat_total)}</span></div>
      <div class="rc-row" style="font-weight:800;font-size:15px"><span>الإجمالي</span><span class="num">${money(d.total)} ر.س</span></div>
      ${method ? `<div class="rc-row"><span>الدفع</span><span>${method === 'cash' ? 'نقداً' : 'شبكة / مدى'}</span></div>` : ''}${opt.reprint && d.total - d.amount_paid > 0 ? `<div class="rc-row"><span>المتبقي</span><span class="num">${money(d.total - d.amount_paid)}</span></div>` : ''}
      ${paid ? `<div class="rc-row"><span>المستلم</span><span class="num">${money(paid)}</span></div><div class="rc-row"><span>الباقي</span><span class="num">${money(paid - d.total)}</span></div>` : ''}
      <div style="text-align:center;margin-top:8px">${qr}</div>${ORG.invoice_footer ? `<p style="text-align:center;font-size:11px;margin:6px 0 0">${esc(ORG.invoice_footer)}</p>` : '<p style="text-align:center;font-size:11px;margin:6px 0 0">شكراً لزيارتكم</p>'}</div>
    <div class="row no-print" style="gap:8px;justify-content:center;margin-top:12px"><button class="btn primary" id="rprint">${icon('down')}طباعة الإيصال</button><button class="btn secondary" id="rnew">${opt.reprint ? 'إغلاق' : 'بيع جديد'}</button>${opt.reprint ? '' : `<a class="btn ghost" href="#/invoices/${esc(d.id)}">عرض الفاتورة</a>`}</div></div>`;
  document.body.append(bg);
  const close = () => { bg.remove(); $('#posq')?.focus(); };
  $('#rnew', bg).onclick = close; bg.onclick = e => { if (e.target === bg) close(); };
  bg.querySelectorAll('[data-paper]').forEach(b => b.onclick = () => { try { localStorage.setItem(POS_PAPER, b.dataset.paper); } catch { /* private mode */ }
    $('#rcpt', bg).classList.toggle('rc58', b.dataset.paper === '58');
    bg.querySelectorAll('[data-paper]').forEach(x => { const on = x === b; x.className = 'btn sm ' + (on ? 'primary' : 'secondary'); x.setAttribute('aria-pressed', on); }); });
  $('#rprint', bg).onclick = () => { document.body.classList.add('print-receipt');
    // page = exactly the receipt: paper width × receipt height, so the printer driver neither shrinks an A4 page nor feeds blank paper
    const w = paper() === '58' ? 58 : 80, el = $('#rcpt', bg), st = document.createElement('style'); st.id = 'rc-page';
    const h = Math.ceil(el.scrollHeight * 25.4 / 96 * (w / (el.getBoundingClientRect().width * 25.4 / 96 || w))) + 12;
    st.textContent = `@page { size: ${w}mm ${Math.max(h, 60)}mm; margin: 0; }`; document.querySelectorAll('#rc-page').forEach(x => x.remove()); document.head.append(st);
    window.print(); setTimeout(() => { document.body.classList.remove('print-receipt'); st.remove(); }, 800); };
  $('#rnew', bg).focus();
}

const POS_ROUTES = [
  [/^#\/pos$/, gate('pos', 'نقطة البيع', 'sales', posView)],
];
