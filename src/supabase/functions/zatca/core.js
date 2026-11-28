// ZATCA e-invoicing phase 2 (integration) core: UBL 2.1 XML, invoice hash, XAdES signature, phase-2 QR, CSR.
// Pure module: runs in the Supabase Edge Function (Deno) and in Node for tests. No DOM, no third-party packages.
//
// Hashing follows the ZATCA SDK exactly: the invoice hash is SHA-256 over the C14N 1.1 form of the invoice with
// ext:UBLExtensions, cac:Signature and the QR AdditionalDocumentReference removed (whitespace around them kept).
// We write the XML already in canonical form (no XML declaration inside the hashed part, no self-closing tags,
// attributes in canonical order), so removing those three elements as text gives the canonical string directly.
// tests/zatca_check.py re-derives every hash independently with lxml.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
// Elliptic-curve maths (secp256k1 ECDSA) and certificate parsing are done here in plain JavaScript (BigInt), so the module
// does not depend on which curves a runtime's crypto library supports. Only SHA-256 / HMAC come from node:crypto.

export const INITIAL_PIH = 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==';
const NS = 'xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"';

// ---------- small helpers ----------
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
const escA = s => esc(s).replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;');
const sar = h => (Number(h) / 100).toFixed(2);              // halalas -> "123.45"
const amt = (tag, h) => `<cbc:${tag} currencyID="SAR">${sar(h)}</cbc:${tag}>`;
const qtyS = q => { const n = Number(q); return Number.isInteger(n) ? n.toFixed(1) : String(+n.toFixed(6)); };
const pct = r => Number(r).toFixed(2);
const b64 = buf => Buffer.from(buf).toString('base64');
const sha256 = data => createHash('sha256').update(data).digest();

export const TYPE = { tax_invoice: '388', simplified_invoice: '388', credit_note: '381', debit_note: '383' };

/** Is the document a simplified (B2C) one? Credit/debit notes follow the invoice they correct. */
export const isSimplified = (doc, related) =>
  doc.kind === 'simplified_invoice' || ((doc.kind === 'credit_note' || doc.kind === 'debit_note') && related?.kind === 'simplified_invoice');

/** VAT by category, rounded once per category (BR-S-09, BR-CO-14). Lines keep their own rounded VAT (BR-KSA-50). */
export function vatBreakdown(lines) {
  const g = new Map();
  for (const l of lines) {
    const cat = l.tax_category || 'S', rate = Number(l.vat_rate ?? 15), k = cat + '|' + rate;
    const e = g.get(k) || { cat, rate, taxable: 0, reason: l.exemption_reason || '', reason_code: l.exemption_code || '' };
    e.taxable += Number(l.line_net); g.set(k, e);
  }
  return [...g.values()].map(e => ({ ...e, tax: Math.round(e.taxable * e.rate / 100) }));
}

// ---------- XML ----------
function address(p, tag = 'cac:PostalAddress') {
  return `<${tag}>
        <cbc:StreetName>${esc(p.street)}</cbc:StreetName>
        <cbc:BuildingNumber>${esc(p.building_no)}</cbc:BuildingNumber>
        <cbc:CitySubdivisionName>${esc(p.district || p.city)}</cbc:CitySubdivisionName>
        <cbc:CityName>${esc(p.city)}</cbc:CityName>
        <cbc:PostalZone>${esc(p.postal_code)}</cbc:PostalZone>
        <cac:Country>
          <cbc:IdentificationCode>${esc(p.country || 'SA')}</cbc:IdentificationCode>
        </cac:Country>
      </${tag}>`;
}

/**
 * Unsigned invoice XML (placeholders for the signature block and QR).
 * doc: documents row (kind, number, zatca_uuid, issue_date, issue_time, note), lines: document_lines rows with line_net/line_vat
 * org: orgs row, party: parties row or null, related: the corrected invoice for credit/debit notes,
 * device: { icv, pih }, opts: { payment: 'cash'|'card'|'credit'|'bank', reason, delivery_date }
 */
export function buildInvoiceXML({ doc, lines, org, party, related, device, opts = {} }) {
  const simplified = isSimplified(doc, related);
  const code = TYPE[doc.kind]; if (!code) throw new Error('ZATCA_KIND: ' + doc.kind);
  const subtype = simplified ? '0200000' : '0100000';
  const time = String(doc.issue_time || '00:00:00').slice(0, 8);
  const vb = vatBreakdown(lines);
  const net = lines.reduce((s, l) => s + Number(l.line_net), 0), vat = vb.reduce((s, e) => s + e.tax, 0);
  const pay = { cash: '10', credit: '30', bank: '42', card: '48' }[opts.payment] || (simplified ? '10' : '30');
  const correcting = doc.kind === 'credit_note' || doc.kind === 'debit_note';
  if (correcting && !related) throw new Error('ZATCA_NOTE_NEEDS_INVOICE');
  const buyer = party && (party.vat_number || party.name);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice ${NS}><ext:UBLExtensions>@@UBL_EXTENSIONS@@</ext:UBLExtensions>
    <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
    <cbc:ID>${esc(doc.number)}</cbc:ID>
    <cbc:UUID>${esc(doc.zatca_uuid)}</cbc:UUID>
    <cbc:IssueDate>${esc(doc.issue_date)}</cbc:IssueDate>
    <cbc:IssueTime>${esc(time)}</cbc:IssueTime>
    <cbc:InvoiceTypeCode name="${subtype}">${code}</cbc:InvoiceTypeCode>
    <cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>
    <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>${correcting ? `
    <cac:BillingReference>
      <cac:InvoiceDocumentReference>
        <cbc:ID>${esc(related.number)}</cbc:ID>
      </cac:InvoiceDocumentReference>
    </cac:BillingReference>` : ''}
    <cac:AdditionalDocumentReference>
      <cbc:ID>ICV</cbc:ID>
      <cbc:UUID>${Number(device.icv)}</cbc:UUID>
    </cac:AdditionalDocumentReference>
    <cac:AdditionalDocumentReference>
      <cbc:ID>PIH</cbc:ID>
      <cac:Attachment>
        <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${esc(device.pih || INITIAL_PIH)}</cbc:EmbeddedDocumentBinaryObject>
      </cac:Attachment>
    </cac:AdditionalDocumentReference>
    <cac:AdditionalDocumentReference>
      <cbc:ID>QR</cbc:ID>
      <cac:Attachment>
        <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">@@QR@@</cbc:EmbeddedDocumentBinaryObject>
      </cac:Attachment>
    </cac:AdditionalDocumentReference>
    <cac:Signature>
      <cbc:ID>urn:oasis:names:specification:ubl:signature:Invoice</cbc:ID>
      <cbc:SignatureMethod>urn:oasis:names:specification:ubl:dsig:enveloped:xades</cbc:SignatureMethod>
    </cac:Signature>
    <cac:AccountingSupplierParty>
      <cac:Party>
        <cac:PartyIdentification>
          <cbc:ID schemeID="CRN">${esc(org.cr_number)}</cbc:ID>
        </cac:PartyIdentification>
        ${address(org)}
        <cac:PartyTaxScheme>
          <cbc:CompanyID>${esc(org.vat_number)}</cbc:CompanyID>
          <cac:TaxScheme>
            <cbc:ID>VAT</cbc:ID>
          </cac:TaxScheme>
        </cac:PartyTaxScheme>
        <cac:PartyLegalEntity>
          <cbc:RegistrationName>${esc(org.name_ar)}</cbc:RegistrationName>
        </cac:PartyLegalEntity>
      </cac:Party>
    </cac:AccountingSupplierParty>
    <cac:AccountingCustomerParty>${buyer ? `
      <cac:Party>${!party.vat_number && party.cr_number ? `
        <cac:PartyIdentification>
          <cbc:ID schemeID="CRN">${esc(party.cr_number)}</cbc:ID>
        </cac:PartyIdentification>` : ''}${party.street || party.city ? `
        ${address(party)}` : ''}${party.vat_number ? `
        <cac:PartyTaxScheme>
          <cbc:CompanyID>${esc(party.vat_number)}</cbc:CompanyID>
          <cac:TaxScheme>
            <cbc:ID>VAT</cbc:ID>
          </cac:TaxScheme>
        </cac:PartyTaxScheme>` : ''}
        <cac:PartyLegalEntity>
          <cbc:RegistrationName>${esc(party.name)}</cbc:RegistrationName>
        </cac:PartyLegalEntity>
      </cac:Party>
    ` : ''}</cac:AccountingCustomerParty>${!simplified ? `
    <cac:Delivery>
      <cbc:ActualDeliveryDate>${esc(opts.delivery_date || doc.issue_date)}</cbc:ActualDeliveryDate>
    </cac:Delivery>` : ''}
    <cac:PaymentMeans>
      <cbc:PaymentMeansCode>${pay}</cbc:PaymentMeansCode>${correcting ? `
      <cbc:InstructionNote>${esc(opts.reason || doc.note || 'مرتجع')}</cbc:InstructionNote>` : ''}
    </cac:PaymentMeans>
    <cac:TaxTotal>
      ${amt('TaxAmount', vat)}${vb.map(e => `
      <cac:TaxSubtotal>
        ${amt('TaxableAmount', e.taxable)}
        ${amt('TaxAmount', e.tax)}
        <cac:TaxCategory>
          <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">${esc(e.cat)}</cbc:ID>
          <cbc:Percent>${pct(e.rate)}</cbc:Percent>${e.cat !== 'S' ? `
          <cbc:TaxExemptionReasonCode>${esc(e.reason_code)}</cbc:TaxExemptionReasonCode>
          <cbc:TaxExemptionReason>${esc(e.reason)}</cbc:TaxExemptionReason>` : ''}
          <cac:TaxScheme>
            <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">VAT</cbc:ID>
          </cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>`).join('')}
    </cac:TaxTotal>
    <cac:TaxTotal>
      ${amt('TaxAmount', vat)}
    </cac:TaxTotal>
    <cac:LegalMonetaryTotal>
      ${amt('LineExtensionAmount', net)}
      ${amt('TaxExclusiveAmount', net)}
      ${amt('TaxInclusiveAmount', net + vat)}
      ${amt('AllowanceTotalAmount', 0)}
      ${amt('PrepaidAmount', 0)}
      ${amt('PayableAmount', net + vat)}
    </cac:LegalMonetaryTotal>${lines.map((l, i) => {
      const gross = Number(l.line_net) + Number(l.discount || 0), q = Number(l.qty);
      return `
    <cac:InvoiceLine>
      <cbc:ID>${i + 1}</cbc:ID>
      <cbc:InvoicedQuantity unitCode="PCE">${qtyS(q)}</cbc:InvoicedQuantity>
      ${amt('LineExtensionAmount', l.line_net)}${Number(l.discount) ? `
      <cac:AllowanceCharge>
        <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
        <cbc:AllowanceChargeReason>discount</cbc:AllowanceChargeReason>
        ${amt('Amount', l.discount)}
      </cac:AllowanceCharge>` : ''}
      <cac:TaxTotal>
        ${amt('TaxAmount', l.line_vat)}
        ${amt('RoundingAmount', Number(l.line_net) + Number(l.line_vat))}
      </cac:TaxTotal>
      <cac:Item>
        <cbc:Name>${esc(l.description || 'صنف')}</cbc:Name>
        <cac:ClassifiedTaxCategory>
          <cbc:ID>${esc(l.tax_category || 'S')}</cbc:ID>
          <cbc:Percent>${pct(l.vat_rate ?? 15)}</cbc:Percent>
          <cac:TaxScheme>
            <cbc:ID>VAT</cbc:ID>
          </cac:TaxScheme>
        </cac:ClassifiedTaxCategory>
      </cac:Item>
      <cac:Price>
        <cbc:PriceAmount currencyID="SAR">${(gross / 100 / (q || 1)).toFixed(2)}</cbc:PriceAmount>
      </cac:Price>
    </cac:InvoiceLine>`; }).join('')}
</Invoice>`;
  return { xml, totals: { net, vat, total: net + vat }, simplified };
}

// ---------- hashing ----------
const cut = (s, open, close, test = () => true) => {
  let from = 0;
  for (;;) {
    const i = s.indexOf(open, from); if (i < 0) return s;
    const j = s.indexOf(close, i) + close.length;
    if (test(s.slice(i, j))) return s.slice(0, i) + s.slice(j);
    from = j;
  }
};
/** The canonical bytes ZATCA hashes. */
export function pureInvoice(xml) {
  let s = xml.slice(xml.indexOf('<Invoice'));
  s = s.slice(0, s.lastIndexOf('</Invoice>') + '</Invoice>'.length);
  s = cut(s, '<ext:UBLExtensions>', '</ext:UBLExtensions>');
  s = cut(s, '<cac:Signature>', '</cac:Signature>');
  s = cut(s, '<cac:AdditionalDocumentReference>', '</cac:AdditionalDocumentReference>', b => b.includes('<cbc:ID>QR</cbc:ID>'));
  return s;
}
export const invoiceHash = xml => b64(sha256(pureInvoice(xml)));


// ---------- secp256k1 ----------
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn, N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n];
const mod = (a, m = P) => { const r = a % m; return r >= 0n ? r : r + m; };
const inv = (a, m = P) => { let [x, y, u, v] = [mod(a, m), m, 1n, 0n]; while (x) { const q = y / x; [x, y, u, v] = [y - q * x, x, v - q * u, u]; } return mod(v, m); };
const padd = (A, B) => { if (!A) return B; if (!B) return A;
  if (A[0] === B[0]) { if (mod(A[1] + B[1]) === 0n) return null; const l = mod(3n * A[0] * A[0] * inv(2n * A[1])); const x = mod(l * l - 2n * A[0]); return [x, mod(l * (A[0] - x) - A[1])]; }
  const l = mod((B[1] - A[1]) * inv(B[0] - A[0])); const x = mod(l * l - A[0] - B[0]); return [x, mod(l * (A[0] - x) - A[1])]; };
const pmul = (k, Q = G) => { let R = null, A = Q; while (k > 0n) { if (k & 1n) R = padd(R, A); A = padd(A, A); k >>= 1n; } return R; };
const toBig = b => BigInt('0x' + (Buffer.from(b).toString('hex') || '0'));
const to32 = n => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');
const derInt = n => { let b = Buffer.from(n.toString(16).padStart(n.toString(16).length + (n.toString(16).length % 2), '0'), 'hex'); if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return tlvd(0x02, b); };
function rfc6979(d, h) {                                     // deterministic k (RFC 6979, HMAC-SHA256)
  const x = to32(d), hm = to32(mod(toBig(h), N));
  let V = Buffer.alloc(32, 1), K = Buffer.alloc(32, 0);
  const H = (k, ...d) => createHmac('sha256', k).update(Buffer.concat(d)).digest();
  K = H(K, V, Buffer.from([0]), x, hm); V = H(K, V); K = H(K, V, Buffer.from([1]), x, hm); V = H(K, V);
  for (;;) { V = H(K, V); const k = toBig(V); if (k > 0n && k < N) return k; K = H(K, V, Buffer.from([0])); V = H(K, V); }
}
/** ECDSA-SHA256 signature (DER, low-S) of msg with private scalar d. */
function ecSign(msg, d) {
  const h = sha256(msg), e = mod(toBig(h), N);
  for (;;) { const k = rfc6979(d, h), R = pmul(k), r = mod(R[0], N); if (!r) continue;
    let s = mod(inv(k, N) * (e + r * d), N); if (!s) continue; if (s > N / 2n) s = N - s;
    return seq(derInt(r), derInt(s)); }
}
function ecVerify(msg, sigDer, Q) {
  const [ri, si] = derItems(sigDer, derItems(sigDer)[0].hstart); const r = toBig(sigDer.subarray(ri.hstart, ri.end)), s = toBig(sigDer.subarray(si.hstart, si.end));
  if (r <= 0n || r >= N || s <= 0n || s >= N) return false;
  const e = mod(toBig(sha256(msg)), N), w = inv(s, N), X = padd(pmul(mod(e * w, N)), pmul(mod(r * w, N), Q));
  return !!X && mod(X[0], N) === r;
}
const OID_EC = '1.2.840.10045.2.1', OID_K1 = '1.3.132.0.10';
const pointBytes = Q => Buffer.concat([Buffer.from([4]), to32(Q[0]), to32(Q[1])]);
const spkiOf = Q => seq(seq(oid(OID_EC), oid(OID_K1)), tlvd(0x03, Buffer.concat([Buffer.from([0]), pointBytes(Q)])));
const pem = (label, der) => `-----BEGIN ${label}-----\n${b64(der).match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
/** Private scalar from an "EC PRIVATE KEY" (SEC1) or "PRIVATE KEY" (PKCS#8) PEM. */
export function privateScalar(keyPem) {
  const der = Buffer.from(String(keyPem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  let items = derItems(der, derItems(der)[0].hstart);
  if (items[1].tag === 0x30) { const inner = der.subarray(items[2].hstart, items[2].end); items = derItems(inner, derItems(inner)[0].hstart); return toBig(inner.subarray(items[1].hstart, items[1].end)); }
  return toBig(der.subarray(items[1].hstart, items[1].end));
}

// ---------- certificate & keys ----------
function derItems(buf, off = 0, end = buf.length) {     // minimal DER walker
  const out = [];
  while (off < end) {
    const tag = buf[off]; let len = buf[off + 1], hl = 2;
    if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = len * 256 + buf[off + 2 + i]; hl = 2 + n; }
    out.push({ tag, start: off, hstart: off + hl, end: off + hl + len }); off += hl + len;
  }
  return out;
}
export const certBody = pem => String(pem).replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
const DN = { '2.5.4.3': 'CN', '0.9.2342.19200300.100.1.25': 'DC', '2.5.4.10': 'O', '2.5.4.11': 'OU', '2.5.4.6': 'C', '2.5.4.7': 'L', '2.5.4.8': 'ST', '1.2.840.113549.1.9.1': 'emailAddress' };
const oidStr = b => { const out = [Math.floor(b[0] / 40), b[0] % 40]; let v = 0; for (const x of b.subarray(1)) { v = v * 128 + (x & 0x7f); if (!(x & 0x80)) { out.push(v); v = 0; } } return out.join('.'); };
export function certInfo(certPem) {
  const body = certBody(certPem), der = Buffer.from(body, 'base64');
  const top = derItems(der)[0], parts = derItems(der, top.hstart, top.end);    // tbs, alg, BIT STRING
  let tbs = derItems(der, parts[0].hstart, parts[0].end); if (tbs[0].tag === 0xa0) tbs = tbs.slice(1);   // [serial, alg, issuer, validity, subject, spki]
  const issuer = derItems(der, tbs[2].hstart, tbs[2].end).map(set => { const av = derItems(der, set.hstart, set.end)[0], [o, v] = derItems(der, av.hstart, av.end);
    const id = oidStr(der.subarray(o.hstart, o.end)); return `${DN[id] || id}=${der.subarray(v.hstart, v.end).toString('utf8')}`; });
  const spki = der.subarray(tbs[5].start, tbs[5].end), spkiParts = derItems(der, tbs[5].hstart, tbs[5].end);
  const pt = der.subarray(spkiParts[1].hstart + 2, spkiParts[1].end);             // skip unused-bits byte and 0x04
  return {
    body,
    hash: b64(Buffer.from(sha256(body).toString('hex'))),       // ZATCA: base64 of the hex digest of the base64 text
    issuer: issuer.reverse().join(', '),
    serial: toBig(der.subarray(tbs[0].hstart, tbs[0].end)).toString(10),
    publicKey: Buffer.from(spki),
    point: [toBig(pt.subarray(0, 32)), toBig(pt.subarray(32, 64))],
    signature: der.subarray(parts[2].hstart + 1, parts[2].end),                 // skip unused-bits byte
  };
}

// ---------- signature block ----------
export const signedPropsForHash = (t, c) => `<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="xadesSignedProperties">
                                    <xades:SignedSignatureProperties>
                                        <xades:SigningTime>${t}</xades:SigningTime>
                                        <xades:SigningCertificate>
                                            <xades:Cert>
                                                <xades:CertDigest>
                                                    <ds:DigestMethod xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                                    <ds:DigestValue xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${c.hash}</ds:DigestValue>
                                                </xades:CertDigest>
                                                <xades:IssuerSerial>
                                                    <ds:X509IssuerName xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${esc(c.issuer)}</ds:X509IssuerName>
                                                    <ds:X509SerialNumber xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${c.serial}</ds:X509SerialNumber>
                                                </xades:IssuerSerial>
                                            </xades:Cert>
                                        </xades:SigningCertificate>
                                    </xades:SignedSignatureProperties>
                                </xades:SignedProperties>`;
const signedPropsInDoc = (t, c) => `<xades:SignedProperties Id="xadesSignedProperties">
                                    <xades:SignedSignatureProperties>
                                        <xades:SigningTime>${t}</xades:SigningTime>
                                        <xades:SigningCertificate>
                                            <xades:Cert>
                                                <xades:CertDigest>
                                                    <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>
                                                    <ds:DigestValue>${c.hash}</ds:DigestValue>
                                                </xades:CertDigest>
                                                <xades:IssuerSerial>
                                                    <ds:X509IssuerName>${esc(c.issuer)}</ds:X509IssuerName>
                                                    <ds:X509SerialNumber>${c.serial}</ds:X509SerialNumber>
                                                </xades:IssuerSerial>
                                            </xades:Cert>
                                        </xades:SigningCertificate>
                                    </xades:SignedSignatureProperties>
                                </xades:SignedProperties>`;
const ublExtension = (h, sph, sv, c, props) => `
    <ext:UBLExtension>
        <ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>
        <ext:ExtensionContent>
            <sig:UBLDocumentSignatures xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2" xmlns:sbc="urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2" xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2">
                <sac:SignatureInformation>
                    <cbc:ID>urn:oasis:names:specification:ubl:signature:1</cbc:ID>
                    <sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>
                    <ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="signature">
                        <ds:SignedInfo>
                            <ds:CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11"></ds:CanonicalizationMethod>
                            <ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"></ds:SignatureMethod>
                            <ds:Reference Id="invoiceSignedData" URI="">
                                <ds:Transforms>
                                    <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::ext:UBLExtensions)</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::cac:Signature)</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"></ds:Transform>
                                </ds:Transforms>
                                <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>
                                <ds:DigestValue>${h}</ds:DigestValue>
                            </ds:Reference>
                            <ds:Reference Type="http://www.w3.org/2000/09/xmldsig#SignatureProperties" URI="#xadesSignedProperties">
                                <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>
                                <ds:DigestValue>${sph}</ds:DigestValue>
                            </ds:Reference>
                        </ds:SignedInfo>
                        <ds:SignatureValue>${sv}</ds:SignatureValue>
                        <ds:KeyInfo>
                            <ds:X509Data>
                                <ds:X509Certificate>${c.body}</ds:X509Certificate>
                            </ds:X509Data>
                        </ds:KeyInfo>
                        <ds:Object>
                            <xades:QualifyingProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Target="signature">
                                ${props}
                            </xades:QualifyingProperties>
                        </ds:Object>
                    </ds:Signature>
                </sac:SignatureInformation>
            </sig:UBLDocumentSignatures>
        </ext:ExtensionContent>
    </ext:UBLExtension>`;

// ---------- QR (phase 2: tags 1–9) ----------
export function tlv(values) {
  return Buffer.concat(values.map((v, i) => { const b = Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8');
    if (b.length > 255) throw new Error('ZATCA_QR_TAG_TOO_LONG ' + (i + 1)); return Buffer.concat([Buffer.from([i + 1, b.length]), b]); }));
}
export function decodeTlv(base64) {
  const b = Buffer.from(base64, 'base64'), out = {}; let i = 0;
  while (i < b.length) { const t = b[i], n = b[i + 1]; out[t] = b.subarray(i + 2, i + 2 + n); i += 2 + n; }
  return out;
}

/**
 * Sign an unsigned invoice from buildInvoiceXML.
 * Returns { xml, hash, qr, signature } — hash becomes the next invoice's PIH on this device.
 */
export function signInvoice({ xml, totals, simplified }, { certPem, privateKeyPem, sellerName, vatNumber, issueDate, issueTime, signingTime }) {
  const hash = invoiceHash(xml);
  const c = certInfo(certPem);
  const signature = b64(ecSign(Buffer.from(hash, 'base64'), privateScalar(privateKeyPem)));
  const ts = `${issueDate}T${String(issueTime).slice(0, 8)}`;             // must equal IssueDate+IssueTime (KSA-25), no zone
  const qr = tlv([sellerName, vatNumber, ts, sar(totals.total), sar(totals.vat), hash, signature, c.publicKey, ...(simplified ? [c.signature] : [])]).toString('base64');
  const t = signingTime || new Date().toISOString().slice(0, 19) + 'Z';     // same form as the SDK sample
  const sph = b64(Buffer.from(sha256(signedPropsForHash(t, c)).toString('hex')));
  const signed = xml.replace('@@UBL_EXTENSIONS@@', ublExtension(hash, sph, signature, c, signedPropsInDoc(t, c))).replace('@@QR@@', qr);
  return { xml: signed, hash, qr, signature, signedPropertiesHash: sph, signingTime: t };
}

export function verifySignature(xml, certPem) {
  const h = (xml.match(/<ds:DigestValue>([^<]+)<\/ds:DigestValue>/) || [])[1];
  const sv = (xml.match(/<ds:SignatureValue>([^<]+)<\/ds:SignatureValue>/) || [])[1];
  return { hashOk: h === invoiceHash(xml), signatureOk: ecVerify(Buffer.from(h, 'base64'), Buffer.from(sv, 'base64'), certInfo(certPem).point) };
}

// ---------- keys & CSR (onboarding) ----------
export function newKeyPair() {
  let d; do d = toBig(randomBytes(32)); while (d <= 0n || d >= N);
  return pem('EC PRIVATE KEY', seq(Buffer.from([2, 1, 1]), tlvd(0x04, to32(d)), tlvd(0xa0, oid(OID_K1)), tlvd(0xa1, tlvd(0x03, Buffer.concat([Buffer.from([0]), pointBytes(pmul(d))])))));
}
// DER encoding, just what a PKCS#10 request needs
const len = n => n < 128 ? Buffer.from([n]) : (n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]));
const tlvd = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const seq = (...p) => tlvd(0x30, ...p), set = (...p) => tlvd(0x31, ...p);
const oid = s => { const a = s.split('.').map(Number), out = [a[0] * 40 + a[1]];
  for (const v of a.slice(2)) { const bytes = []; let x = v; do { bytes.unshift(x & 0x7f); x = Math.floor(x / 128); } while (x); bytes.forEach((b, i) => out.push(i < bytes.length - 1 ? b | 0x80 : b)); }
  return tlvd(0x06, Buffer.from(out)); };
const utf8 = s => tlvd(0x0c, Buffer.from(String(s), 'utf8')), printable = s => tlvd(0x13, Buffer.from(String(s), 'ascii'));
const rdn = (o, v, enc = utf8) => set(seq(oid(o), enc(v)));
const OID = { C: '2.5.4.6', O: '2.5.4.10', OU: '2.5.4.11', CN: '2.5.4.3', SN: '2.5.4.4', UID: '0.9.2342.19200300.100.1.1', title: '2.5.4.12',
  registeredAddress: '2.5.4.26', businessCategory: '2.5.4.15', template: '1.3.6.1.4.1.311.20.2', san: '2.5.29.17', extReq: '1.2.840.113549.1.9.14', ecdsaSha256: '1.2.840.10045.4.3.2' };
export const TEMPLATE = { sandbox: 'TSTZATCA-Code-Signing', simulation: 'PREZATCA-Code-Signing', production: 'ZATCA-Code-Signing' };

/**
 * PKCS#10 CSR with ZATCA's required fields (Security Features Implementation Standards §2.2.2).
 * p: { environment, commonName, orgName, branchName, vatNumber, egsSerial ('1-x|2-y|3-z'), invoiceTypes ('1100'), address, industry }
 */
export function buildCSR(privateKeyPem, p) {
  const d = privateScalar(privateKeyPem), spki = spkiOf(pmul(d));
  const subject = seq(rdn(OID.C, 'SA', printable), rdn(OID.OU, p.branchName), rdn(OID.O, p.orgName), rdn(OID.CN, p.commonName));
  const dir = seq(rdn(OID.SN, p.egsSerial), rdn(OID.UID, p.vatNumber), rdn(OID.title, p.invoiceTypes || '1100'), rdn(OID.registeredAddress, p.address), rdn(OID.businessCategory, p.industry));
  const san = seq(tlvd(0xa4, dir));                                  // GeneralNames { [4] directoryName }
  const exts = seq(
    seq(oid(OID.template), tlvd(0x04, printable(TEMPLATE[p.environment] || TEMPLATE.sandbox))),
    seq(oid(OID.san), tlvd(0x04, san)));
  const attrs = tlvd(0xa0, seq(oid(OID.extReq), set(exts)));
  const info = seq(Buffer.from([0x02, 0x01, 0x00]), subject, Buffer.from(spki), attrs);
  const csr = seq(info, seq(oid(OID.ecdsaSha256)), tlvd(0x03, Buffer.concat([Buffer.from([0]), ecSign(info, d)])));
  return `-----BEGIN CERTIFICATE REQUEST-----\n${b64(csr).match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE REQUEST-----`;
}
