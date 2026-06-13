---
project: margen
adr: 024
title: Transaction backend scope and field mapping from the UI prototype
category: business
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-024: Transaction backend scope and field mapping from the UI prototype

## Context

Issue #3 turns the validated UI-prototype transaction model (`apps/web/src/mock/types.ts`) into a durable backend: persistence + documented CRUD API contract. The prototype was accepted in ADR-015. The goal is MVP language — not full accounting.

## Decision

Implement create/read/update/delete for Transactions in `apps/api` with a persisted model and a documented contract the frontend can swap its mock for (in #14).

Field disposition vs the prototype mock:

- **KEEP**: `name`, `category`, `bank` (as payment-method label), `currency`, `kind`, `amountNum` (ARS-equivalent), `usd`, `rate`, `recurring`
- **ADD**: `notes` (optional), `countsTowardMonotributo` (income/invoice only), `created_at`/`updated_at` timestamps, a real `occurred_on` date
- **DERIVE (do not store)**: `type` (from `kind`) and the prototype's `dispDate`/`month` display fields

Non-goals for this issue: categories/summaries engine (#6), FX trust/display UX (#7), Monotributo calculation (#8), settings (#10), wiring the UI (#14).

## Alternatives Considered

- **Expand into full accounting/double-entry**: Far beyond MVP; the prototype's simple language must be preserved — not chosen.
- **Mirror the mock 1:1 (string `dispDate`/`month`, `int` id, both `type` and `kind`)**: Bakes prototype shortcuts into the durable contract; corrected by storing a real date, UUID, and deriving `type` — not chosen.

## Consequences

The backend contract becomes the source of truth for Home, Transactions, FX, and Monotributo screens. Each downstream issue (#6, #7, #8, #14) builds on this schema. The UI retains its mock (ADR-015) until #14 adapts to the documented contract. See ADR-020 and ADR-023 for Monotributo context that intersects `countsTowardMonotributo`.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
