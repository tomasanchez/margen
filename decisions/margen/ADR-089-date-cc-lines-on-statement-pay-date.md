---
project: margen
adr: 089
title: Date credit-card lines on the statement pay date; preserve purchase date; reconcile on it
category: data
date: 2026-06-15
status: accepted
supersedes: ADR-079 (line-date mapping only)
authors: [Tomas Sanchez]
---

# ADR-089: Date credit-card lines on the statement pay date; preserve purchase date

## Context

ADR-079 mapped a statement line's `occurred_on` to the **purchase date** (the line's
FECHA). Two problems surfaced in use:

1. **Cashflow mismatch.** The money leaves the account on the statement **due date**
   (the card auto-debits the total then), but a purchase made in March was counted in
   March — before it is paid — so a monthly income-vs-expense (margin) view is skewed.
2. **Installments look duplicated.** The statement reprints the **original purchase
   date** on every installment line (e.g. `15-05-26 … 01/03`, then `15-05-26 … 02/03`
   next month). Dating each slice on that shared purchase date produces several rows
   with the same date + merchant + (equal) amount across consecutive imports —
   indistinguishable except for the "Cuota n/m" note.

## Decision

For every imported statement line (purchases and fees):

- **`occurred_on` = the statement due/pay date** (`period_due`; fall back to the line's
  purchase date if the statement carries no parseable due date). The whole statement
  therefore counts in the month it is paid, and each installment slice lands in *its*
  statement's month (Jun / Jul / Aug…) rather than piling on the purchase date.
- **The original purchase date is preserved** in the transaction `notes` (e.g.
  "Compra 20-03-26 · Cuota 03/03"), so timing detail is not lost. No new column —
  `notes` is sufficient (no migration).
- **Reconciliation matches on the purchase date** (ADR-084/085), not on `occurred_on`:
  a user logs a manual expense at *purchase* time, so the matcher compares the
  statement line's purchase date (FECHA) against the manual candidate's `occurred_on`.
  Decoupling the displayed/grouping date (pay date) from the match date (purchase date)
  keeps reconciliation working after this change.

This supersedes the `occurred_on` row of ADR-079's mapping table; the rest of ADR-079
(amount, name, payment_method, fee netting, skip rules, USD handling, as-billed
installments) stands.

## Alternatives Considered

- **Keep purchase date as `occurred_on`** (ADR-079 original): accurate purchase timing,
  but the cashflow skew and the installment look-alikes above — rejected.
- **Hybrid: store both and let the month view group by a `paid_period` field**:
  most flexible, but adds a column and teaches the month navigator + summaries to group
  by it — more plumbing than warranted now; `occurred_on` = pay date with purchase date
  in notes achieves the goal — deferred.
- **Match reconciliation on `occurred_on` (the pay date)**: would break matching against
  manual entries logged at purchase time (weeks apart from the due date) — rejected;
  matching on the purchase date is the point.

## Consequences

CC expenses count in the month they are paid; installments spread naturally across the
months they are billed instead of looking duplicated. Purchase timing is retained in
`notes`. The matcher reads the line's purchase date (carried on the parsed draft) for
its date window. No schema/migration change. The month navigator and summaries already
group by `occurred_on`, so they reflect payment months with no further change.

Relates to: ADR-079 (mapping; date row superseded), ADR-084/085 (reconciliation; date
window now on purchase date), ADR-075 (line-items-as-expenses), ADR-041 (occurred_on
drives the month).

## Status History

- 2026-06-15: accepted
