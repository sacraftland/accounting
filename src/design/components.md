# Components — design system v1

Arabic-first, RTL (`dir="rtl"`), English via the language toggle (`dir="ltr"`). Use logical CSS properties (`margin-inline-start`, `padding-inline`) so the same CSS works both ways.
Font: IBM Plex Sans Arabic (open licence, SIL OFL) — Arabic + Latin. Numbers: Western digits (0-9) by default with a setting for Eastern Arabic (٠-٩); always `font-variant-numeric: tabular-nums` in tables and totals so columns line up.
Icons: Lucide (ISC licence), 20px, stroke 1.75. Arrow icons flip in RTL; numbers, currency and checkmarks don't.
Money: `1,250.00 ر.س` — two decimals, thousands separator. Negative = `(1,250.00)` in reports, red only for balances.
Dates: `2026-11-25` in tables, `25 نوفمبر 2026` in documents; Gregorian default, Hijri shown beside it on printed invoices (optional setting).
No Qoyoodak logos, icons, screenshots or copy. All labels are written fresh.

```
Button
  variants  primary (accent), secondary (surface + border), ghost, danger
  sizes     sm 32px, md 40px, lg 48px (POS keys 64px)
  states    default, hover (accent-hover), active, focus-visible (2px ring focus + 2px offset), disabled (50% opacity, no pointer), loading (spinner, label kept for screen readers, aria-busy)
  tokens    bg accent, text on-accent, radius md, font sm/600
  a11y      real <button>; icon-only buttons need aria-label; min touch target 44px on mobile
  used on   all

Text input / Number input / Money input
  variants  text, number, money (right-aligned digits, "ر.س" suffix), percent, search (leading icon)
  states    default, hover, focus (ring), filled, disabled, read-only (surface-2), error (danger border + message below)
  tokens    bg surface, border border-input, radius sm, height 40px, font base
  a11y      <label for>; error linked with aria-describedby; money input accepts both ٠-٩ and 0-9, normalises to 0-9
  used on   all forms

Select / Combobox (party picker, item picker, account picker)
  variants  simple select, searchable combobox, with "+ add new" row at the bottom
  states    closed, open, loading results, no results ("لا توجد نتائج — أضف جديد"), selected, error
  keyboard  ↑↓ move, Enter select, Esc close, type to filter
  a11y      role=combobox, aria-expanded, aria-activedescendant
  used on   S10, S12, S14, S15, S17, S20, S26

Barcode input
  behaviour  always focused on POS; Enter from scanner adds the line; unknown code → toast "صنف غير موجود" + quick-add
  states    ready, found (flash success-soft), not found (danger-soft), out of stock (warning-soft)
  used on   S10, S21, S23

Date input / Date-range filter
  variants  single date, range with presets: اليوم، هذا الشهر، الشهر الماضي، هذا الربع، هذه السنة، مخصص
  states    default, open, invalid range, locked period (disabled days before lock date, tooltip "الفترة مقفلة")
  used on   all documents, all reports

Document editor (line-item grid)
  parts     header (party, date, number, branch, warehouse, cost center) · lines grid (item, description, qty, price, discount, VAT category, line total) · totals box (subtotal, discount, VAT 15%, total) · notes · actions
  states    draft (editable), posted (read-only, "مرحّل" badge, actions: print, send, record payment, credit note), void
  behaviour  Tab moves cell to cell, Enter adds a new line, Delete key removes an empty line; totals recalc live (server recomputes on post)
  mobile    lines become stacked cards; totals sticky at the bottom
  a11y      grid has role=grid with labelled column headers; totals in aria-live=polite
  used on   S10, S12, S13, S15, S20, S21, S29

Balanced entry grid (journal)
  columns   account, cost center, description, debit, credit
  states    balanced (success badge "متوازن"), unbalanced (danger badge with the difference; Post disabled)
  used on   S26, S31

Data table
  features  sort, filter chips, column totals row, sticky header, row actions menu, select rows, pagination 50/page
  states    loading (skeleton rows), empty (icon + one line + primary action), filled, error (retry)
  mobile    becomes a card list (primary field, amount, status badge)
  tokens    row 44px, header surface-2, zebra none, border bottom border
  used on   all lists and reports

Status badge
  values    مسودة draft (surface-2/text-muted) · مرحّل posted (info) · مدفوع paid (success) · جزئي partial (warning) · غير مدفوع unpaid (danger) · ملغي void (text-muted, line-through number) · ZATCA: معتمد cleared / مُبلَّغ reported (success), قيد الإرسال pending (info), تحذير warning (warning), مرفوض rejected (danger)
  tokens    soft bg + strong text of the same family, radius pill, font xs
  a11y      text label always present, never colour alone

Stat tile
  parts     label, value (xl, tabular), change vs last period (↑↓ with success/danger), optional sparkline
  states    loading, filled, empty ("—")
  used on   S06

Account tree
  behaviour  expand/collapse, drag to re-parent (non-system accounts only), group rows bold with rolled-up balance
  states    collapsed, expanded, editing inline, locked (system account — lock icon, tooltip)
  keyboard  → / ← expand/collapse (flipped in RTL), Enter edit
  used on   S25

Modal / Drawer
  variants  confirm (small), form drawer (from the inline-end side, 480px), full-screen on mobile
  states    open, closing, submitting
  a11y      focus trap, Esc closes, return focus to trigger, aria-modal
  used on   payment, import, quick-add party/item

Toast
  variants  success, error, warning, offline ("أنت غير متصل — سيتم الحفظ عند عودة الاتصال")
  behaviour  bottom of screen, auto-hide 4s (errors stay until dismissed), aria-live
  used on   all

Stepper
  used on   S05 onboarding, S31 payroll run, S39 ZATCA linking
  states    done, current, upcoming, error

Sidebar nav + header (app shell)
  sidebar   dark warm (sidebar token), 264px, groups: الرئيسية · المبيعات · المشتريات · المخزون · نقاط البيع · المحاسبة · الموارد البشرية · التقارير · الإعدادات
  header    60px: company/branch switcher, global search (Ctrl K), quick add (+), notifications, language toggle, user menu
  mobile    sidebar becomes a drawer; bottom bar with 4 shortcuts: الرئيسية، فاتورة جديدة، مصروف، التقارير
  used on   every signed-in screen

Print templates
  A4 tax invoice   seller block (name, VAT no., CR, address), buyer block (incl. VAT no. & address for B2B), invoice no., issue date & time, lines with VAT per line, totals, ZATCA QR bottom corner, Arabic + English labels
  Simplified 80mm  thermal receipt, QR, max 48 chars per line
  rules            black on white only, print CSS @page margins 12mm, no app chrome
  used on          S11, S23

POS keypad & cart
  parts     product tiles grid (64px keys), cart list, totals, pay button (lg), payment modal: cash (tendered → change), card, split
  states    online, offline (banner warning-soft), syncing
  used on   S23, S24

Empty state
  parts     Lucide icon 40px text-muted, one sentence, one primary action
  examples  "لا توجد فواتير بعد" + [فاتورة جديدة] · "لم تضف أي عميل" + [إضافة عميل]

Export menu
  options   Excel (.xlsx), PDF, طباعة
  used on   reports, lists
```

## Layout

- Max content width 1280px; forms 880px.
- Breakpoints: sm 640, md 900 (sidebar collapses), lg 1200.
- Grid: 12 columns, gutter 24px desktop / 16px mobile.
- Spacing scale: 0, 4, 8, 12, 16, 24, 32, 48, 64.
- Radius: 6 inputs, 10 cards & buttons, 16 modals, pill badges.

## Contrast report

24 text/UI pairs checked with `contrast.py` — **0 failing AA** (lowest body-text pair 4.98:1, accent on accent-soft).
