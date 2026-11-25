# Build log

App: `app/index.html` — one self-contained file (~126 KB), built from `app/qr.js`, `app/data.js`, `app/app.js`, `app/app.css`, `app/chart.json` and the design-system CSS by `python3 app/build.py`.
Tests: `python3 tests/e2e_slice.py` (45 checks, Chrome) · `tests/test_schema.sql` (Postgres 16).

| ID | screen | date | status | missing / notes |
| --- | --- | --- | --- | --- |
| — | app shell, router, sidebar, mobile bottom bar | 2026-11-25 | done | stubs for purchases, expenses, inventory, POS, reports, payroll |
| S02 | sign up | 2026-11-25 | done | email + password with confirmation, Google, resend confirmation |
| S03 | log in | 2026-11-25 | done | Google, magic link, forgot / reset password, expired-link message |
| S04 | account opening | 2026-11-25 | done | loading states + retry on error |
| S05 | company setup | 2026-11-25 | done | one chart for all sectors (58 accounts) |
| S06 | dashboard | 2026-11-25 | done | 4 KPIs + latest invoices, empty state |
| S08 | customers + statement | 2026-11-25 | done | VAT validation, national address, balance |
| S09 | items & services | 2026-11-25 | done | stock on hand goes negative until purchases exist |
| S10 | invoice editor | 2026-11-25 | done | drafts, live totals, Arabic digits, keyboard Enter = new line, ZATCA field checks |
| S11 | invoice view / print | 2026-11-25 | done | A4 print/PDF + Phase 1 QR (decoded and checked); journal entry and payments shown |
| S14 | receipt voucher | 2026-11-25 | done | auto-allocation oldest-first, over-allocation blocked |
| S25 | chart of accounts | 2026-11-25 | partial | view with rolled-up balances; add/edit accounts next |
| S33 | trial balance | 2026-11-25 | done | CSV export |
| S40 | settings | 2026-11-25 | partial | company, logo, invoice footer, back-end switch, demo data; plans/billing later |

## Harder than expected
- **QR code without a library or network**: wrote our own QR encoder (byte mode, level M). Verified by decoding with OpenCV, including long Arabic seller names.
- **Arabic digits**: users type ٠-٩ in amounts, VAT numbers and quantities; everything is normalised to 0-9 before saving.
- **Mobile tables** inside grids pushed the page wider than the screen; fixed with `min-width:0` on grid children.

## Honest status of the back end
- **Local mode** (no Supabase keys in the file): unchanged, `tests/e2e_slice.py` 45/45.
- **Supabase mode**: database tested on Postgres 16 with Supabase's roles and default grants (`tests/run_supabase_tests.sh`, 44/44, incl. a second company seeing nothing). Sign-in screens tested in Chrome against a stand-in for supabase-js (`tests/e2e_auth.py`, 33/33).
- **Not yet run against a live Supabase project** — needs Ali's project URL + anon key (steps in `deploy/README.md`). First live run: sign up, Google, one invoice + receipt, trial balance.
