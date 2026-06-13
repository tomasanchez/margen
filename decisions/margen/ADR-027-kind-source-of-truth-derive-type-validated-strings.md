---
project: margen
adr: 027
title: Persist kind as source of truth, derive type; validated-string category and payment method
category: architecture
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-027: Persist kind as source of truth, derive type; validated-string category and payment method

## Context

The prototype stores both `type` (`expense | income`) and `kind` (`expense | income | invoice`), and uses string unions for `category` and `bank`. Storing a redundant `type` column permits contradictory rows without extra validation. Category management is owned by issue #6, so introducing a lookup table/FK now would be premature.

## Decision

- **Persist `kind`** (`expense | income | invoice`) as the source of truth.
- **Derive `type`** in the domain and response layer: `type = expense` if `kind = expense`, otherwise `type = income`. `type` is never stored.
- **`countsTowardMonotributo`** applies only to `income`/`invoice` rows; it is forced to `false` for `expense` rows (domain invariant).
- **`category` and `bank`/payment-method** are stored as **validated strings** (domain value objects or enums over the known prototype set) directly on the transaction row — no lookup table or FK yet. Missing `category` is allowed (nullable or `'Other'`).

## Alternatives Considered

- **Store both `type` and `kind`**: Permits inconsistent `type`/`kind` states without additional cross-column validation — not chosen.
- **Category/bank lookup tables + FK**: Premature — #6 owns category management; FKs complicate rename/delete-category edge cases — not chosen.

## Consequences

No contradictory `type`/`kind` rows possible. The category set is enforced in the domain layer but tolerant of later renaming; #6 can introduce a managed taxonomy without breaking stored strings. Monotributo counting is safe by construction (ADR-020, ADR-023). `type` is a free derived field in every response with no migration cost.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
