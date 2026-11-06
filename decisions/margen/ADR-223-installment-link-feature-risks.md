---
project: margen
adr: 223
title: "Installment + link feature risks: allocation migration, link deletion, SQLite UUIDs, time-dependent outstanding"
category: risks
date: 2026-11-06
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-223: Installment + link feature risks: allocation migration, link deletion, SQLite UUIDs, time-dependent outstanding

## Context

Shipping the receivable installment schedule and optional transaction link (ADR-214/217/221) touches existing data and known project gotchas that need explicit acknowledgment before implementation.

## Decision

Accept and track the following risks and their mitigations:

1. **Migration of existing allocations.** Pre-existing `receivable_item` rows have no schedule, so their existing allocations stay item-level. `receivable_allocation.installment_id` is nullable, and is required (not null) only when the allocation's item has a schedule (i.e. has at least one `receivable_installment` row) — a mixed-mode invariant enforced at the application layer, not a database CHECK (no portable cross-table CHECK is available). No backfill of historical allocations into synthetic cuotas.
2. **Deleting a linked expense never cascades.** `source_transaction_id` is `ON DELETE SET NULL` (ADR-217) — deleting the transaction silently drops the reference on every item that linked it, with no cascade and no block. Accepted because the link is reference-only (ADR-219); no soft-delete/restore UX is planned for this iteration.
3. **SQLite e2e UUID gotcha.** Per the existing margen PDF + UUID learning, Postgres `UUID` server-default PKs don't round-trip under the SQLite e2e test harness — ids for `receivable_installment` (and any other new table introduced here) must be generated client-side, following the established workaround.
4. **Time-dependent outstanding.** The `due_on <= today` filter (ADR-215) makes outstanding a function of wall-clock time — tests must inject an explicit "today" rather than relying on `datetime.now()`, to be deterministic and to exercise due/future boundary cases.

## Alternatives Considered

- **Hard DB CHECK constraint enforcing the installment_id-required-iff-scheduled invariant**: not portably expressible as a single cross-table CHECK across Postgres and SQLite — rejected in favor of an application-layer guard.
- **Cascade delete on `source_transaction_id`**: would destroy real receivable items (actual debt records) just because the owner deleted or edited the originating expense — rejected; `SET NULL` preserves the item and only drops the reference.
- **Backfill existing allocations into synthetic single-cuota schedules**: unnecessary churn on historical data for no behavior change, since non-installment items keep their original item-level behavior — rejected.

## Consequences

- Implementation must add the app-layer mixed-mode invariant check, client-side id generation for `receivable_installment`, and an injectable "today" clock in the outstanding reader.
- Relates to ADR-214 (schema), ADR-215 (time-dependent outstanding formula), ADR-217 (link deletion behavior), ADR-221 (allocation migration), and the project's existing SQLite + UUID gotcha (margen PDF + UUID gotchas).

## Status History

- 2026-11-06: accepted
