// ZATCA phase-2 core: builds and signs sample documents, writes them for the independent checker (tests/zatca_check.py).
// Run: node tests/zatca_core_test.mjs <out-dir> <cert.pem> <key.pem>
import { writeFileSync, readFileSync } from 'node:fs';
import * as Z from '../supabase/functions/zatca/core.js';

const [out, certFile, keyFile] = process.argv.slice(2);
const certPem = readFileSync(certFile, 'utf8'), privateKeyPem = readFileSync(keyFile, 'utf8');
const results = []; const check = (name, ok, info = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  [' + info + ']')); };

const org = { name_ar: 'كرافت لاند للصناعة', vat_number: '399999999900003', cr_number: '1010010000', street: 'طريق الملك فهد', building_no: '1234', district: 'العليا', city: 'الرياض', postal_code: '12345' };
const buyer = { name: 'شركة الاختبار & أولاده <ذ.م.م>', vat_number: '311111111111113', street: 'شارع التحلية', building_no: '5678', district: 'السليمانية', city: 'الرياض', postal_code: '12244' };
const L = (description, qty, unit_price, discount = 0, vat_rate = 15, tax_category = 'S', extra = {}) => {
  const line_net = Math.round(qty * unit_price) - discount; return { description, qty, unit_price, discount, vat_rate, tax_category, line_net, line_vat: Math.round(line_net * vat_rate / 100), ...extra };
};
let device = { icv: 0, pih: Z.INITIAL_PIH };
const docs = [
  { name: 'standard', doc: { kind: 'tax_invoice', number: 'INV-00001', zatca_uuid: '3cf5ee18-ee25-44ea-a444-2c37ba7f28be', issue_date: '2026-11-28', issue_time: '12:30:05' }, party: buyer,
    lines: [L('كرفان سحب 2.4 × 5.7 متر', 1, 2500000), L('تركيب لوح شمسي', 2, 125050, 5000), L('توصيل', 1, 33333)], opts: { payment: 'bank' } },
  { name: 'simplified', doc: { kind: 'simplified_invoice', number: 'INV-00002', zatca_uuid: '8e6000cf-1a98-4174-b3e7-b5d5954bc10d', issue_date: '2026-11-28', issue_time: '12:31:00' }, party: null,
    lines: [L('درج مطبخ خارجي', 3, 83333), L('مياه معدنية', 1.5, 199)], opts: { payment: 'cash' } },
  { name: 'credit', doc: { kind: 'credit_note', number: 'CN-00001', zatca_uuid: '9b7c1a7e-2f7c-4e79-9a5b-6a1c58e1d0aa', issue_date: '2026-11-28', issue_time: '12:40:00', note: 'إرجاع لوح شمسي معيب' }, party: buyer,
    related: { kind: 'tax_invoice', number: 'INV-00001' }, lines: [L('تركيب لوح شمسي', 1, 125050)], opts: { payment: 'bank' } },
];
for (const t of docs) {
  device = { icv: device.icv + 1, pih: device.pih };
  const unsigned = Z.buildInvoiceXML({ doc: t.doc, lines: t.lines, org, party: t.party, related: t.related, device, opts: t.opts });
  const s = Z.signInvoice(unsigned, { certPem, privateKeyPem, sellerName: org.name_ar, vatNumber: org.vat_number, issueDate: t.doc.issue_date, issueTime: t.doc.issue_time, signingTime: '2026-11-28T09:30:05Z' });
  writeFileSync(`${out}/${t.name}.xml`, s.xml);
  writeFileSync(`${out}/${t.name}.json`, JSON.stringify({ hash: s.hash, sph: s.signedPropertiesHash, signingTime: s.signingTime, pih: device.pih, icv: device.icv, simplified: unsigned.simplified, totals: unsigned.totals }));
  const v = Z.verifySignature(s.xml, certPem);
  check(`${t.name}: hash in the signature equals the recomputed hash`, v.hashOk);
  check(`${t.name}: ECDSA signature verifies with the certificate key`, v.signatureOk);
  const q = Z.decodeTlv(s.qr);
  check(`${t.name}: QR tags 1–${unsigned.simplified ? 9 : 8}`, Object.keys(q).length === (unsigned.simplified ? 9 : 8) && q[1].toString() === org.name_ar && q[2].toString() === org.vat_number
    && q[6].toString() === s.hash && q[4].toString() === (unsigned.totals.total / 100).toFixed(2), JSON.stringify(Object.keys(q)));
  check(`${t.name}: no placeholders left`, !s.xml.includes('@@'));
  device.pih = s.hash;                         // chain
}
// totals: category rounding vs per-line rounding is reported, never silently different
const vb = Z.vatBreakdown(docs[0].lines);
check('VAT is rounded once per category', vb.length === 1 && vb[0].tax === Math.round(vb[0].taxable * 0.15));
// tampering breaks the hash
const xml = readFileSync(`${out}/standard.xml`, 'utf8');
check('changing an amount breaks the hash', !Z.verifySignature(xml.replace('<cbc:PayableAmount currencyID="SAR">', '<cbc:PayableAmount currencyID="SAR">1'), certPem).hashOk);
// regression against ZATCA's own SDK sample invoice (fixture): same invoice hash and signed-properties hash
const smp = readFileSync(new URL('./fixtures/zatca_sdk_sample_simplified.xml', import.meta.url), 'utf8');
const sv = r => smp.match(r)[1], dvs = [...smp.matchAll(/<ds:DigestValue>([^<]+)</g)].map(m => m[1]);
check('SDK sample: invoice hash reproduced', Z.invoiceHash(smp) === dvs[0], Z.invoiceHash(smp));
const sc = { hash: dvs[2], issuer: sv(/<ds:X509IssuerName>([^<]*)/), serial: sv(/<ds:X509SerialNumber>([^<]*)/) };
const { createHash } = await import('node:crypto');
check('SDK sample: signed-properties hash reproduced', Buffer.from(createHash('sha256').update(Z.signedPropsForHash(sv(/<xades:SigningTime>([^<]*)/), sc)).digest('hex')).toString('base64') === dvs[1]);
const sci = Z.certInfo(sv(/<ds:X509Certificate>([^<]*)/));
check('SDK sample: issuer and serial read from its certificate as ZATCA writes them', sci.issuer === sc.issuer && sci.serial === sc.serial, sci.issuer + ' / ' + sci.serial);
const { X509Certificate, createVerify, createPublicKey } = await import('node:crypto');
const nx = new X509Certificate(readFileSync(certFile));
check('our certificate parser agrees with node:crypto', Z.certInfo(certPem).serial === BigInt('0x' + nx.serialNumber).toString() && Z.certInfo(certPem).issuer === nx.issuer.split('\n').reverse().join(', '));
const sx = readFileSync(`${out}/simplified.xml`, 'utf8'), nv = createVerify('sha256'); nv.update(Buffer.from(sx.match(/<ds:DigestValue>([^<]+)/)[1], 'base64'));
check('node:crypto verifies our ECDSA signature', nv.verify(nx.publicKey, Buffer.from(sx.match(/<ds:SignatureValue>([^<]+)/)[1], 'base64')));
check('SDK sample: certificate digest reproduced', Z.certInfo(sv(/<ds:X509Certificate>([^<]*)/)).hash === dvs[2]);
// CSR
const k = Z.newKeyPair();
const csr = Z.buildCSR(k, { environment: 'sandbox', commonName: 'CraftLand-EGS-1', orgName: org.name_ar, branchName: 'الفرع الرئيسي', vatNumber: org.vat_number,
  egsSerial: '1-CraftLand|2-Accounting|3-ed22f1d8-e6a2-1118-9b58-d9a8f11e445f', invoiceTypes: '1100', address: '1234 طريق الملك فهد، الرياض', industry: 'Manufacturing' });
writeFileSync(`${out}/egs.csr`, csr); writeFileSync(`${out}/egs.key`, k);
check('CSR is PEM', csr.startsWith('-----BEGIN CERTIFICATE REQUEST-----'));
console.log(`${results.filter(Boolean).length} / ${results.length} passed (zatca core)`);
process.exit(results.every(Boolean) ? 0 : 1);
