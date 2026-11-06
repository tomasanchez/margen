---
project: margen
adr: 214
title: "Receivable item installment schedule via child receivable_installment table"
category: data
date: 2026-11-06
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-214: Receivable item installment schedule via child receivable_installment table

## Context

The Owed tab (ADR-203/204) currently models a debt as a single flat `receivable_item`. Some debts are naturally paid back in installments (cuotas) — e.g. a friend repaying a shared purchase in monthly chunks, or money lent that's repaid over several months — and the owner wants to track each cuota (due date, amount, pay/pardon status) individually while still seeing the purchase as one coherent debt. This is distinct from, but conceptually parallel to, the transaction-level `installments_total`/`installments_index` columns (ADR-174) used for the owner's own card cuotas — these are the debtor's cuotas, on the receivables side.

## Decision

A `receivable_item` may optionally carry a child installment schedule: a new `receivable_installment` table (`id`, `item_id` FK, `index` 1..N, `due_on` date, `amount` Decimal, `pardoned_at` nullable timestamp — mirroring ADR-210's pardon column at the cuota grain). The sum of a schedule's cuota amounts always equals the parent item's `amount`. Items without a schedule behave exactly as before (no `receivable_installment` rows) — this is purely additive, not a replacement of the existing flat item.

The model is generic, not card-specific: it covers any debt repaid in installments (a split purchase, money lent repaid over time), not only card-cuota-shaped debts.

ARS-only, matching receivables v1 scope (ADR-204).

## Alternatives Considered

- **N independent `receivable_item` rows sharing a `plan_id`**: avoids a new table, but loses the purchase's total-amount identity and makes editing the plan as a whole (e.g. re-splitting, early payoff) clumsy across N separate rows — rejected.
- **Derive the schedule from columns on `receivable_item` itself** (e.g. `installments_total`, `installments_index`-style, no child rows): cheaper schema, but cannot represent per-cuota pay/pardon status or per-cuota amount/date edits (ADR-216) — rejected.

## Consequences

- New Alembic migration: `receivable_installment` table with FK to `receivable_item`, index on `item_id`.
- `receivable_allocation` (ADR-204) needs a nullable `installment_id` to target a specific cuota — see ADR-221 (allocation targeting) and ADR-223 (migration risk for existing allocations).
- Non-installment items are entirely unaffected: no schedule rows, same behavior as before this ADR.
- Relates to ADR-204 (base receivables schema this extends), ADR-174 (the analogous but separate transaction-side installment columns), ADR-216 (schedule creation/editing rules), ADR-217 (optional link to a transaction), ADR-221 (allocation/pardon targeting cuotas), ADR-222 (PDF rendering per cuota), ADR-223 (migration and SQLite id-generation risk).

## Status History

- 2026-11-06: accepted
