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
- The USD reduction contributed by a reimbursement is derived at query time as:

  ```
  reimbursement_usd = reimbursement.amount / linked_expense.fx_rate
  ```

  equivalently expressed as a proportion of the expense's `usd_amount`:

  ```
  reimbursement_usd = expense.usd_amount × (reimbursement.amount / expense.amount)
  ```

- **Net USD spend for a category-month** = `expense.usd_amount − Σ reimbursement_usd` (floored at zero per ADR-162).
- The linked expense's rate is accessed via the `offsets_transaction_id` FK (ADR-159); no additional columns are required on the reimbursement row.
- **Net worth** remains a separate subsystem: ARS cash holdings (including the received reimbursement ARS) float at the live rate as usual (ADR-122/ADR-135). This decision governs only the budget/spend USD representation, not the balance sheet.

## Alternatives Considered

- **Own FX snapshot (capture-time MEP rate on the repayment date)**: introduces a USD discrepancy driven purely by rate movement between expense and repayment dates — not a meaningful economic event; would make "dinner net USD cost" a function of how long friends took to pay — rejected.
- **Float the reimbursement ARS at the live rate (like ARS income in ADR-156)**: historical net USD category spend would drift every time the peso rate moves — defeats the purpose of a stable historical budget record — rejected.
- **Always record net USD at expense time (update expense.usd_amount when paybacks arrive)**: mutates historical records at write time and requires cascading updates for N→1 paybacks; complicates audit trail — rejected; derive at query time instead.

## Consequences

- The `month_category_expense_totals` net USD computation must join `transactions` (reimbursements) with their linked expenses to access `expense.fx_rate` or `expense.usd_amount`.
- Reimbursement rows store `fx_rate = NULL`, `fx_source = NULL`, `usd_amount = NULL`. The Add/Edit form for `kind='reimbursement'` must not render the FX snapshot fields.
- Historical USD net spend per category is stable after the repayment is recorded — it will not change as the peso rate moves.
- ARS net worth figures (ADR-122/ADR-135) are unaffected; the live-rate float for ARS balances continues as-is.
- Relates to ADR-122/ADR-135 (net worth and transfers), ADR-148 (per-transaction FX snapshot), ADR-156 (budget denominated in income currency), ADR-159 (offset link), ADR-160 (ARS net category spend).

## Status History

- 2026-07-01: accepted
