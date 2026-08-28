---
project: margen
adr: 204
title: "Receivables data model: person, receivable_item, receivable_payment, receivable_allocation (ARS, no account link)"
category: data
date: 2026-08-28
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-204: Receivables data model: person, receivable_item, receivable_payment, receivable_allocation (ARS, no account link)

## Context

ADR-203 decided to track people and itemized debts owed to the owner, kept structurally out of net worth (ADR-205). The schema must support: per-person itemized debts with a justification note, partial per-item settlement from one or more incoming payments (ADR-206), and payments sourced either manually or from a matched income transaction (ADR-207) — without ever attaching an `account_id`, which would risk pulling receivables into balance/net-worth aggregation.

## Decision

Four new user-scoped tables (ownership pattern per ADR-108/130), all money columns `NUMERIC`/`Decimal` (ADR-025/034), ARS-only for v1, and **none carrying an `account_id`**:

| Table | Columns | Notes |
|---|---|---|
| `person` | `id` (UUID PK), `user_id` (FK), `name`, `created_at` | one row per debtor |
| `receivable_item` | `id` (UUID PK), `person_id` (FK), `occurred_on` (date), `amount` (Decimal), `detail` (nullable text), `created_at` | one itemized debt; `detail` is the free-text justification |
| `receivable_payment` | `id` (UUID PK), `person_id` (FK), `occurred_on` (date), `amount` (Decimal), `source` (enum `manual` \| `matched_income`), `matched_income_transaction_id` (nullable FK to `transactions`), `created_at` | one incoming payment event |
| `receivable_allocation` | `id` (UUID PK), `payment_id` (FK), `item_id` (FK), `amount` (Decimal) | applies part (or all) of a payment to one item |

An item's outstanding = `amount` − Σ its allocations. A person's outstanding = Σ item remainders across all their items. A migration (Alembic) creates the four tables with FKs and standard indexes on `person_id`/`payment_id`/`item_id`.

## Alternatives Considered

- **Single flat table keyed by a free-text debtor name**: simplest schema, but no stable identity for a person — can't rename/edit consistently, and weakens the fuzzy income-matching and per-person PDF (ADR-207/209), which need a durable `person_id` to key off — rejected.
- **`receivable_payment` references exactly one `receivable_item` (no allocation table)**: simpler, but a single incoming payment (e.g., one Mercado Pago transfer) frequently settles several outstanding items at once; forcing 1:1 would require splitting a real payment into synthetic fragments — rejected in favor of the `receivable_allocation` many-to-one join, mirroring the flexibility (not the exact mechanism) of ADR-159's expense-offset linking.

## Consequences

- Supports partial per-item settlement and one payment paying down many items via `receivable_allocation`.
- Slightly richer schema (four tables instead of one or two) in exchange for correct partial-settlement semantics.
- No `account_id` anywhere in this schema — the structural exclusion from net worth (ADR-205) depends on this.
- Relates to ADR-025/034 (Decimal money convention), ADR-108/130 (user-scoped ownership), ADR-159 (allocation/offset-link precedent), ADR-206 (settlement/overpayment rules built on this schema), ADR-207 (matched-income payment source).

## Status History

- 2026-08-28: accepted
