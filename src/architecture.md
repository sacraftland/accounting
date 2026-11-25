# Architecture: working name "Daftar" (a rebuild of Qoyoodak's features)

Name is a placeholder until `/replica-brand`. Saudi market, Arabic-first (RTL), SAR.

## Stack

Ali already builds single-file HTML apps on Firebase + GitHub Pages. The plan keeps the single-file front end, and moves the data to Postgres because accounting needs things Firestore can't do safely: multi-row transactions, foreign keys, sums across thousands of lines, and "this entry must balance" enforced by the database.

| layer | choice | why |
| --- | --- | --- |
| web | **one `index.html` file** — vanilla JS + Supabase JS from CDN, hash router (`#/invoices/new`) | Ali's style; no build step. If the file passes ~8–10k lines, keep editing in modules and bundle back to one file with `vite-plugin-singlefile` — same single-file output |
| styling | CSS custom properties (tokens from replica-design), RTL via `dir="rtl"` + logical properties | no framework needed in one file |
| mobile | same file as an installable web app (PWA manifest + service worker) | expenses from site, POS on a tablet; no app store needed in v1 |
| database | **Supabase Postgres** | real SQL, row level security, managed backups, cheap at zero users |
| business logic | **Postgres functions (RPC)** for every posting (`post_sales_invoice`, `post_payment`…) | the browser can't be trusted to write journal entries; one transaction = books always balance |
| auth | Supabase Auth (email + password, magic link, optional Google) | built in; `auth.uid()` drives RLS |
| server code | **Supabase Edge Functions** (Deno/TypeScript) | ZATCA signing & submission, PDFs, emails, subscription webhooks — anything with a secret |
| secrets | Supabase Vault | ZATCA private keys and CSID secrets never leave the server |
| SaaS payments | **Moyasar** (or Tap) — mada, Apple Pay, cards, tokenized recurring | local Saudi gateways; Stripe isn't reliably available to a Saudi-registered company |
| email | Resend | invoice emails, reminders, invites |
| WhatsApp | `wa.me` links with pre-filled text (v1); WhatsApp Business Cloud API later | same as the original ("WhatsApp links") |
| jobs | Supabase Cron (pg_cron) + Edge Functions | reminders, ZATCA retry queue, trial expiry |
| files | Supabase Storage | receipt photos, logos, archived invoice PDF/XML |
| hosting | Cloudflare Pages (custom domain, free) — or GitHub Pages as today | static file + Supabase backend |
| Excel/PDF export | SheetJS + browser print-to-PDF (v1); server PDF/A-3 for ZATCA later | no server needed for reports |

One database. No microservices.

## Schema

**31 tables + 4 views**, in `replica/schema.sql`. Access rules: **Postgres RLS** on every table, keyed by `org_id` and the `members` table.

Rules baked into the database (tested — see `tests/test_schema.sql`):
- Money in **integer halalas** (1 SAR = 100); quantities `numeric(18,4)`; average cost `numeric(18,4)`.
- **Every posted journal entry must balance** — deferred constraint trigger checked at commit.
- **Posted entries and documents are immutable.** Corrections = credit/debit note or `reverse_entry()`.
- **Period lock** (`orgs.locked_until`) — nothing posts into a closed month.
- **Gap-free numbering** per org and series (`counters` + `next_number()`, row-locked).
- **Weighted average cost** updated on every purchase, including landed costs allocated by value.
- Journal and stock tables are **read-only from the browser**; writes only through RPC functions.
- Read-only accountant role can see everything, change nothing.
- ZATCA fields on every document from day one: `zatca_uuid`, invoice counter (ICV), previous-invoice hash (PIH), hash, QR, XML, status.

Main tables: `orgs, members, branches, warehouses, accounts, cost_centers, journal_entries, journal_lines, counters, parties, items, price_lists, price_list_items, documents, document_lines, payments, payment_allocations, expenses, stock_moves, stock_docs, stock_doc_lines, landed_costs, pos_registers, pos_shifts, zatca_devices, employees, payroll_runs, payslips, leaves, reminders, audit_log`. Views: `stock_balances, trial_balance, ar_aging, project_profit`.

Test results on Postgres 16: buy 2 caravans @ 20,000 + 1,000 shipping → avg cost 20,500 ✔; sell 1 @ 50,000 + 15% VAT = 57,500 ✔; COGS 20,500 ✔; partial receipt 30,000 → status "partial" ✔; trial balance balanced ✔; editing a posted invoice, deleting posted lines, posting an unbalanced entry and double-posting all rejected ✔; a user from another company sees 0 rows ✔.

## API

The front end reads tables directly (RLS filters by company) and calls these for anything that changes the books.

### F01 — sign up & onboarding
| method path | does | who | input | output |
| --- | --- | --- | --- | --- |
| Supabase Auth `signUp` | create user | public | email, password | session |
| RPC `create_org` | create org + owner member + branch + warehouse + sector chart of accounts + counters | signed-in user | name, sector, VAT no, address | org_id |
| RPC `seed_chart(org, sector)` | load our own chart template (SOCPA-style) for the sector | owner | sector | count |

### F02 — sales (core loop)
| method path | does | who | input | output |
| --- | --- | --- | --- | --- |
| table `documents` / `document_lines` insert/update | save draft invoice | sales+ | header, lines | draft |
| RPC `post_sales_invoice` ✔ | recompute totals, number, journal entry, stock out, COGS, mark ZATCA pending | sales+ | doc id | entry id |
| RPC `post_credit_note` | reverse revenue/VAT, stock back in, link original | sales+ | doc id | entry id |
| RPC `post_payment` ✔ | receipt/payment voucher, allocate to invoices, partial/paid | sales+ | payment id | entry id |
| RPC `void_payment` | reversal + un-allocate | admin | payment id | entry id |
| Edge `POST /zatca/submit` | build UBL XML, hash, sign, QR, clear (B2B) or report (B2C) | system/cron | doc id | status |
| Edge `GET /invoice-pdf/:id` | A4 / thermal PDF with QR | member | doc id | PDF |
| Edge `POST /send-invoice` | email PDF to customer | sales+ | doc id | sent |

### F03/F04 — POS
| method path | does | who | input | output |
| --- | --- | --- | --- | --- |
| RPC `open_shift` / `close_shift` | shift with cash count, card settlement entry | cashier | register, cash | shift |
| RPC `pos_sale` | create + post simplified invoice + payment in one call; idempotent on `client_ref` | cashier | cart, payments, client_ref | invoice |
| RPC `pos_sync(batch)` | replay offline sales in order | cashier | sales[] | results[] |

### F05–F07 — purchases, expenses, stock
| method path | does | who | input | output |
| --- | --- | --- | --- | --- |
| RPC `post_purchase_bill` ✔ | AP, input VAT, stock in, avg cost incl. landed cost & FX | storekeeper+ | doc id | entry id |
| RPC `post_expense` | expense or custody entry, cost center, input VAT | member | expense id | entry id |
| RPC `post_stock_doc` | transfer / count variance / waste with loss entry | storekeeper | stock doc id | entry id |
| Storage upload | receipt photo | member | file | path |

### F08 — contracting
| method path | does | who | input | output |
| --- | --- | --- | --- | --- |
| RPC `post_progress_bill` | cumulative % → this period's amount, retention & advance deducted, invoice + entries | sales+ | project, pct | doc id |
| view `project_profit` ✔ | revenue, cost, profit per project | member | — | rows |

### F09 — payroll
| method path | does | who | input | output |
| --- | --- | --- | --- | --- |
| RPC `draft_payroll(month)` | payslips from employees, GOSI, leave, additions | hr | month | run id |
| RPC `post_payroll(run)` | salary expense / GOSI / payable entry | hr, admin | run id | entry id |
| RPC `eosb(employee, date, reason)` | end-of-service calculation (Saudi labor law) | hr | — | amount |

### F10 — reports
| method path | does | who |
| --- | --- | --- |
| view `trial_balance` ✔, RPC `income_statement(from,to)`, `balance_sheet(at)`, `cash_flow(from,to)`, `vat_return(quarter)`, `ledger(account,from,to)`, `party_statement(party,from,to)`, view `ar_aging` ✔ / `ap_aging` | all reports, exported in the browser to Excel/PDF | member incl. read-only accountant |

### F11/F12 — settings, users, ZATCA, subscription
| method path | does | who |
| --- | --- | --- |
| RPC `invite_member(email, role)` + Auth invite | add user / read-only accountant | owner, admin |
| RPC `lock_period(date)` | close the month | owner, admin |
| Edge `POST /zatca/onboard` | OTP → key pair + CSR → compliance CSID → 6 compliance invoices → production CSID; keys into Vault | owner |
| Edge `POST /billing/checkout` | Moyasar hosted checkout for a plan | owner |

**Webhooks in:** Moyasar `payment_paid / failed` → extend plan (idempotent on payment id). **Webhooks out:** none in v1.

**Jobs:**
| job | schedule | does |
| --- | --- | --- |
| `zatca_queue` | every minute | submit `pending` docs; retry with backoff; B2C must be reported within 24h |
| `csid_expiry` | daily | warn 30 days before a certificate expires |
| `overdue_reminders` | daily 09:00 Riyadh | email + WhatsApp link for overdue invoices, max one per 7 days per invoice |
| `trial_expiry` | daily | read-only mode after trial / failed renewal (never delete data) |
| `backup_export` | daily | Supabase backups + weekly CSV export per org to storage |

Total: **~32 routes** (21 RPC, 7 edge functions, 4 report views) + 5 jobs. ✔ = written and tested.

## The parts that bite

- **ZATCA Phase 2:** hash chain is per device and strictly ordered — two invoices signed at the same time on one device break the chain. Sign in the queue job, one device at a time (`select … for update` on `zatca_devices`). Rejected invoices can't be edited: fix with a credit note. Test everything in ZATCA's sandbox first.
- **Rounding:** VAT computed per line and rounded to the halala, then summed. ZATCA validates totals to the halala — one rounding rule everywhere, server-side only.
- **Average cost:** a backdated purchase changes the cost of sales already posted. v1 rule: no backdating purchases before the last sale of that item (or a "recalculate cost" job later).
- **Idempotency:** offline POS replays and payment webhooks arrive twice — unique `client_ref` and payment ids.
- **Races:** two cashiers, one counter — `next_number()` row-locks; one open shift per register (unique index).
- **Offline POS:** IndexedDB queue in the browser; offline sales get numbers only on sync; simplified invoices reported within 24h.
- **Time zones:** business dates are Riyadh dates (`date`), timestamps UTC. "Today" on the server must use `Asia/Riyadh`, not UTC (00:00–03:00 is the danger window).
- **Multi-tenancy:** every table has `org_id` + RLS; a test must prove a stranger sees 0 rows (already in the tests). Never use the service-role key in the browser.
- **Immutability vs. "I made a mistake":** users will want to edit posted invoices. The UI must offer "issue credit note & re-issue" in one click.
- **Payroll:** GOSI rates and EOSB rules change — keep rates in a settings table, not code.
- **File sizes:** compress receipt photos in the browser (max ~1 MB) before upload.
- **Data export & deletion:** an owner can export everything; closing an account keeps tax records for the legally required retention period, then deletes.

## Build order

1. **Vertical slice (2–3 weeks):** sign up → company + chart of accounts → add customer & item → issue tax invoice with QR → receipt → trial balance.
   Screens S02–S06, S08–S11, S14, S25, S33 (trial balance). Tables: orgs, members, branches, warehouses, accounts, parties, items, documents, document_lines, journal_*, payments, counters. Routes: `create_org`, `seed_chart`, `post_sales_invoice`, `post_payment`, `trial_balance`.
2. **Must-haves — books (Phase 1, usable at Craft Land):** purchases & landed cost, expenses & custody, inventory & transfers, cost centers/projects & project profit, credit notes, manual entries & reversal, income statement, balance sheet, VAT return, aging, statements, Excel/PDF export, users & roles, period lock, ZATCA XML + signing format (level B).
3. **Must-haves — operations (Phase 2):** ZATCA onboarding & clearance/reporting (level C, sandbox → production), POS + shifts, multi-branch, payroll + GOSI + EOSB.
4. **Should-haves (Phase 3, to sell):** progress billing, offline POS, reminders, price lists, stock counts via Excel, FX purchases, read-only accountant invites, subscription billing with Moyasar, sector templates.
5. **Could-haves:** quotations, clinic/education modules, AI help assistant.
6. **Fixes from replica-entrepreneur:** after we read what Qoyoodak's and similar tools' users complain about.

## Known gaps in schema v1 (next migration)
- `void_payment` must also undo allocations (reversal alone doesn't yet reset `amount_paid`).
- `post_credit_note`, `post_expense`, `post_stock_doc`, `post_progress_bill`, payroll posting — designed above, not written yet.
- `ap_aging` view and the statement/report RPCs.
