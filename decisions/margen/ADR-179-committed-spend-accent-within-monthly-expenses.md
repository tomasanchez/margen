---
project: margen
adr: 179
title: Committed-spend accent within monthly expenses (paid vs pending, offset-0 no-double-count)
category: business
date: 2026-07-03
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-179: Committed-spend accent within monthly expenses (paid vs pending, offset-0 no-double-count)

## Context

The Home Expense card and Budget page already surface total monthly spend. The owner wants to understand, at a glance, how much of that spend is committed/obligated (recurring subscriptions, installment cuotas, monotributo cuota) versus discretionary. Two sub-questions arise: how much committed spend has already posted this month, and how much is still expected to land before month-end?

Adding a new card or section was considered but rejected — the commitment signal enriches an existing figure rather than introducing a parallel view.

## Decision

Within the **existing** monthly Expenses figures (Home Expense card + Budget page), add a committed-spend accent that breaks the committed portion into two states:

| State | Definition |
|-------|-----------|
| **Paid** | Posted transactions this month whose stream is tagged as committed (`recurring_cadence IS NOT NULL`). Already included in the Expenses total. |
| **Pending** | Expected-this-month committed outflows that have not yet posted. Computed per stream as `expected_this_month − already_posted`. |

"Committed" streams for this accent: recurring subscriptions (`recurring_cadence IN ('monthly','quarterly','annual')`), installment cuotas (`recurring_cadence='installment'`), and the monotributo cuota (ADR-177).

**No-double-count invariant (offset-0 rule):** a stream is "pending" only until its transaction lands; once posted, it flips to "paid." Pending figures are additive context shown alongside the Expenses total — they are never re-added to the spent total. This mirrors the forecast engine's actuals-own-the-past rule (ADR-176) evaluated at the current month (offset 0).

**No new card, no new top-level section.** The accent is rendered as a secondary breakdown below/alongside the existing Expenses figure — a label pair ("Committed paid / pending"), not a promoted metric.

## Alternatives Considered

- **New "Committed" card on the Home dashboard**: Promotes the concept to a top-level figure, competing visually with Expenses and Net Worth; premature before engagement is confirmed; rejected.
- **Show committed total only (no paid/pending split)**: Loses the actionable signal of what is still outstanding this month; rejected.
- **Include discretionary breakdown alongside committed**: Discretionary spend is untagged by definition; showing a "discretionary" figure would require a residual calculation that is misleading when some transactions are untagged; deferred.

## Consequences

- The Expenses read model gains two derived fields: `committed_paid` and `committed_pending` for the current month; no new table.
- The pending figure depends on the forecast engine's stream logic (ADR-176) for computing expected-this-month; the committed-accent read model reuses that logic at offset 0.
- Membership rule for "committed" in this accent (subscriptions + installments + monotributo) **differs** from the liability reservation membership in ADR-182 (installments only). This is intentional; the two concepts serve different purposes and have explicitly different membership.
- As streams are tagged in the ledger (ADR-174), the accent naturally becomes more accurate without schema changes.
- Relates to ADR-040/ADR-043 (Home summaries and Expenses card), ADR-173 (commitment-driven forecast), ADR-174 (recurring_cadence fields that identify committed streams), ADR-176 (no-double-count rule and stream logic reused at offset 0), ADR-177 (monotributo cuota is a committed stream here), ADR-182 (liability reservation — different membership, related concept).

## Status History

- 2026-07-03: accepted
