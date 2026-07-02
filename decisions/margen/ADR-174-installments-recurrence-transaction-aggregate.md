---
project: margen
adr: 174
title: Installments and recurrence modeled lightly on the transaction aggregate
category: data
date: 2026-07-02
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-174: Installments and recurrence modeled lightly on the transaction aggregate

## Context

The commitment-driven forecast (ADR-173) requires the ledger to distinguish transactions that represent recurring obligations (subscriptions, periodic taxes, installment payments) from one-off discretionary spend. Without a signal on each transaction, the forecast engine cannot know which expenses to project forward.

Two modeling options exist: a first-class `InstallmentPlan` / `RecurringSchedule` table (with its own lifecycle — start date, end date, early payoff, refinance) or lightweight nullable columns on the existing transaction aggregate. The owner's demonstrated need is forward projection of known expenses, not lifecycle management of payment plans.

## Decision

Add three nullable columns to the `transactions` table:

| Column | Type | Description |
|--------|------|-------------|
| `recurring_cadence` | `VARCHAR(20)`, nullable | `monthly`, `quarterly`, `annual`, `installment` |
| `installments_total` | `SMALLINT`, nullable | Total number of cuotas (e.g. 12 for a 12-month plan) |
| `installments_index` | `SMALLINT`, nullable | This transaction's position in the sequence (1-based) |

A single `recurring_cadence` field covers all three commitment types:

- **Subscriptions** — `cadence=monthly` (or quarterly/annual), `installments_*` null.
- **Periodic taxes** (e.g. AFIP non-monotributo levies) — `cadence=quarterly` or `annual`, `installments_*` null.
- **Installments** — `cadence=installment`, `installments_index=N`, `installments_total=M`.

The forecast engine uses `installments_total - installments_index` to compute remaining cuotas and projects them at the latest captured amount.

No migration backfills existing rows. Nullable columns only — schema is additive.

A dedicated `InstallmentPlan` entity with a full lifecycle (early payoff, refinance, variable rate) is **explicitly deferred** behind demonstrated need; the overhead of that model is not justified at this stage (YAGNI).

## Alternatives Considered

- **First-class `InstallmentPlan` table**: Models early payoff, refinance, and variable amounts per installment — high cohesion for complex lifecycle but adds a new aggregate, migrations, and CRUD that is not yet needed; deferred.
- **Separate `RecurringSchedule` table with FK**: Allows reuse across accounts but requires a join on the read path for every transaction and adds M:1 complexity when installments deviate from the plan; rejected.
- **Free-text note field only (current state)**: Statement parser already stores `Cuota N/M` as a free-text note — machine-unreadable for the forecast engine; replaced by structured columns (ADR-175 recovers that signal).

## Consequences

- Non-destructive Alembic migration: three nullable columns, no backfill, no existing rows touched.
- The forecast engine can now identify and project subscriptions, periodic taxes, and installment tails from the transaction table directly — no new joins.
- The UI (transaction form + import review) gains optional recurrence fields; they are not required, preserving lean entry for one-off expenses.
- Installment lifecycle features (early payoff, refinance) remain deferred; if demonstrated need arises, a first-class plan entity is the migration target and the nullable columns become a bridge.
- Relates to ADR-024 (transaction model), ADR-173 (commitment-driven forecast that consumes these columns), ADR-175 (statement import auto-populates from parsed cuota), ADR-176 (engine logic for cadence-based projection).

## Status History

- 2026-07-02: accepted
