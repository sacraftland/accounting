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
  const tot = () => { let s = 0; const vr = []; cart.forEach(l => { const it = I[l.id], r = it.tax_category === 'S' ? 15 : 0; const k = lineCalc({ qty: l.qty, unit_price: Number(it.sale_price), discount: 0, vat_rate: r }); s += k.net; vr.push([k.net, r]); }); const v = docVat(vr); return { s, v, t: s + v }; };
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
  let qr = '', qm = null; try { const ts = `${d.issue_date}T${(d.issue_time || '00:00:00').slice(0, 8)}+03:00`;
    qm = QR.encode(QR.ascii(QR.zatcaTLV({ seller: ORG.name_ar, vatNo: ORG.vat_number || '', timestamp: new Date(ts).toISOString().replace('.000', ''), total: (d.total / 100).toFixed(2), vat: (d.vat_total / 100).toFixed(2) })));
    qr = QR.svg(qm, 3); } catch { qr = ''; qm = null; }
  window.__lastReceipt = () => receiptCanvas(d, method, paid, opt, qm, (localStorage.getItem(POS_PAPER) === '58') ? 384 : 576).toDataURL('image/png');
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
    <div class="row no-print" style="gap:8px;justify-content:center;margin-top:12px">${ANDROID ? `<button class="btn primary" id="rraw">${icon('down')}طباعة مباشرة (RawBT)</button>` : ''}<button class="btn ${ANDROID ? 'secondary' : 'primary'}" id="rprint">${icon('down')}${ANDROID ? 'طباعة عبر المتصفح' : 'طباعة الإيصال'}</button><button class="btn secondary" id="rnew">${opt.reprint ? 'إغلاق' : 'بيع جديد'}</button>${opt.reprint ? '' : `<a class="btn ghost" href="#/invoices/${esc(d.id)}">عرض الفاتورة</a>`}</div></div>`;
  document.body.append(bg);
  const close = () => { bg.remove(); $('#posq')?.focus(); };
  $('#rnew', bg).onclick = close; bg.onclick = e => { if (e.target === bg) close(); };
  bg.querySelectorAll('[data-paper]').forEach(b => b.onclick = () => { try { localStorage.setItem(POS_PAPER, b.dataset.paper); } catch { /* private mode */ }
    $('#rcpt', bg).classList.toggle('rc58', b.dataset.paper === '58');
    bg.querySelectorAll('[data-paper]').forEach(x => { const on = x === b; x.className = 'btn sm ' + (on ? 'primary' : 'secondary'); x.setAttribute('aria-pressed', on); }); });
  if ($('#rraw', bg)) $('#rraw', bg).onclick = () => { const c = receiptCanvas(d, method, paid, opt, qm, paper() === '58' ? 384 : 576);
    location.href = 'rawbt:base64,' + escposRaster(c); };
  $('#rprint', bg).onclick = () => { document.body.classList.add('print-receipt');
    // page = exactly the receipt: paper width × receipt height, so the printer driver neither shrinks an A4 page nor feeds blank paper
    const w = paper() === '58' ? 58 : 80, el = $('#rcpt', bg), st = document.createElement('style'); st.id = 'rc-page';
    const h = Math.ceil(el.scrollHeight * 25.4 / 96 * (w / (el.getBoundingClientRect().width * 25.4 / 96 || w))) + 12;
    st.textContent = `@page { size: ${w}mm ${Math.max(h, 60)}mm; margin: 0; }`; document.querySelectorAll('#rc-page').forEach(x => x.remove()); document.head.append(st);
    window.print(); setTimeout(() => { document.body.classList.remove('print-receipt'); st.remove(); }, 800); };
  $('#rnew', bg).focus();
}

const ANDROID = /android/i.test(navigator.userAgent);
// The receipt as a black-and-white picture at the printer's own resolution (58 mm = 384 dots, 80 mm = 576 dots at 203 dpi).
// Thermal print apps (RawBT) print a picture edge to edge, so nothing depends on how the browser lays out a page.
function receiptCanvas(d, method, paid, opt = {}, qm = null, W = 384) {
  const k = W / 384, pad = Math.round(8 * k), F = n => Math.round(n * k), FONT = '"IBM Plex Sans Arabic","Noto Sans Arabic","Noto Naskh Arabic",Tahoma,sans-serif';
  const rows = [];   // [kind, ...] — measured twice: once for height, once to draw
  const line = (t, size = 22, bold = false, align = 'center') => rows.push(['t', t, size, bold, align]);
  const pair = (a, b, size = 21, bold = false) => rows.push(['p', a, b, size, bold]);
  const rule = () => rows.push(['r']), gap = h => rows.push(['g', h]);
  line(ORG.name_ar, 28, true); if (ORG.vat_number) line('الرقم الضريبي ' + ORG.vat_number, 20); if (ORG.city) line(ORG.city, 20);
  gap(6); line(d.kind === 'tax_invoice' ? 'فاتورة ضريبية' : 'فاتورة ضريبية مبسطة', 23, true); line(d.kind === 'tax_invoice' ? 'Tax Invoice' : 'Simplified Tax Invoice', 19);
  if (opt.reprint) line('(نسخة)', 18); gap(6);
  pair('الرقم', d.number || ''); pair('التاريخ', `${d.issue_date} ${(d.issue_time || '').slice(0, 5)}`); if (d.party) pair('العميل', d.party.name); rule();
  d.lines.forEach(l => { line(l.description || '', 21, true, 'right'); pair(`${fq(l.qty)} × ${money(l.unit_price)}`, money(Number(l.line_net) + Number(l.line_vat)), 20); gap(4); }); rule();
  pair('الإجمالي قبل الضريبة', money(d.subtotal)); pair('ضريبة القيمة المضافة 15%', money(d.vat_total)); pair('الإجمالي', money(d.total) + ' ر.س', 26, true);
  if (method) pair('الدفع', method === 'cash' ? 'نقداً' : 'شبكة / مدى');
  if (paid) { pair('المستلم', money(paid)); pair('الباقي', money(paid - d.total)); }
  if (opt.reprint && d.total - d.amount_paid > 0) pair('المتبقي', money(d.total - d.amount_paid));
  if (qm) rows.push(['q']); line(ORG.invoice_footer || 'شكراً لزيارتكم', 19); gap(F(40) / k);
  const c = document.createElement('canvas'), x = c.getContext('2d'), qs = Math.min(W - 2 * pad, F(230));
  const wrap = (t, size, bold, maxW) => { x.font = `${bold ? 700 : 500} ${F(size)}px ${FONT}`; const out = []; let cur = '';
    String(t).split(/\s+/).forEach(w => { const tryL = cur ? cur + ' ' + w : w; if (x.measureText(tryL).width > maxW && cur) { out.push(cur); cur = w; } else cur = tryL; }); out.push(cur); return out; };
  const pass = draw => { let y = pad; for (const r of rows) {
    if (r[0] === 't') { for (const ln of wrap(r[1], r[2], r[3], W - 2 * pad)) { const h = F(r[2] * 1.45); if (draw) { x.font = `${r[3] ? 700 : 500} ${F(r[2])}px ${FONT}`; x.direction = 'rtl'; x.textAlign = r[4] === 'right' ? 'right' : 'center'; x.fillText(ln, r[4] === 'right' ? W - pad : W / 2, y + F(r[2])); } y += h; } }
    else if (r[0] === 'p') { const h = F(r[3] * 1.5); if (draw) { x.font = `${r[4] ? 700 : 500} ${F(r[3])}px ${FONT}`; x.direction = 'rtl'; x.textAlign = 'right'; x.fillText(r[1], W - pad, y + F(r[3]));
        x.direction = 'ltr'; x.textAlign = 'left'; x.fillText(r[2], pad, y + F(r[3])); } y += h; }
    else if (r[0] === 'r') { if (draw) { x.setLineDash([F(6), F(4)]); x.lineWidth = Math.max(2, F(2)); x.beginPath(); x.moveTo(pad, y + F(8)); x.lineTo(W - pad, y + F(8)); x.stroke(); x.setLineDash([]); } y += F(18); }
    else if (r[0] === 'g') y += F(r[1]);
    else if (r[0] === 'q') { const n = qm.length, m = Math.floor(qs / (n + 8)), sz = m * (n + 8), ox = Math.round((W - sz) / 2) + 4 * m;
      if (draw) qm.forEach((row, j) => row.forEach((v, i) => { if (v) x.fillRect(ox + i * m, y + 4 * m + j * m, m, m); })); y += sz; } }
    return y; };
  c.width = W; c.height = 10; c.height = Math.ceil(pass(false) + pad);
  x.fillStyle = '#fff'; x.fillRect(0, 0, W, c.height); x.fillStyle = '#000'; x.strokeStyle = '#000'; pass(true);
  return c;
}
window.receiptCanvas = receiptCanvas;
// Canvas → ESC/POS raster bytes (GS v 0, in bands so small printer buffers keep up) → base64 for RawBT's rawbt:base64 link.
// Sending printer commands (not a PNG) means RawBT passes them straight to the printer: nothing to decode or rescale.
function escposRaster(c) {
  const W = c.width, H = c.height, px = c.getContext('2d').getImageData(0, 0, W, H).data, bw = Math.ceil(W / 8), out = [0x1b, 0x40];
  for (let y0 = 0; y0 < H; y0 += 128) {
    const h = Math.min(128, H - y0); out.push(0x1d, 0x76, 0x30, 0, bw & 255, bw >> 8, h & 255, h >> 8);
    for (let y = y0; y < y0 + h; y++) for (let b = 0; b < bw; b++) { let v = 0;
      for (let i = 0; i < 8; i++) { const x = b * 8 + i; if (x < W) { const k = (y * W + x) * 4; if (px[k + 3] > 0 && px[k] * .299 + px[k + 1] * .587 + px[k + 2] * .114 < 160) v |= 0x80 >> i; } }
      out.push(v); }
  }
  out.push(0x1b, 0x64, 4, 0x1d, 0x56, 0x42, 0);           // feed 4 lines, cut if the printer has a cutter
  let bin = ''; for (let i = 0; i < out.length; i += 8192) bin += String.fromCharCode.apply(null, out.slice(i, i + 8192));
  return btoa(bin);
}
window.escposRaster = escposRaster;

const POS_ROUTES = [
  [/^#\/pos$/, gate('pos', 'نقطة البيع', 'sales', posView)],
];
