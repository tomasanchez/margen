---
project: margen
adr: 160
title: Net category spend equals gross expense minus linked reimbursements, computed in ARS
category: architecture
date: 2026-07-01
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-160: Net category spend equals gross expense minus linked reimbursements, computed in ARS

## Context

Before this decision, `month_category_expense_totals` (ADR-125) summed all `kind='expense'` rows for a given owner+category+month. Reimbursements (ADR-158) were recorded as `income`, leaving the full group spend attributed to the owner. The goal is for the owner's budget "spent" figure to reflect only what the owner actually bore — the gross group expense minus what friends paid back.

Because both the original group expense and the repayments are ARS transactions (the owner's income is USD; his spending is ARS — the settled money model established in ADR-148), the subtraction is exact and rate-free on the authoritative `amount` column. No FX conversion is needed for the ARS netting step itself.

## Decision

- `month_category_expense_totals` is redefined as **net spend**: `Σ expense.amount − Σ linked_reimbursement.amount`, grouped by `(owner, category, occurred_on month)`.
- Grouping uses the LINKED EXPENSE'S `(category, occurred_on)` for each reimbursement (per ADR-159), not the reimbursement's own date.
- The subtraction is performed on the `amount` column (authoritative ARS, ADR-025) without any FX conversion in this step.
- This net figure propagates through ALL four surfaces that consume `month_category_expense_totals` (the ADR-125 promise: one aggregation, four surfaces):
  - Budget category "spent" meter.
  - Monthly summaries total expenses.
  - Insights category breakdown.
  - Historical spending trend.
- The ARS net is the foundation; the USD representation of net spend is derived separately per ADR-161.

## Alternatives Considered

- **Net only in the budget view, keep gross in summaries/insights**: inconsistency across surfaces would confuse the owner ("spent" means different things in different screens) — rejected; the ADR-125 single-aggregation contract is preserved.
- **Subtract at the reimbursement's own month**: simple query but defeats the timing-skew fix in ADR-159 — rejected.
- **Store pre-netted amount on the expense row at write time**: denormalized; requires updating the expense row whenever a payback is added or deleted — rejected for mutability/audit reasons; derive at query time instead.

## Consequences

- The `month_category_expense_totals` query (or view/CTE) must LEFT JOIN `transactions` on `offsets_transaction_id = expense.id WHERE kind='reimbursement'` and subtract the grouped sum of reimbursement amounts.
- All consumers of `month_category_expense_totals` inherit net spend automatically — no per-surface changes are needed beyond the aggregation layer.
- If linked reimbursements exceed the expense amount the floor is zero and the remainder surfaces as ordinary income — see ADR-162 for the over-refund cap.
- Relates to ADR-025 (ARS as authoritative amount), ADR-125 (spend aggregation contract), ADR-148 (FX snapshot model), ADR-158 (reimbursement kind), ADR-159 (offset link and timing attribution), ADR-161 (USD derivation from expense rate).

## Status History

- 2026-07-01: accepted
