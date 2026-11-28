// Supabase Edge Function: ZATCA e-invoicing phase 2 (Fatoora).
// The private key and the CSIDs live only here and in zatca_secrets (service role); the browser never sees them.
// Actions (POST JSON, signed-in user's JWT in Authorization):
//   selftest  {otp?}                         → full onboarding + 6 compliance checks on ZATCA's developer portal, nothing saved
//   onboard   {org_id, branch_id, environment, otp}   (owner)  → device + keys + compliance checks + production CSID
//   submit    {document_id}                  (sales:create)   → sign, clear (B2B) or report (B2C), store the result
//   devices   {org_id}                       (settings:view)  → device list without secrets
import { createClient } from 'npm:@supabase/supabase-js@2';
import { Buffer } from 'node:buffer';
import * as Z from './core.js';

const BASE: Record<string, string> = {
  sandbox: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal',
  simulation: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation',
  production: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core',
};
const SANDBOX_OTP = '123345';
const TEST_ORG = { name_ar: 'كرافت لاند (اختبار)', vat_number: '399999999900003', cr_number: '1010010000', street: 'طريق الملك فهد', building_no: '1234', district: 'العليا', city: 'الرياض', postal_code: '12345' };
const TEST_BUYER = { name: 'عميل اختبار', vat_number: '311111111111113', street: 'شارع التحلية', building_no: '5678', district: 'السليمانية', city: 'الرياض', postal_code: '12244' };
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s: string) => Buffer.from(s, 'base64').toString('utf8');
const certFromToken = (token: string) => `-----BEGIN CERTIFICATE-----\n${unb64(token)}\n-----END CERTIFICATE-----`;
const auth = (token: string, secret: string) => 'Basic ' + b64(`${token}:${secret}`);

async function zatca(env: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(BASE[env] + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Version': 'V2', 'Accept-Language': 'ar', ...headers }, body: JSON.stringify(body) });
  const text = await r.text(); let data: any; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 2000) }; }
  return { status: r.status, ok: r.status === 200 || r.status === 202, data };
}
const summary = (d: any) => ({
  status: d?.validationResults?.status ?? d?.reportingStatus ?? d?.clearanceStatus ?? null,
  errors: (d?.validationResults?.errorMessages || []).map((m: any) => `${m.code}: ${m.message}`),
  warnings: (d?.validationResults?.warningMessages || []).map((m: any) => `${m.code}: ${m.message}`),
});

// six documents ZATCA asks for when a device supports both invoice types ("1100")
function complianceDocs(org: any) {
  const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10), now = new Date(Date.now() + 3 * 3600e3).toISOString().slice(11, 19);
  const line = (d: string, q: number, p: number) => { const net = Math.round(q * p); return { description: d, qty: q, unit_price: p, discount: 0, vat_rate: 15, tax_category: 'S', line_net: net, line_vat: Math.round(net * 0.15) }; };
  const L = [line('كرفان سحب', 1, 250000), line('تركيب لوح شمسي', 2, 12505)];
  const mk = (kind: string, n: string, related: any = null) => ({ doc: { kind, number: n, zatca_uuid: crypto.randomUUID(), issue_date: today, issue_time: now, note: related ? 'إرجاع' : '' }, related });
  return [
    { name: 'فاتورة ضريبية', party: TEST_BUYER, ...mk('tax_invoice', 'SME00001') },
    { name: 'إشعار دائن ضريبي', party: TEST_BUYER, ...mk('credit_note', 'SME00002', { kind: 'tax_invoice', number: 'SME00001' }) },
    { name: 'إشعار مدين ضريبي', party: TEST_BUYER, ...mk('debit_note', 'SME00003', { kind: 'tax_invoice', number: 'SME00001' }) },
    { name: 'فاتورة مبسطة', party: null, ...mk('simplified_invoice', 'SME00004') },
    { name: 'إشعار دائن مبسط', party: null, ...mk('credit_note', 'SME00005', { kind: 'simplified_invoice', number: 'SME00004' }) },
    { name: 'إشعار مدين مبسط', party: null, ...mk('debit_note', 'SME00006', { kind: 'simplified_invoice', number: 'SME00004' }) },
  ].map(d => ({ ...d, lines: L, org }));
}

/** CSR → compliance CSID → 6 compliance checks → production CSID. Returns everything; the caller decides what to keep. */
async function onboard(env: string, otp: string, org: any, branchName: string, egsUuid: string) {
  const key = Z.newKeyPair();
  const csr = Z.buildCSR(key, { environment: env, commonName: `CraftLand-${egsUuid.slice(0, 8)}`, orgName: org.name_ar, branchName: branchName || 'الفرع الرئيسي',
    vatNumber: org.vat_number, egsSerial: `1-CraftLand|2-Accounting|3-${egsUuid}`, invoiceTypes: '1100',
    address: [org.building_no, org.street, org.city].filter(Boolean).join(' '), industry: org.sector || 'Manufacturing' });
  const c = await zatca(env, '/compliance', { csr: b64(csr) }, { OTP: otp });
  if (!c.ok || !c.data?.binarySecurityToken) return { ok: false, step: 'compliance_csid', http: c.status, response: c.data };
  const cert = certFromToken(c.data.binarySecurityToken), cauth = auth(c.data.binarySecurityToken, c.data.secret);
  const checks = []; let icv = 0, pih = Z.INITIAL_PIH;
  for (const d of complianceDocs(org)) {
    icv++; const u = Z.buildInvoiceXML({ doc: d.doc, lines: d.lines, org: d.org, party: d.party, related: d.related, device: { icv, pih }, opts: { payment: d.party ? 'bank' : 'cash', reason: 'إرجاع' } });
    const s = Z.signInvoice(u, { certPem: cert, privateKeyPem: key, sellerName: org.name_ar, vatNumber: org.vat_number, issueDate: d.doc.issue_date, issueTime: d.doc.issue_time });
    const r = await zatca(env, '/compliance/invoices', { invoiceHash: s.hash, uuid: d.doc.zatca_uuid, invoice: b64(s.xml) }, { Authorization: cauth });
    checks.push({ name: d.name, http: r.status, ...summary(r.data) }); pih = s.hash;
  }
  const passed = checks.every(x => x.http === 200 || x.http === 202);
  if (!passed) return { ok: false, step: 'compliance_checks', checks, key, csr, compliance: { cert, token: c.data.binarySecurityToken, secret: c.data.secret, requestId: c.data.requestID } };
  const p = await zatca(env, '/production/csids', { compliance_request_id: String(c.data.requestID) }, { Authorization: cauth });
  if (!p.ok || !p.data?.binarySecurityToken) return { ok: false, step: 'production_csid', http: p.status, response: p.data, checks };
  return { ok: true, checks, key, csr, compliance: { token: c.data.binarySecurityToken, secret: c.data.secret, requestId: String(c.data.requestID) },
    production: { token: p.data.binarySecurityToken, secret: p.data.secret } };
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!, anon = (Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY'))!, service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const user = createClient(url, anon, { global: { headers: { Authorization: req.headers.get('Authorization') || '' } } });
    const { data: me } = await user.auth.getUser(); if (!me?.user) return json({ error: 'sign in first' }, 401);
    const db = createClient(url, service);
    const body = await req.json().catch(() => ({}));
    const perm = async (org: string, module: string, action: string) => (await user.rpc('has_perm', { o: org, module, action })).data === true;

    if (body.action === 'selftest') {
      const r = await onboard('sandbox', body.otp || SANDBOX_OTP, TEST_ORG, 'الفرع الرئيسي', crypto.randomUUID());
      return json({ ok: r.ok, step: (r as any).step, http: (r as any).http, response: (r as any).response, checks: (r as any).checks });   // keys are dropped
    }

    if (body.action === 'devices') {
      if (!(await perm(body.org_id, 'settings', 'view'))) return json({ error: 'not allowed' }, 403);
      const { data } = await db.from('zatca_devices').select('id, branch_id, environment, status, last_icv, last_error, compliance_report, created_at, expires_at').eq('org_id', body.org_id).order('created_at');
      return json({ devices: data || [] });
    }

    if (body.action === 'onboard') {
      const env = body.environment; if (!BASE[env]) return json({ error: 'not allowed' }, 400);
      const { data: own } = await user.rpc('is_owner', { o: body.org_id }); if (own !== true) return json({ error: 'not allowed' }, 403);
      const { data: org } = await db.from('orgs').select('*').eq('id', body.org_id).single();
      const { data: br } = await db.from('branches').select('id, name').eq('id', body.branch_id).eq('org_id', body.org_id).single();
      if (!br) return json({ error: 'branch not found' }, 400);
      const seller = env === 'sandbox' && !org.vat_number ? { ...org, ...TEST_ORG, name_ar: org.name_ar } : org;
      if (!seller.vat_number || !seller.cr_number || !seller.street || !seller.building_no || !seller.city || !seller.postal_code)
        return json({ error: 'ZATCA_ORG_INCOMPLETE' }, 400);
      const egs = crypto.randomUUID();
      const r: any = await onboard(env, env === 'sandbox' ? (body.otp || SANDBOX_OTP) : String(body.otp || ''), seller, br.name, egs);
      if (!r.ok) return json({ ok: false, step: r.step, http: r.http, response: r.response, checks: r.checks });
      const { data: dev, error } = await db.from('zatca_devices').insert({ org_id: body.org_id, branch_id: br.id, egs_serial: `1-CraftLand|2-Accounting|3-${egs}`, egs_uuid: egs,
        environment: env, status: 'production', csr_pem: r.csr, compliance_csid: r.compliance.token, production_csid: r.production.token, compliance_report: { checks: r.checks, vat: seller.vat_number } }).select('id').single();
      if (error) throw error;
      const s = await db.from('zatca_secrets').insert({ device_id: dev.id, private_key_pem: r.key, compliance_cert: r.compliance.token, compliance_secret: r.compliance.secret,
        compliance_request_id: r.compliance.requestId, production_cert: r.production.token, production_secret: r.production.secret });
      if (s.error) { await db.from('zatca_devices').delete().eq('id', dev.id); throw s.error; }
      return json({ ok: true, device_id: dev.id, checks: r.checks });
    }

    if (body.action === 'submit') {
      const { data: doc } = await db.from('documents').select('*').eq('id', body.document_id).single();
      if (!doc) return json({ error: 'document not found' }, 404);
      if (!(await perm(doc.org_id, 'sales', 'create'))) return json({ error: 'not allowed' }, 403);
      if (doc.status !== 'posted' || !Z.TYPE[doc.kind]) return json({ error: 'ZATCA_NOT_SENDABLE' }, 400);
      if (['cleared', 'reported', 'warning'].includes(doc.zatca_status)) return json({ ok: true, status: doc.zatca_status, already: true });
      const [{ data: lines }, { data: org }, { data: devs }] = await Promise.all([
        db.from('document_lines').select('*').eq('document_id', doc.id).order('line_no'),
        db.from('orgs').select('*').eq('id', doc.org_id).single(),
        db.from('zatca_devices').select('*').eq('org_id', doc.org_id).eq('status', 'production').order('created_at', { ascending: false })]);
      const dev = (devs || []).find((d: any) => d.branch_id === doc.branch_id) || (devs || [])[0];
      if (!dev) return json({ error: 'ZATCA_NO_DEVICE' }, 400);
      const party = doc.party_id ? (await db.from('parties').select('*').eq('id', doc.party_id).single()).data : null;
      const related = doc.related_document_id ? (await db.from('documents').select('kind, number').eq('id', doc.related_document_id).single()).data : null;
      const { data: sec } = await db.from('zatca_secrets').select('*').eq('device_id', dev.id).single();
      const seller = dev.environment === 'sandbox' ? { ...org, ...TEST_ORG, name_ar: org.name_ar, vat_number: dev.compliance_report?.vat || TEST_ORG.vat_number } : org;
      const { data: rsv, error: re } = await db.rpc('zatca_reserve', { p_device: dev.id }); if (re) return json({ error: re.message }, 409);
      try {
        const u = Z.buildInvoiceXML({ doc, lines, org: seller, party, related, device: { icv: rsv.icv, pih: rsv.pih }, opts: { reason: doc.note } });
        const s = Z.signInvoice(u, { certPem: certFromToken(sec.production_cert), privateKeyPem: sec.private_key_pem, sellerName: seller.name_ar, vatNumber: seller.vat_number, issueDate: doc.issue_date, issueTime: doc.issue_time });
        const clearance = !u.simplified;
        const r = await zatca(dev.environment, clearance ? '/invoices/clearance/single' : '/invoices/reporting/single', { invoiceHash: s.hash, uuid: doc.zatca_uuid, invoice: b64(s.xml) },
          { Authorization: auth(sec.production_cert, sec.production_secret), 'Clearance-Status': clearance ? '1' : '0' });
        if (r.status >= 500 || r.status === 0) { await db.rpc('zatca_release', { p_device: dev.id }); return json({ ok: false, retry: true, http: r.status, response: r.data }, 502); }
        const sm = summary(r.data), warn = sm.warnings.length > 0;
        const status = !r.ok ? 'rejected' : (clearance ? (warn ? 'warning' : 'cleared') : (warn ? 'warning' : 'reported'));
        const xml = clearance && r.data?.clearedInvoice ? unb64(r.data.clearedInvoice) : s.xml;
        const qr = (xml.match(/<cbc:ID>QR<\/cbc:ID>[\s\S]*?<cbc:EmbeddedDocumentBinaryObject[^>]*>([^<]+)</) || [])[1] || s.qr;
        const { error: ce } = await db.rpc('zatca_commit', { p_device: dev.id, p_doc: doc.id, p_icv: rsv.icv, p_pih: rsv.pih, p_hash: s.hash, p_status: status, p_xml: xml, p_qr: qr, p_response: { http: r.status, ...sm } });
        if (ce) throw ce;
        return json({ ok: r.ok, status, http: r.status, ...sm });
      } catch (e) { await db.rpc('zatca_release', { p_device: dev.id }); throw e; }
    }
    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: String((e as any)?.message || e) }, 500);
  }
});
