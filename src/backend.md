# Back end status (Supabase)

Live project: `craftland-accounting` (ref `ahxcjrxampkssromiafy`, eu-central-1 Frankfurt), migrations 01–03 applied 2026-11-25, live smoke test passed (rolled back). Keys baked into `deploy/index.html` (publishable key only).

Setup: `supabase/setup.sql` (= `01_schema.sql` + `02_supabase.sql`) pasted once into the SQL editor. Step-by-step for Ali: `deploy/README.md`.

## Auth (Supabase Auth, implicit flow — links work when opened on another device)
- [x] Email + password sign-up with email confirmation, resend confirmation
- [x] Sign-in, Arabic error messages, rate limits = Supabase built-in
- [x] Magic link (passwordless)
- [x] Forgot password → email → set new password screen
- [x] Google OAuth with Ali's own Google Cloud client (scopes: openid, email, profile — no Google verification needed)
- [x] Expired / invalid link → clear message on login
- [ ] Custom SMTP (Resend) before real users — built-in mailer is rate-limited
- [ ] Invite members / roles screen, account deletion (owner closes company)

## Database hardening added in 02_supabase.sql (tested: `bash tests/run_supabase_tests.sh`, 44/44)
- [x] anon role: no table or function access
- [x] journal, stock moves, counters, members, ZATCA devices: read-only from browser
- [x] orgs: only profile columns editable (plan, trial, period lock are not)
- [x] only API functions callable (create_org, post_*, reverse_entry); internals (seed_chart, next_number) blocked; new functions blocked by default
- [x] stock_balances view now respects RLS (it leaked all companies' stock before)
- [x] browser can only write drafts; server-owned fields (number, totals, paid, ZATCA) reset on client writes
- [x] lines/receipts/allocations can't reference another company's records
- [x] post_payment validates each allocation (same org, posted, ≤ open amount)
- [x] stranger sees 0 rows on every table/view tested

## Security checklist
- [x] only the public anon key in the page; service_role never used in the browser
- [x] authorisation enforced in the database (RLS + guards), tested with a second user
- [x] auth rate limits (Supabase)
- [ ] logo stored as a data URL in `orgs.logo_path` (≤300 KB) — move to Storage bucket later
- [ ] supabase-js loaded from jsDelivr pinned to 2.45.4 — vendor into the file later to drop the CDN dependency
- [ ] privacy policy listing processors (Supabase, Google, email provider) before selling
- [ ] payments (Moyasar), email (Resend), ZATCA edge functions — next phases
