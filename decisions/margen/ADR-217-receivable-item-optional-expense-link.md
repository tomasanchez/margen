---
project: margen
adr: 217
title: "Optional reference link from receivable_item to a single expense transaction"
category: architecture
date: 2026-11-06
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-217: Optional reference link from receivable_item to a single expense transaction

## Context

The owner often creates a receivable item ("X owes me for the dinner") that corresponds to a real expense transaction already recorded in the ledger. There's currently no way to connect the two for traceability — the owner has to remember or re-derive which expense a debt relates to.

## Decision

Add a nullable `receivable_item.source_transaction_id` FK to `transactions`, `ON DELETE SET NULL`. An application-layer guard enforces that the linked transaction belongs to the same owner and has `kind='expense'` — no DB constraint expresses this, it's validated in the command/service layer. The link applies uniformly to installment and non-installment items. Monthly imported cuota expenses (ADR-175) are not linked individually per cuota — linking happens at the `receivable_item` level only, never per `receivable_installment` row.

## Alternatives Considered

- **Per-cuota link (N links, one per installment, possibly auto-matched)**: overkill — no demonstrated need for linking at that granularity, and auto-matching risks incorrect links — rejected.
- **Many-to-many join table**: a join table is justified when a link needs its own attributes or truly many-to-many semantics beyond a simple pointer; a nullable FK already supports many items linking one expense (ADR-218) without a join table — rejected as overkill for a reference-only pointer.

## Consequences

- Migration adds a nullable FK column + index on `receivable_item`.
- `ON DELETE SET NULL` means deleting the linked expense silently drops the reference, with no cascade and no block — tracked as an accepted risk in ADR-223.
- Owner-match and `kind='expense'` validation live in the application layer, not the database.
- Relates to ADR-204 (base schema this extends), ADR-205/ADR-219 (the link must not create a net-worth/balance path), ADR-214 (installment items are equally eligible to link), ADR-218 (many-to-many cardinality), ADR-220 (UI entry points), ADR-223 (deletion risk).

## Status History

- 2026-11-06: accepted
