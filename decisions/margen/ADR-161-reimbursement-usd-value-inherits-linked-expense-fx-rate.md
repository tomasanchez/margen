---
project: margen
adr: 161
title: Reimbursement USD value inherits the linked expense's FX rate; no own snapshot, no dynamic float
category: data
date: 2026-07-01
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-161: Reimbursement USD value inherits the linked expense's FX rate; no own snapshot, no dynamic float

## Context

The owner's budgets are denominated in USD (ADR-156). Category spend in USD is derived from the per-transaction `usd_amount` stored at capture time (ADR-148). When a reimbursement reduces category spend, the question is: what USD reduction does it represent?

Two naive alternatives were considered and rejected during design:

- **Own FX snapshot on the reimbursement**: the repayment is ARS cash received days or weeks after the expense. The MEP rate on the repayment date will likely differ from the expense date, creating a USD discrepancy that is an artifact of rate movement rather than a real economic difference.
- **Dynamic conversion of the reimbursement's ARS at the live rate**: the USD figure would drift every time the rate changes, making historical net USD spend unstable and unreliable as a budget benchmark.

The expense already carries a stable `fx_rate` and `usd_amount` (ADR-148). Riding that same rate for the payback is economically correct: the dinner was settled at one rate; the owner's USD exposure is measured relative to the moment they paid, not the moment a friend repaid.

## Decision

- A `reimbursement` transaction carries NO FX snapshot of its own (`fx_rate`, `fx_source`, `usd_amount` are NULL).
- The USD reduction contributed by a reimbursement is derived at query time using the **proportional form** (the implemented form):

  ```
  reimbursement_usd = expense.usd_amount × (reimbursement.amount / expense.amount)
  ```

  This is mathematically equivalent to the division form (`reimbursement.amount / linked_expense.fx_rate`, because `usd_amount = amount / fx_rate`), but the proportional form is preferred for a concrete reason: it requires only `expense.usd_amount`, not `expense.fx_rate`. This means the null-snapshot exclusion set for the USD reduction leg (exclude when `expense.usd_amount IS NULL`) matches the exclusion set for the USD gross side exactly — both legs gate on the same column. The division form would gate the gross side on `usd_amount IS NULL` and the reduction side on `fx_rate IS NULL`; if a snapshot row ever carries one but not the other, the two legs would exclude asymmetrically and produce a USD figure that is partially net and partially gross. The proportional form eliminates this asymmetric-exclusion risk and preserves ADR-152 (null-snapshot rows are excluded wholesale from USD aggregations). *(Amendment 2026-07-01: the original draft listed only the division form as primary; the proportional form was noted as an equivalent. Code review confirmed the implementation uses the proportional form for the symmetric-exclusion reason above, which is the more correct choice.)*

- **Net USD spend for a category-month** = `expense.usd_amount − Σ reimbursement_usd` (floored at zero per ADR-162).
- The linked expense's rate is accessed via the `offsets_transaction_id` FK (ADR-159); no additional columns are required on the reimbursement row.
- **Net worth** remains a separate subsystem: ARS cash holdings (including the received reimbursement ARS) float at the live rate as usual (ADR-122/ADR-135). This decision governs only the budget/spend USD representation, not the balance sheet.

## Alternatives Considered

- **Own FX snapshot (capture-time MEP rate on the repayment date)**: introduces a USD discrepancy driven purely by rate movement between expense and repayment dates — not a meaningful economic event; would make "dinner net USD cost" a function of how long friends took to pay — rejected.
- **Float the reimbursement ARS at the live rate (like ARS income in ADR-156)**: historical net USD category spend would drift every time the peso rate moves — defeats the purpose of a stable historical budget record — rejected.
- **Always record net USD at expense time (update expense.usd_amount when paybacks arrive)**: mutates historical records at write time and requires cascading updates for N→1 paybacks; complicates audit trail — rejected; derive at query time instead.

## Consequences

- The `month_category_expense_totals` net USD computation must join `transactions` (reimbursements) with their linked expenses to access `expense.usd_amount` (proportional form — see Decision above; `fx_rate` is not needed on the join path).
- Reimbursement rows store `fx_rate = NULL`, `fx_source = NULL`, `usd_amount = NULL`. The Add/Edit form for `kind='reimbursement'` must not render the FX snapshot fields.
- Historical USD net spend per category is stable after the repayment is recorded — it will not change as the peso rate moves.
- ARS net worth figures (ADR-122/ADR-135) are unaffected; the live-rate float for ARS balances continues as-is.
- **Proportional form and symmetric null-snapshot exclusion (Amendment 2026-07-01):** The implementation uses `expense.usd_amount × (reimbursement.amount / expense.amount)` rather than the algebraically identical `reimbursement.amount / expense.fx_rate`. Because both the gross USD side and the USD reduction side now gate exclusively on `expense.usd_amount IS NULL`, a row that has `usd_amount` but a missing `fx_rate` (or vice versa) cannot cause one leg to be included while the other is excluded. This preserves ADR-152's null-snapshot exclusion contract: when a snapshot is absent, both the gross expense USD and its reimbursement USD reduction are excluded together, leaving USD aggregations internally consistent.
- Relates to ADR-122/ADR-135 (net worth and transfers), ADR-148 (per-transaction FX snapshot), ADR-152 (null-snapshot exclusion), ADR-156 (budget denominated in income currency), ADR-159 (offset link), ADR-160 (ARS net category spend).

## Status History

- 2026-07-01: accepted
- 2026-07-01: amended — Decision section updated to make proportional form the primary (implemented) form with symmetric-exclusion rationale; Consequences updated to match and to add ADR-152 cross-link
