---
project: margen
adr: 162
title: Reimbursement per-surface inclusion matrix, over-refund floor, going-forward rollout, and deferred split module
category: architecture
date: 2026-07-01
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-162: Reimbursement per-surface inclusion matrix, over-refund floor, going-forward rollout, and deferred split module

## Context

The reimbursement model (ADR-158 through ADR-161) introduces a new money kind that must be correctly included or excluded across every surface that aggregates transactions. Without an explicit contract, future contributors may accidentally count a reimbursement twice (once as a balance inflow and again as income) or miss it entirely in a surface that should reflect the real cash position. Additionally, edge-cases and scope boundaries need to be settled upfront to prevent drift.

## Decision

### 1. Per-surface inclusion matrix (the money-correctness contract)

Each reimbursement peso is counted ONCE per meaning and NEVER as income:

| Surface | Include reimbursement? | How |
|---|---|---|
| Account balance | YES | Full ARS inflow — real cash entered the account (same as any deposit) |
| Net worth | YES | Balance feeds net-worth (ADR-122/ADR-135); ARS float at live rate as usual |
| Budget category "spent" | YES — as a SUBTRACTION | Reduces the linked expense's category-month net spend (ADR-160) |
| Monthly summaries — total expenses | YES — as a SUBTRACTION | `month_category_expense_totals` is net (ADR-160) |
| Insights category breakdown | YES — as a SUBTRACTION | Same aggregation as above |
| Historical spending trend | YES — as a SUBTRACTION | Same aggregation as above |
| Ordinary income totals / income metric card | NO | `kind='reimbursement'` is excluded; only `kind='income'` sums here |
| Savings-rate numerator | NO | Derived from income; `kind='reimbursement'` is not income |
| Monotributo trailing-12-month turnover | NO | ADR-046 and ADR-158: refunds are never taxable earnings |

### 2. Over-refund floor

If linked reimbursements for a given expense exceed the expense's `amount` (friends over-transfer or round up):

- Net ARS category spend for that expense FLOORS AT ZERO — the category never goes negative.
- The excess ARS amount (sum of reimbursements minus expense amount) surfaces as ordinary income for the reimbursement's own calendar month. It is credited to the income total for the month in which the last over-refunding payback was recorded.
- The owner is responsible for noticing and handling the excess; no automatic splitting or redistribution is performed.

### 3. Going-forward rollout — no backfill

- Only new reimbursements recorded from this point forward will use `kind='reimbursement'` with an `offsets_transaction_id` link.
- Existing `income`-labelled paybacks remain as `kind='income'` in the database. They continue to inflate income totals until the owner optionally relinks them through the UI (a future one-time cleanup task, explicitly deferred and out of scope here).
- No data migration is required beyond the additive schema changes (new enum member, nullable FK column).

### 4. USD→ARS own-account conversions are out of scope

When the owner sells USD for ARS, that is an own-account FX transfer (ADR-135), not a reimbursement. It must never be recorded with `kind='reimbursement'` and must never be linked via `offsets_transaction_id`. No category spend is affected.

### 5. Split/shared-expense module is deferred (YAGNI)

A full Splitwise-lite module (shared expense creation, automatic split computation, debt tracking, reminder workflow) is explicitly NOT in scope. The `offsets_transaction_id` FK is the forward-compatible seed for such a module should it be built later. The current design intentionally stops at "record a single payback and link it to its source expense."

## Alternatives Considered

- **Treat excess reimbursement as a budget surplus (negative spend)**: negative category spend is confusing in the UI and inconsistent with how every other surface presents money — rejected; floor at zero and push excess to income.
- **Block over-refund at the API layer (validation error)**: stricter but breaks legitimate rounding-up scenarios (e.g., a friend pays ARS 1,200 on a ARS 1,175 share) — rejected in favor of the floor + overflow-to-income rule.
- **Backfill existing income-labelled paybacks automatically**: requires heuristic matching of past income rows to past expenses with no reliable key; high error risk — rejected; owner-driven optional relink is safer.
- **Build the split/expense-sharing module now**: the owner's immediate need is simple payback tracking; a full shared-expense workflow adds scope and UI complexity with no current requirement — rejected (YAGNI).

## Consequences

- Every query that computes income, savings rate, or Monotributo turnover must be verified to filter `kind='income'` only — no new surface-specific changes expected, but this matrix serves as the audit checklist.
- The over-refund floor requires the net-spend query (ADR-160) to use `GREATEST(net_ars, 0)` and a separate pass to identify and route excess to income.
- No migration script is needed for rollout; the schema changes (ADR-158 enum, ADR-159 FK) are additive.
- The `offsets_transaction_id` FK is available as an extension point for a future split-expense feature without further schema changes.
- Relates to ADR-027 (kind dispatch), ADR-046 (Monotributo turnover), ADR-122/ADR-135 (net worth / transfers), ADR-125 (spend aggregation), ADR-156 (budget currency), ADR-158 (reimbursement kind), ADR-159 (offset link), ADR-160 (ARS net spend), ADR-161 (USD derivation).

## Status History

- 2026-07-01: accepted
