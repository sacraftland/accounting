# Recon map: Edarat Qoyoodak / إدارة قيودك (web, responsive)

Scope: full system — sales & invoicing, accounting core, purchases & expenses, inventory, POS, payroll/HR, reports, sector templates, multi-branch, users & roles.
For: Ali — first as the internal system for Craft Land (formerly Dekka & Salabah — caravans & steel structures), then as a SaaS product for Saudi SMEs.
Date: 2026-11-25

> Clean-room rules: everything below comes from public pages only. No login, no JS bundles, no private APIs. Screens inside the app are **inferred** from the marketing pages and standard Saudi accounting-software patterns — marked with confidence. To confirm them, Ali can open a 14-day trial on his own account and walk through it with Claude (with the browser, at human speed), after checking the Terms of Use (not readable publicly — linked behind /login).

## Sources

| # | source | URL | notes |
| --- | --- | --- | --- |
| 1 | marketing home | https://qoyoodak.com/ | modules, FAQ, AI assistant demo, availability, 14-day trial |
| 2 | pricing | https://qoyoodak.com/subscription | 4 plans named: انطلاقة، نمو، تمكّن، تكامل — prices load via JS only |
| 3 | retail solution | https://qoyoodak.com/solutions/retail | POS, multi-branch stock, avg cost, price lists, offline POS, accountant access |
| 4 | contracting solution | https://qoyoodak.com/solutions/contracting | progress billing (مستخلصات), retention, advances, projects/cost centers, site custody from mobile |
| 5 | manufacturing solution | https://qoyoodak.com/solutions/manufacturing | raw/finished warehouses, waste, foreign-currency purchases, landed costs (no BOM mentioned) |
| 6 | clinics solution | https://qoyoodak.com/solutions/clinics | patient files, service billing, per-service VAT treatment, WhatsApp/email reminders |
| 7 | education solution | https://qoyoodak.com/solutions/education | fees & installments, guardian statements, VAT return prep |
| 8 | sectors directory | https://qoyoodak.com/sectors | 24 activities / 8 groups (commerce, food, professional, projects, automotive, health, education, other) — content loads via JS |
| 9 | product video | https://youtu.be/g59PhQ9LJ10 | not yet watched — watch to confirm screens |
| 10 | ZATCA e-invoicing guideline | https://zatca.gov.sa/en/E-Invoicing/Introduction/Guidelines/Documents/E-invoicing-Detailed-Technical-Guideline.pdf | Phase 2: UBL 2.1 XML, signing, CSID onboarding, sandbox |
| 11 | ZATCA developer portal manual | https://sandbox.zatca.gov.sa/20220623_Developer%20Portal%20User%20Manual_vF.pdf | sandbox + compliance APIs |

Note: Qoyoodak (qoyoodak.com, Eduvita) is a different company from Qoyod (qoyod.com). Don't mix sources.

## Core loop

A business owner issues a ZATCA-compliant VAT invoice (from a screen or the POS), and the system automatically posts the journal entry, updates stock and cost, and rolls it into the financial and tax reports — no accountant needed to start.

## Screens

Confidence: H = seen/stated on public pages, M = strongly implied, G = guess from standard patterns.

| ID | screen | route / how to reach | purpose | key components | states | conf |
| --- | --- | --- | --- | --- | --- | --- |
| S01 | Landing page | / | marketing, AR/EN toggle, trial CTA | hero, module cards, AI demo, country selector, FAQ | filled | H |
| S02 | Sign up | /signup | 14-day trial, no card | form, sector picker | empty, error | H |
| S03 | Log in | /login | auth | form | error, loading | H |
| S04 | Account opening / loading | after login | provision tenant + chart of accounts | spinner, retry button | loading, slow, error | H |
| S05 | Onboarding: sector & company setup | after signup | choose activity → auto chart of accounts; VAT no., CR, address, logo | stepper, sector cards | empty, filled | M |
| S06 | Dashboard | home | KPIs: sales, expenses, receivables, cash | stat tiles, charts | empty, filled | M |
| S07 | Quick entry (الإدخال السريع) | dashboard | fast entry of sale/expense/receipt | compact form, type switch | empty, success | H |
| S08 | Customers list + customer detail | sales | contacts, statement, aging | table, search, statement tab | empty, filled | H |
| S09 | Products/services list + item form | inventory | items, barcode, units, prices, VAT treatment | table, form, price lists | empty, filled | H |
| S10 | Sales invoice editor | sales → new invoice | tax / simplified invoice, discounts, VAT | line-item grid, totals, customer picker | draft, issued, error | H |
| S11 | Invoice view / print | sales → invoice | PDF/print with ZATCA QR, send, record payment | A4 + thermal templates, QR | issued, paid, partial, cancelled | H |
| S12 | Credit/debit notes | from invoice | returns & adjustments | linked-invoice form | draft, issued | M |
| S13 | Quotations / sales orders | sales | pre-invoice documents | doc editor | draft, converted | G |
| S14 | Receipt voucher (سند قبض) | sales/cash | collections, installments, partial pay | form, invoice allocation | filled | H |
| S15 | Suppliers + purchase invoice | purchases | supplier bills, statements, aging, partial pay | doc editor | draft, posted, paid | H |
| S16 | Payment voucher (سند صرف) | purchases/cash | pay suppliers/expenses | form | filled | M |
| S17 | Expenses + custody (عهد) | expenses | record expense, employee custody, from mobile, assign to project | mobile form, receipt photo | empty, filled | H |
| S18 | Landed costs / import shipment | purchases | add shipping & customs to item cost, FX | allocation grid | filled | H |
| S19 | Warehouses & branches | settings/inventory | multi-branch, multi-warehouse | list, form | filled | H |
| S20 | Stock transfer | inventory | move stock between warehouses | doc editor | draft, posted | H |
| S21 | Stock count (جرد) | inventory | count with Excel import, variances | grid, import dialog | draft, posted | H |
| S22 | Waste / spoilage | inventory | write-off with auto entry | form | posted | H |
| S23 | POS cashier | pos | barcode checkout, cash/card/split, offline | product grid, cart, payment modal, thermal receipt | online, offline, syncing | H |
| S24 | POS shift / daily close | pos | open/close shift, card-network settlement | summary, cash count | open, closed | H |
| S25 | Chart of accounts | accounting | tree of accounts, sector pre-built | tree view, account form | filled | H |
| S26 | Manual journal entry | accounting | debit/credit entry | balanced grid | draft, posted, unbalanced error | H |
| S27 | General ledger / journal book | reports | entries per account / all entries | filterable table | filled | M |
| S28 | Cost centers & projects | accounting | tag invoices/expenses, project P&L | list, project page | filled | H |
| S29 | Progress billing (مستخلصات) | contracting | cumulative % billing, retention & advance deduction | BOQ-like grid | draft, issued | H |
| S30 | Employees | hr | employee file, salary, allowances, GOSI | table, profile | filled | H |
| S31 | Payroll run | hr | monthly run, deductions, GOSI, posting | run wizard, payslips | draft, approved, posted | H |
| S32 | Leave & end-of-service | hr | leave balances, EOSB calculation | forms, calculator | filled | H |
| S33 | Financial reports | reports | income statement, balance sheet, cash flow, trial balance | report viewer, date filters, export | filled, empty | H |
| S34 | Receivables/payables & aging | reports | aging buckets, statements | report table | filled | H |
| S35 | VAT return report | reports | VAT return prep | report | filled | H |
| S36 | Profitability reports | reports | per project / service / item | report | filled | H |
| S37 | Overdue reminders | sales | auto email + WhatsApp link reminders | settings, log | on/off | H |
| S38 | Users & permissions | settings | roles, read-only accountant access | user list, permission matrix | filled | H |
| S39 | Company & ZATCA settings | settings | VAT no., e-invoicing device onboarding (OTP → CSID) | form, status badge | not linked, linked, error | M |
| S40 | Subscription & billing | settings | plan, trial countdown, upgrade | plan cards | trial, active, expired | H |
| S41 | AI assistant | header/side | Q&A help (demo says no access to business data) | chat box | empty, answering | H |
| S42 | Import/export | various | Excel/PDF export, Excel import | dialogs | — | H |

**42 screens.** Mobile layouts needed for S06, S07, S17, S23.

## Flows

```
F01 New business starts the trial
    S01 -> S02 -> S04 -> S05 -> S06
    happy path clicks: ~6
    edge: slow tenant creation (retry), wrong sector chosen, missing VAT number

F02 Issue a tax invoice and get paid (core loop)
    S06 -> S10 -> S11 -> S14
    auto: journal entry (AR / revenue / VAT output), stock out, COGS at avg cost
    happy path clicks: ~8
    edge: customer without address (mandatory on B2B tax invoice), zero-rated / exempt line, partial payment, credit note after issue

F03 Cashier sale
    S24 open shift -> S23 scan -> pay (cash/card/split) -> receipt
    edge: offline sale then sync, item without stock, return, split payment

F04 Close the day
    S24 -> card-network settlement -> cash variance -> posted entry

F05 Buy stock (including import)
    S15 -> S18 (landed costs, FX) -> stock in, avg cost updated

F06 Record an expense or custody from the phone (site expense)
    S17 -> attach receipt -> assign project/cost center -> auto entry

F07 Move and count stock
    S20 transfer;  S21 count via Excel -> variance entry;  S22 waste -> loss entry

F08 Contracting progress bill
    S28 project -> S29 cumulative % -> retention + advance deducted -> invoice (S11) -> entries

F09 Monthly payroll
    S30 -> S31 run -> GOSI & deductions -> approve -> posted entry -> payment voucher

F10 Month-end & reports
    S26 adjustments -> S33 statements -> S35 VAT return -> export Excel/PDF

F11 Give the accountant read-only access
    S38 invite -> role "accountant (read-only)"

F12 Link with ZATCA (Phase 2)
    S39 -> enter OTP from Fatoora portal -> CSR -> compliance CSID -> compliance checks -> production CSID -> invoices cleared/reported
```

## Components

| component | variants | states | used on |
| --- | --- | --- | --- |
| Button | primary, secondary, ghost, danger | default, hover, focus, disabled, loading | all |
| Document editor (line-item grid) | invoice, bill, credit note, transfer, count | draft, posted, locked | S10, S12, S13, S15, S20, S21, S29 |
| Balanced entry grid | journal, payroll posting | balanced, unbalanced error | S26, S31 |
| Data table | sortable, filterable, with totals row | empty, loading, filled | lists, reports |
| Account tree | chart of accounts | collapsed, expanded, editing | S25 |
| Party picker | customer, supplier, employee | search, create-new | editors |
| Item picker / barcode input | search, scan | found, not found, out of stock | S10, S23 |
| Money / VAT input | amount, %, tax treatment | valid, error | editors |
| Date-range filter | presets (month, quarter, year) | — | reports |
| Status badge | draft, issued, paid, partial, cancelled, ZATCA cleared/rejected | — | lists, docs |
| Print template | A4 tax invoice, simplified, thermal 80mm | with QR | S11, S23 |
| Modal / drawer | confirm, payment, import | open, closed | all |
| Toast | success, error, offline | — | all |
| Stat tile + chart | KPI, trend | empty, filled | S06 |
| Stepper | onboarding, ZATCA linking, payroll run | step n | S05, S31, S39 |
| Sidebar nav (RTL) + language toggle | AR/EN | collapsed (mobile) | app shell |
| Export menu | Excel, PDF | — | reports, lists |

## Inferred data model

```
Tenant/Company  id, name, vat_number, cr_number, address{street,building,city,postal}, sector, base_currency=SAR, plan, trial_ends_at
                evidence: S02, S05, ZATCA mandatory seller fields; confidence: high
Branch          id, company_id, name, address;  Warehouse id, branch_id, name, type(raw|finished|general)
                evidence: retail + manufacturing pages; confidence: high
User / Role     id, email, role, permissions(json), branch_scope;  accountant read-only role
                evidence: clinics + retail pages; confidence: high
Account         id, code, name_ar, name_en, type(asset|liability|equity|revenue|expense), parent_id, is_system
                evidence: "ready chart of accounts built at signup"; confidence: high
JournalEntry    id, date, ref_type, ref_id, memo, status, cost_center_id;  JournalLine entry_id, account_id, debit, credit, project_id
                evidence: "every sale generates its journal entry"; confidence: high
Party           id, type(customer|supplier|guardian|patient), name, vat_number, address, credit_limit, phone
                evidence: S08, S15, education & clinics; confidence: high
Item            id, sku, barcode, name, type(product|service), unit, sale_price, price_list_prices, tax_treatment(standard|zero|exempt), avg_cost
                evidence: retail (avg cost, price lists), clinics (per-service VAT); confidence: high
StockMove       id, item_id, warehouse_id, qty, unit_cost, ref_type(sale|purchase|transfer|count|waste), date
                evidence: transfers, counts, waste; confidence: high
Document        id, kind(tax_invoice|simplified|credit_note|debit_note|quote|bill|transfer|count), number, party_id, branch_id, date, lines[], subtotal, vat, total, status, project_id
                + zatca: uuid, icv(counter), pih(previous hash), hash, qr, signed_xml, clearance_status
                evidence: S10, ZATCA spec; confidence: high (zatca fields from ZATCA spec)
Payment         id, kind(receipt|payment), party_id, amount, method(cash|card|transfer), allocations[{document_id, amount}]
                evidence: installments, partial pay; confidence: high
Expense / Custody  id, employee_id, amount, account_id, project_id, receipt_url
                evidence: contracting + education; confidence: high
Project / CostCenter  id, name, contract_value, retention_pct, advance_amount
ProgressBill    id, project_id, period, cumulative_pct, gross, retention, advance_deduction, net
                evidence: contracting page; confidence: high
POSShift        id, register_id, user_id, opened_at, closed_at, cash_expected, cash_counted, card_total
                evidence: daily settlement; confidence: medium
Employee        id, name, iqama/national_id, nationality, basic, allowances(json), gosi_flags, hire_date
PayrollRun      id, month, status;  Payslip run_id, employee_id, gross, deductions, gosi, net
LeaveRecord, EOSB calc
                evidence: payroll mentions; confidence: medium
ZatcaDevice     id, branch_id, csr, compliance_csid, production_csid, secret, status, expires_at
                evidence: ZATCA onboarding docs; confidence: high
Reminder        id, document_id, channel(email|whatsapp_link), sent_at
```

Relationships: Company 1-n Branch 1-n Warehouse; Company 1-n Account (tree); every Document/Payment/Expense/PayrollRun 1-n JournalEntry; Document 1-n StockMove; Project 1-n ProgressBill, and Project tags Documents/Expenses; Branch 1-n ZatcaDevice.

## ZATCA: what is realistic (answer to "ما أدري إيش القابل للتنفيذ")

| level | what it is | effort | who needs it |
| --- | --- | --- | --- |
| A. Phase 1 invoice | invoice with all mandatory fields + TLV QR code, PDF | small — days | the minimum for everyone |
| B. Phase 2 format | UBL 2.1 XML, UUID, invoice counter, previous-invoice hash, XAdES signature | medium — 2–4 weeks | needed before integration |
| C. Phase 2 integration | onboarding via Fatoora (OTP → CSR → compliance CSID → compliance checks → production CSID), clearance for B2B, reporting for B2C within 24h | large — 1–2 months incl. sandbox testing | businesses whose wave has been called, and any SaaS you sell |

**Recommendation:** build A + B into the first version (design the data model with uuid/hash/counter from day one), develop C against ZATCA's free sandbox in parallel. For selling it as SaaS, C is mandatory — buyers in called waves can't use it without it. An alternative is plugging into a third-party ZATCA middleware API to ship faster.

## Feature matrix

See `features.csv`. 76 rows — must: 45, should: 20, could: 8, skip: 3 (plus multi-country, marked skip for v1).

## Out of scope (cannot or should not be cloned)

- The Qoyoodak name, logo, screenshots, marketing copy and the AI demo answers — rebrand (`/replica-brand`).
- Their sector chart-of-accounts content as-is — write our own charts (based on the SOCPA standard structure).
- Their customer base and any partner deals (payment terminals, banks).
- Multi-country rollout (Jordan, Kuwait, UAE, etc.) — each needs its own tax rules; Saudi only for v1.
- Trademark: Qoyoodak's name is also close to Qoyod — pick a clearly distinct name.

## Size

Screens 42, flows 12, entities ~20. Hard parts:
1. **ZATCA Phase 2 integration** (signing, CSID lifecycle, clearance/reporting, rejections).
2. **Correct double-entry automation** — every document posting balanced entries, weighted average cost/COGS, edits & reversals without breaking the books.
3. **Offline POS with sync** and invoice counters that stay sequential per device.
4. Saudi payroll rules (GOSI, end-of-service) and multi-tenant SaaS security.

Size: **XL → rescope into phases.**
- Phase 1 (L, ~1 quarter): accounting core, sales/purchases/expenses, inventory with avg cost, reports, Phase 1/2-format invoices — usable at Craft Land.
- Phase 2 (M): ZATCA integration, POS, users/roles, multi-branch.
- Phase 3 (M): payroll/HR, contracting progress billing, sector templates, SaaS billing → sell.

Note for architecture: Ali's single-file HTML + Firebase style fits Phase 1 for internal use, but an accounting SaaS with ZATCA signing needs a server side (signing keys must never live in the browser) — `/replica-architect` will decide this.
