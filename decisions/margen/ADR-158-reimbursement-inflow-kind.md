---
project: margen
adr: 158
title: Reimbursement as a distinct inflow kind, excluded from income and Monotributo turnover
category: data
date: 2026-07-01
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-158: Reimbursement as a distinct inflow kind, excluded from income and Monotributo turnover

## Context

The owner frequently pays for a group (e.g., a dinner), then receives partial repayments from friends. Until now those repayments were recorded as `kind='income'`, which caused two problems:

1. **Inflated income totals** — a friend paying back their share appears as a new earnings event, distorting the income summary and savings rate.
2. **Gross category spend** — the repayment never reduces the original expense category, so the budget shows the full group spend as if the owner bore all of it.

The existing `kind` field on `transactions` (ADR-027) already gates behavior (e.g., the Monotributo trailing-12 turnover in ADR-046 is `kind='income'` only). Adding a new member keeps the same dispatch pattern without breaking existing code paths.

## Decision

- A new `kind` value `reimbursement` is added to the `transactions` enum / validated string set.
- A reimbursement is a REAL cash inflow: it increases the account balance and is included in net-worth calculations (ADR-122 / ADR-135).
- A reimbursement is EXCLUDED from:
  - Ordinary income totals (monthly summaries, income metric card, savings-rate numerator).
  - Monotributo trailing-12-month turnover (ADR-046) — a refund is not taxable earnings.
- The `kind` dispatch table (ADR-027) is the single gating mechanism; all surfaces that sum income filter by `kind='income'` and therefore naturally exclude `reimbursement` without additional changes per surface.

## Alternatives Considered

- **Tag `income` records with a boolean flag `is_reimbursement`**: avoids a new enum member but requires every income-summing query to add a WHERE clause; the `kind` pattern already provides clean dispatch — rejected in favor of consistency with ADR-027.
- **Separate `reimbursements` table**: clean isolation but overkill for a single additional state; cross-table joins complicate the existing unified `transactions` aggregation pipeline — rejected (YAGNI).
- **Record paybacks as negative expenses**: semantically wrong (cash entered the account, not left it); would also require negative-guard logic throughout the UI — rejected.

## Consequences

- Schema: `transactions.kind` enum gains the `reimbursement` member. Migration is additive; existing rows are unaffected.
- Any query that aggregates income (summaries endpoint, Monotributo reader, insights) must confirm it filters `kind='income'` only — existing filters already do this, so no query changes are expected beyond the enum extension.
- The Add/Edit Transaction form must expose `reimbursement` as a selectable kind alongside `income` and `expense`.
- Rollout is going-forward only: existing `income`-labelled paybacks remain as-is until the owner optionally relinks them (deferred cleanup, no backfill required beyond the schema change).
- Relates to ADR-027 (kind dispatch), ADR-046 (Monotributo turnover), ADR-122/ADR-135 (net-worth / transfers model). The offset link that makes this kind reduce category spend is defined in ADR-159.

## Status History

- 2026-07-01: accepted
