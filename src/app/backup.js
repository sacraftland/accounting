// =====================================================================
// Full backup & restore, export of every table to Excel, and the files for
// the dedicated Linux backup computer. Also a tiny .xlsx writer used by the
// report builder. Inserted after feasibility.js.
// =====================================================================
const BACKUP_PY = /*@@BACKUP_PY@@*/'';
const TBL_AR = { accounts: 'شجرة الحسابات', journal_entries: 'القيود', journal_lines: 'أسطر القيود', documents: 'المستندات', document_lines: 'أسطر المستندات', parties: 'العملاء والموردون', items: 'الأصناف',
  payments: 'السندات', payment_allocations: 'توزيع السندات', expenses: 'المصروفات', stock_docs: 'مستندات المخزون', stock_doc_lines: 'أسطر المخزون', stock_moves: 'حركات المخزون', warehouses: 'المستودعات',
  branches: 'الفروع', cost_centers: 'المشاريع ومراكز التكلفة', employees: 'الموظفون', payroll_runs: 'مسيرات الرواتب', payslips: 'قسائم الرواتب', tasks: 'المهام', timesheets: 'ساعات العمل',
  project_materials: 'مواد المشاريع', mfg_orders: 'أوامر التصنيع', mfg_order_lines: 'أسطر التصنيع', mfg_order_costs: 'تكاليف التصنيع', boms: 'قوائم المواد', bom_lines: 'أسطر قوائم المواد',
  fixed_assets: 'الأصول الثابتة', asset_depreciation: 'الإهلاك', roles: 'الأدوار', counters: 'الترقيم', feasibility_studies: 'دراسات الجدوى', saved_reports: 'التقارير المحفوظة', leaves: 'الإجازات',
  attendance: 'الحضور', evaluations: 'التقييمات', commitments: 'الالتزامات', leads: 'العملاء المحتملون', price_lists: 'قوائم الأسعار', price_list_items: 'أسعار القوائم', budgets: 'الموازنات',
  audit_log: 'سجل التدقيق', calendar_notes: 'ملاحظات التقويم', reminders: 'التذكيرات', landed_costs: 'تكاليف الاستيراد', pos_registers: 'نقاط البيع', pos_shifts: 'ورديات نقاط البيع',
  van_trips: 'رحلات المندوب', zatca_devices: 'أجهزة الفوترة' };
const backupName = () => `craftland-${riyadhToday()}_${new Date().toTimeString().slice(0, 5).replace(':', '')}`;
const dlBlob = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 3000); };
const gz = async text => { if (!window.CompressionStream) return null; return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob(); };
const readBackupFile = async file => {
  let text;
  if (/\.gz$/i.test(file.name)) { if (!window.DecompressionStream) throw new AppError('المتصفح لا يدعم فك الضغط — استخدم Chrome أو Edge حديث'); text = await new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).text(); }
  else text = await file.text();
  let b; try { b = JSON.parse(text); } catch { throw new AppError('الملف ليس نسخة احتياطية (JSON غير صالح)'); }
  if (b?.format !== 'craftland-backup' || b.version !== 1 || !b.org || !b.tables) throw new AppError('الملف ليس نسخة احتياطية من كرافت لاند');
  return b;
};
// give every row (and the company) a new id; all references follow because ids are unique strings
const remapBackup = b => {
  const ids = new Set([b.org.id]); for (const rows of Object.values(b.tables)) for (const r of rows) if (typeof r.id === 'string') ids.add(r.id);
  const map = new Map([...ids].map(x => [x, crypto.randomUUID()]));
  return JSON.parse(JSON.stringify(b).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, m => map.get(m) || m));
};

// ---------- minimal .xlsx writer (stored zip, inline strings, right-to-left sheets) ----------
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zipStore(files) {
  const enc = new TextEncoder(), parts = [], cen = []; let off = 0;
  for (const [name, content] of files) {
    const nb = enc.encode(name), data = typeof content === 'string' ? enc.encode(content) : content, crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30)); h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nb.length, true);
    parts.push(new Uint8Array(h.buffer), nb, data);
    const c = new DataView(new ArrayBuffer(46)); c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nb.length, true); c.setUint32(42, off, true);
    cen.push(new Uint8Array(c.buffer), nb); off += 30 + nb.length + data.length;
  }
  const size = cen.reduce((s, x) => s + x.length, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, size, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...cen, new Uint8Array(e.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
const xesc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const colName = i => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
// sheets: [{ name, rows: [[cell,…],…] }] — first row is the header; numbers stay numbers
function xlsxBlob(sheets) {
  const used = new Set(), names = sheets.map(s => { let n = String(s.name).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet'; let k = n, i = 2; while (used.has(k)) k = n.slice(0, 28) + ' ' + i++; used.add(k); return k; });
  const sheetXml = rows => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0" rightToLeft="1"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${
    rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => { const ref = colName(ci) + (ri + 1);
      if (v == null || v === '') return '';
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${ri === 0 ? ' s="1"' : ''}><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${ri === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${xesc(typeof v === 'object' ? JSON.stringify(v) : v).slice(0, 32000)}</t></is></c>`; }).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${names.map((n, i) => `<sheet name="${xesc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows)]),
  ];
  return zipStore(files);
}

// ---------- page ----------
async function backupView() {
  shell('backup', loading());
  const [log, roles] = await Promise.all([api.backupLog().catch(() => []), can('users', 'create') ? api.listRoles().catch(() => []) : []]);
  const owner = !!ORG?.perms?._owner || api.mode !== 'supabase', canNew = owner;
  const ago = at => { const m = Math.round((Date.now() - new Date(at)) / 60000); return m < 1 ? 'الآن' : m < 60 ? `قبل ${m} دقيقة` : m < 1440 ? `قبل ${Math.round(m / 60)} ساعة` : `قبل ${Math.round(m / 1440)} يوم`; };
  const lastScript = log.find(l => l.source === 'script'), lastApp = log.find(l => l.source === 'app');
  const stale = !lastScript || Date.now() - new Date(lastScript.at) > 36 * 3600e3;
  const SRC = { app: 'من التطبيق', script: 'كمبيوتر النسخ', restore: 'استرجاع' };
  const bkRole = roles.find(r => r.permissions?.backup?.length && Object.keys(r.permissions).length === 1);
  $('#main').innerHTML = `<a class="crumb" href="#/settings">${icon('chev')} الإعدادات</a><div class="page-head"><h1>النسخ الاحتياطي والاسترجاع</h1></div>
    <div class="grid g3" style="margin-bottom:20px">
      <div class="card stat"><div class="label">آخر نسخة من كمبيوتر النسخ</div><div class="val ${stale ? 'down' : ''}" style="font-size:20px">${lastScript ? ago(lastScript.at) : 'لم يُعدّ بعد'}</div><div class="xs muted">${lastScript ? `${Number(lastScript.rows).toLocaleString('en-US')} سجل` : 'اتبع الخطوات بالأسفل'}${lastScript && stale ? ' — تأخرت، تأكد أن الجهاز يعمل' : ''}</div></div>
      <div class="card stat"><div class="label">آخر نسخة يدوية</div><div class="val" style="font-size:20px">${lastApp ? ago(lastApp.at) : '—'}</div><div class="xs muted">${lastApp ? `${Number(lastApp.rows).toLocaleString('en-US')} سجل` : ''}</div></div>
      <div class="card stat"><div class="label">ما تشمله النسخة</div><div class="val" style="font-size:20px">كل البيانات</div><div class="xs muted">الحسابات والقيود والمستندات والمخزون والموظفين والمشاريع والإعدادات والتصميم</div></div></div>

    <section class="card grid" style="gap:12px;margin-bottom:16px"><h3 style="margin:0">نسخة الآن</h3>
      <p class="muted" style="margin:0">ملف واحد فيه كل بيانات «${esc(ORG.name_ar)}»، يمكن استرجاعه لاحقاً هنا. احفظه في مكان آمن — فيه كل بيانات الشركة.</p>
      <div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn primary" id="bknow">${icon('down')}تنزيل نسخة احتياطية كاملة</button><button class="btn secondary" id="bkxl">${icon('down')}تصدير كل الجداول إلى Excel</button></div>
      <p class="help" id="bkmsg" role="status"></p></section>

    <section class="card grid" style="gap:12px;margin-bottom:16px"><h3 style="margin:0">استرجاع نسخة</h3>
      <div class="field"><label for="rsf">ملف النسخة (.json.gz أو .json)</label><input type="file" id="rsf" accept=".gz,.json,application/json,application/gzip"></div>
      <div id="rsprev"></div></section>

    <section class="card grid" style="gap:12px;margin-bottom:16px"><h3 style="margin:0">كمبيوتر النسخ الاحتياطي (لينكس)</h3>
      <p class="muted" style="margin:0">برنامج صغير يشتغل كل ليلة على الكمبيوتر المخصص: يسحب نسخة كاملة، يتحقق منها، ويحتفظ بآخر 30 نسخة يومية + نسخة لكل شهر لسنة. ما يحتاج ذكاء اصطناعي ولا اشتراك.</p>
      <ol class="bk-steps">
        <li><b>حساب خاص للنسخ:</b> ${bkRole ? `الدور «${esc(bkRole.name)}» موجود ✓` : can('users', 'create') ? '<button class="btn secondary sm" id="bkrole">إنشاء دور «النسخ الاحتياطي»</button>' : 'اطلب من المالك إنشاء دور للنسخ'} ثم من <a href="#/users">المستخدمون</a> ادعُ بريداً مخصصاً (مثل backup@…) بهذا الدور، وسجّل به وضع له كلمة مرور قوية. هذا الحساب يقدر ينسخ فقط — ما يقدر يعدّل أو يشوف شاشات النظام.</li>
        <li><b>حمّل البرنامج</b> على الكمبيوتر المخصص: <button class="btn secondary sm" id="bkpy">${icon('down')}craftland-backup.py</button></li>
        <li><b>في الطرفية (Terminal)</b> على ذلك الكمبيوتر، من المجلد اللي حمّلت فيه البرنامج:
          <table class="bk-cmds">${[['setup', 'أول مرة: البريد وكلمة المرور ومجلد الحفظ، ثم نسخة أولى'], ['install', 'تشغيل تلقائي كل ليلة الساعة 2:30'], ['status', 'آخر النسخ وموعد القادمة'], ['verify', 'التحقق من سلامة آخر نسخة'], ['run', 'نسخة الآن يدوياً']]
            .map(([c, t]) => `<tr><td><code dir="ltr">python3 craftland-backup.py ${c}</code></td><td>${t}</td></tr>`).join('')}</table></li>
        <li>كل نسخة ناجحة تظهر هنا في «آخر نسخة من كمبيوتر النسخ». لو تأخرت أكثر من يوم ونصف يظهر تنبيه.</li></ol>
      <p class="help">ننصح بتشفير قرص ذلك الكمبيوتر، وتحديد قرص خارجي كنسخة ثانية أثناء الإعداد.</p></section>

    <section class="card"><h3 style="margin:0 0 8px">السجل</h3>${log.length ? `<div class="tbl-wrap"><table class="list-tbl"><thead><tr><th>الوقت</th><th>المصدر</th><th class="amt">السجلات</th><th>ملاحظة</th></tr></thead><tbody>
      ${log.slice(0, 30).map(l => `<tr><td class="num">${esc(new Date(l.at).toLocaleString('en-GB', { timeZone: 'Asia/Riyadh' }).slice(0, 17))}</td><td>${badge([SRC[l.source] || l.source, l.source === 'script' ? 'b-ok' : l.source === 'restore' ? 'b-warn' : 'b-info'])}</td><td class="amt num">${Number(l.rows).toLocaleString('en-US')}</td><td class="xs">${esc(l.note || '')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">لا توجد نسخ بعد.</p>'}</section>`;

  const msg = t => { $('#bkmsg').textContent = t; };
  $('#bknow').onclick = async e => { e.target.disabled = true; msg('جارٍ تجهيز النسخة…');
    try { const b = await api.exportOrg('app'), text = JSON.stringify(b), z = await gz(text); dlBlob(z || new Blob([text], { type: 'application/json' }), backupName() + (z ? '.json.gz' : '.json'));
      const rows = Object.values(b.counts || {}).reduce((s, n) => s + n, 0); msg(`تم ✓ — ${rows.toLocaleString('en-US')} سجل في ${Object.keys(b.tables).length} جدول.`); }
    catch (x) { msg(''); fail(x); } finally { e.target.disabled = false; } };
  $('#bkxl').onclick = async e => { e.target.disabled = true; msg('جارٍ تجهيز ملف Excel…');
    try { const b = await api.exportOrg('app');
      const sheets = [{ name: 'اقرأني', rows: [['البيان', 'القيمة'], ['الشركة', ORG.name_ar], ['تاريخ التصدير', String(b.exported_at).slice(0, 16)], ['المبالغ', 'بالهللة — اقسم على 100 للريال'], ['ملاحظة', 'للاسترجاع استخدم ملف النسخة الاحتياطية (.json.gz) وليس هذا الملف']] }];
      for (const [t, rows] of Object.entries(b.tables).sort((a, c) => (TBL_AR[a[0]] || a[0]).localeCompare(TBL_AR[c[0]] || c[0], 'ar'))) { if (!rows.length) continue;
        const cols = Object.keys(rows[0]); sheets.push({ name: TBL_AR[t] || t, rows: [cols, ...rows.map(r => cols.map(c => r[c]))] }); }
      dlBlob(xlsxBlob(sheets), backupName() + '.xlsx'); msg(`تم ✓ — ${sheets.length - 1} جدول في ملف Excel.`); }
    catch (x) { msg(''); fail(x); } finally { e.target.disabled = false; } };
  $('#bkpy').onclick = () => { if (!BACKUP_PY) return toast('البرنامج غير مضمّن في هذه النسخة', 'bad');
    const py = BACKUP_PY.replace("URL = '__URL__'", `URL = ${JSON.stringify(cfg.url || '')}`).replace("KEY = '__KEY__'", `KEY = ${JSON.stringify(cfg.key || '')}`)
      .replace("ORG = '__ORG__'", `ORG = ${JSON.stringify(ORG.id)}`).replace("COMPANY = '__NAME__'", `COMPANY = ${JSON.stringify(ORG.name_ar)}`);
    dlBlob(new Blob([py], { type: 'text/x-python;charset=utf-8' }), 'craftland-backup.py'); };
  if ($('#bkrole')) $('#bkrole').onclick = async () => { try { await api.saveRole(null, 'النسخ الاحتياطي', { backup: ['view'] }); toast('أُنشئ الدور'); backupView(); } catch (x) { fail(x); } };

  $('#rsf').onchange = async e => { const f = e.target.files[0]; if (!f) return; const box = $('#rsprev'); box.innerHTML = loading('جارٍ قراءة الملف…');
    let b; try { b = await readBackupFile(f); } catch (x) { box.innerHTML = `<p class="help err">${esc(x.message)}</p>`; return; }
    const counts = Object.entries(b.tables).map(([t, r]) => [t, r.length]).filter(x => x[1]).sort((a, c) => c[1] - a[1]), total = counts.reduce((s, x) => s + x[1], 0);
    box.innerHTML = `<div class="card" style="background:var(--c-surface-2)"><b>${esc(b.org.name_ar)}</b> — نسخة <span class="num">${esc(String(b.exported_at).slice(0, 16).replace('T', ' '))}</span><br><span class="muted">${total.toLocaleString('en-US')} سجل في ${counts.length} جدول: ${counts.slice(0, 8).map(([t, n]) => `${esc(TBL_AR[t] || t)} <span class="num">${n}</span>`).join('، ')}${counts.length > 8 ? '…' : ''}</span></div>
      <fieldset><legend>طريقة الاسترجاع</legend>
        <label class="row" style="gap:8px;align-items:flex-start"><input type="radio" name="rsm" value="new" ${canNew ? 'checked' : 'disabled'}><span><b>كشركة جديدة</b> — آمن: بياناتك الحالية ما تتغيّر، وتظهر النسخة كشركة منفصلة تنتقل لها من قائمة الشركات وتقارن.</span></label>
        <label class="row" style="gap:8px;align-items:flex-start;margin-top:8px"><input type="radio" name="rsm" value="replace" ${owner ? '' : 'disabled'} ${canNew ? '' : 'checked'}><span><b>بدلاً من الشركة الحالية</b> — تصير النسخة هي الشركة المستخدمة وينتقل لها كل الموظفين بنفس أدوارهم. البيانات الحالية لا تُحذف: تبقى كشركة «أرشيف» للمالك فقط.</span></label></fieldset>
      ${field('rsname', 'اسم الشركة المسترجعة', { value: b.org.name_ar, attrs: 'maxlength="200"' })}
      <div id="rsconf"></div><p class="help err" id="rserr" role="alert"></p>
      <div class="row" style="justify-content:flex-end"><button class="btn primary" id="rsgo">استرجاع</button></div>`;
    const conf = () => { const m = $('[name=rsm]:checked')?.value; $('#rsconf').innerHTML = m === 'replace' ? field('rsok', `للتأكيد اكتب اسم الشركة الحالية: ${ORG.name_ar}`, { attrs: 'autocomplete="off"' }) : ''; };
    $$('[name=rsm]').forEach(x => x.onchange = conf); conf();
    $('#rsgo').onclick = async ev => { const m = $('[name=rsm]:checked')?.value; $('#rserr').textContent = '';
      if (!m) return $('#rserr').textContent = 'اختر طريقة الاسترجاع';
      if (m === 'replace' && ($('#f-rsok')?.value || '').trim() !== ORG.name_ar.trim()) return $('#rserr').textContent = 'اكتب اسم الشركة الحالية كما هو للتأكيد';
      ev.target.disabled = true; ev.target.textContent = 'جارٍ الاسترجاع…';
      try { const nb = remapBackup(b); nb.org.name_ar = ($('#f-rsname').value || '').trim() || b.org.name_ar;
        const id = await api.importOrg(nb, m); api.switchOrg(id); ORG = null; toast(m === 'replace' ? 'تم الاسترجاع — هذه الآن الشركة المستخدمة' : 'تم الاسترجاع كشركة جديدة');
        location.hash = '#/dashboard'; route(); }
      catch (x) { $('#rserr').textContent = x.message; ev.target.disabled = false; ev.target.textContent = 'استرجاع'; } };
  };
}

const BACKUP_ROUTES = [[/^#\/backup$/, gate('backup', 'النسخ الاحتياطي', 'backup', backupView)]];
