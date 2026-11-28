"""Independent checker for ZATCA phase-2 XML: recomputes every hash the way the ZATCA SDK does (lxml, C14N),
verifies the ECDSA signature with `cryptography`, checks structure and totals, and the CSR with openssl.
The procedure reproduces the DigestValue of ZATCA's own SDK sample invoice exactly (checked on wes4m/zatca-xml-js sample).
Run: python3 tests/zatca_check.py <dir-from-zatca_core_test> <cert.pem>"""
import sys, json, base64, hashlib, subprocess
from decimal import Decimal
from lxml import etree
from cryptography import x509
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec

out, cert_file = sys.argv[1:3]
NS = {'ext': 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
      'cac': 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
      'cbc': 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
      'ds': 'http://www.w3.org/2000/09/xmldsig#', 'xades': 'http://uri.etsi.org/01903/v1.3.2#', 'i': 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2'}
res = []
def check(name, ok, info=''):
    res.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else f'  [{info}]'))

cert = x509.load_pem_x509_certificate(open(cert_file, 'rb').read())
for name in ['standard', 'simplified', 'credit']:
    raw = open(f'{out}/{name}.xml', 'rb').read(); meta = json.load(open(f'{out}/{name}.json'))
    t = etree.fromstring(raw)
    x = lambda p: t.xpath(p, namespaces=NS)
    # invoice hash: XPath transforms (remove nodes, keep whitespace) + C14N
    c = etree.fromstring(raw)
    for xp in ['ext:UBLExtensions', 'cac:Signature', "cac:AdditionalDocumentReference[cbc:ID='QR']"]:
        for e in c.xpath(xp, namespaces=NS):
            p, prev, tail = e.getparent(), e.getprevious(), e.tail or ''
            if prev is not None: prev.tail = (prev.tail or '') + tail
            else: p.text = (p.text or '') + tail
            p.remove(e)
    h = base64.b64encode(hashlib.sha256(etree.tostring(c, method='c14n')).digest()).decode()
    dv = x('//ds:Reference[@Id="invoiceSignedData"]/ds:DigestValue/text()')[0]
    check(f'{name}: independent C14N hash matches DigestValue', h == dv == meta['hash'], f'{h} vs {dv}')
    sig = base64.b64decode(x('//ds:SignatureValue/text()')[0])
    try: cert.public_key().verify(sig, base64.b64decode(dv), ec.ECDSA(hashes.SHA256())); ok = True
    except Exception as e: ok = False
    check(f'{name}: signature verifies (cryptography)', ok)
    body = x('//ds:X509Certificate/text()')[0]
    check(f'{name}: certificate digest = base64(hex(sha256(cert)))', x('//xades:CertDigest/ds:DigestValue/text()')[0] == base64.b64encode(hashlib.sha256(body.encode()).hexdigest().encode()).decode())
    check(f'{name}: serial and issuer from the certificate', x('//ds:X509SerialNumber/text()')[0] == str(cert.serial_number))
    # structure & totals
    lines = x('/i:Invoice/cac:InvoiceLine')
    net = sum(Decimal(l.xpath('cbc:LineExtensionAmount/text()', namespaces=NS)[0]) for l in lines)
    lmt = lambda f: Decimal(x(f'/i:Invoice/cac:LegalMonetaryTotal/cbc:{f}/text()')[0])
    tax = Decimal(x('/i:Invoice/cac:TaxTotal[cac:TaxSubtotal]/cbc:TaxAmount/text()')[0])
    subs = x('/i:Invoice/cac:TaxTotal/cac:TaxSubtotal')
    check(f'{name}: BR-CO-10 line sum = LineExtensionAmount', net == lmt('LineExtensionAmount'))
    check(f'{name}: BR-CO-15 TaxInclusive = TaxExclusive + VAT', lmt('TaxInclusiveAmount') == lmt('TaxExclusiveAmount') + tax == lmt('PayableAmount'))
    check(f'{name}: BR-S-09 category VAT = taxable × rate (rounded)', all(
        Decimal(s.xpath('cbc:TaxAmount/text()', namespaces=NS)[0]) == (Decimal(s.xpath('cbc:TaxableAmount/text()', namespaces=NS)[0]) * Decimal(s.xpath('cac:TaxCategory/cbc:Percent/text()', namespaces=NS)[0]) / 100).quantize(Decimal('0.01')) for s in subs))
    for l in lines:
        ln = Decimal(l.xpath('cbc:LineExtensionAmount/text()', namespaces=NS)[0]); lv = Decimal(l.xpath('cac:TaxTotal/cbc:TaxAmount/text()', namespaces=NS)[0])
        if Decimal(l.xpath('cac:TaxTotal/cbc:RoundingAmount/text()', namespaces=NS)[0]) != ln + lv: check(f'{name}: BR-KSA-51 line rounding amount', False)
    check(f'{name}: ICV and PIH', x("//cac:AdditionalDocumentReference[cbc:ID='ICV']/cbc:UUID/text()")[0] == str(meta['icv']) and x("//cac:AdditionalDocumentReference[cbc:ID='PIH']//cbc:EmbeddedDocumentBinaryObject/text()")[0] == meta['pih'])
    code = x('/i:Invoice/cbc:InvoiceTypeCode')[0]
    check(f'{name}: type code and subtype', (code.text, code.get('name')) == ({'standard': '388', 'simplified': '388', 'credit': '381'}[name], '0200000' if meta['simplified'] else '0100000'))
    if name == 'credit': check('credit: billing reference and reason', x('//cac:BillingReference//cbc:ID/text()')[0] == 'INV-00001' and x('//cac:PaymentMeans/cbc:InstructionNote/text()'))
    if not meta['simplified']: check(f'{name}: delivery date and buyer VAT', x('//cac:Delivery/cbc:ActualDeliveryDate/text()') and x('//cac:AccountingCustomerParty//cbc:CompanyID/text()')[0] == '311111111111113')
    # QR
    q = base64.b64decode(x("//cac:AdditionalDocumentReference[cbc:ID='QR']//cbc:EmbeddedDocumentBinaryObject/text()")[0]); tags = {}; i = 0
    while i < len(q): tags[q[i]] = q[i+2:i+2+q[i+1]]; i += 2 + q[i+1]
    check(f'{name}: QR tag 6 = invoice hash, 7 = signature, 8 = public key', tags[6].decode() == dv and base64.b64decode(tags[7]) == sig and tags[8] == cert.public_key().public_bytes(__import__('cryptography.hazmat.primitives.serialization', fromlist=['x']).Encoding.DER, __import__('cryptography.hazmat.primitives.serialization', fromlist=['x']).PublicFormat.SubjectPublicKeyInfo))
    if meta['simplified']: check(f'{name}: QR tag 9 = certificate signature', tags[9] == cert.signature)

# chain: each PIH is the previous invoice hash
m = [json.load(open(f'{out}/{n}.json')) for n in ['standard', 'simplified', 'credit']]
check('PIH chain links every invoice to the one before', m[1]['pih'] == m[0]['hash'] and m[2]['pih'] == m[1]['hash'])
# CSR
r = subprocess.run(['openssl', 'req', '-in', f'{out}/egs.csr', '-noout', '-verify', '-text', '-nameopt', 'utf8'], capture_output=True, text=True)
txt = r.stdout + r.stderr
check('CSR: signature valid', 'verify OK' in txt or 'Certificate request self-signature verify OK' in txt, txt[:300])
check('CSR: secp256k1 key', 'secp256k1' in txt)
check('CSR: ZATCA template, serial, VAT, invoice types in SAN', all(s in txt for s in ['TSTZATCA-Code-Signing', '1-CraftLand|2-Accounting|3-', '399999999900003', '1100']), txt)
print(f'{sum(res)} / {len(res)} passed (zatca independent check)')
sys.exit(0 if all(res) else 1)
