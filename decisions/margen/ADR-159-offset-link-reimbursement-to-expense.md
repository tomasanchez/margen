---
project: margen
adr: 159
title: Offset link ties each reimbursement to its source expense for category-month netting
category: data
date: 2026-07-01
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-159: Offset link ties each reimbursement to its source expense for category-month netting

## Context

A reimbursement (ADR-158) reduces the owner's real share of a specific past expense. Two complicating factors exist:

1. **Timing skew.** The expense may land in one calendar month (or bill the following month via credit card — see ADR-089) while the friends' repayments arrive in a different month. Attributing the reduction to the repayment month would net against the wrong budget period.
2. **N friends, one expense.** A single group dinner may generate three separate Mercado Pago transfers, each a partial repayment. All three must subtract from the same original transaction.

Without an explicit link, there is no way to know which expense a reimbursement offsets, nor which category+month to credit.

## Decision

- A nullable self-FK column `offsets_transaction_id UUID REFERENCES transactions(id)` is added to `transactions`.
- The column is populated only when `kind='reimbursement'`; it is NULL for all other kinds.
- **Netting is attributed to the LINKED EXPENSE's `(category, occurred_on)`, never to the reimbursement's own `occurred_on`.** This eliminates the credit-card timing skew: a dinner expensed in June and billed in July is still netted in June regardless of when friends pay back.
- Multiple reimbursements may reference the same expense (N→1). Each is independently linked; partial reimbursements are supported.
- **Application-layer validation** (mirroring the account-ownership guard in ADR-130): when a reimbursement is saved, the API confirms that the target `offsets_transaction_id` belongs to the same owner and has `kind='expense'`. Cross-owner links are rejected.

## Alternatives Considered

- **Attribute reduction to the reimbursement's own month**: simple to implement but produces incorrect budget history when credit-card billing delay separates the expense and payback months — rejected.
- **A separate `reimbursement_links` join table**: supports M→N (one reimbursement splits across multiple expenses), which is not a known use case; adds join complexity for no current benefit — rejected (YAGNI; the FK on `transactions` is sufficient for N→1).
- **Free-text category tag on the reimbursement**: forces the owner to re-enter category metadata already present on the expense; error-prone and inconsistent — rejected.

## Consequences

- Schema: `transactions` gains `offsets_transaction_id UUID NULL REFERENCES transactions(id)`. A partial index `WHERE kind='reimbursement'` is advisable for query performance.
- The net-spend aggregation (`month_category_expense_totals`, ADR-125) must JOIN on this FK to group paybacks by the target expense's category and month — see ADR-160.
- The Add/Edit Transaction form for `kind='reimbursement'` must expose a "links to expense" selector pre-filtered to the owner's expenses.
- The FX implication of this link (stable USD netting via the expense's own FX snapshot) is specified in ADR-161.
- Relates to ADR-027 (kind dispatch), ADR-089 (CC billing-date stamping), ADR-125 (spend aggregation), ADR-130 (ownership validation), ADR-158 (reimbursement kind definition).

## Status History

- 2026-07-01: accepted
