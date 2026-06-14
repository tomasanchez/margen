---
project: margen
adr: 036
title: Mutations — invalidate-on-success with surfaced errors
category: architecture
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-036: Mutations — invalidate-on-success with surfaced errors

## Context

Create, update, and delete mutations must keep Home and Transactions consistent after a change and handle save/delete failures gracefully. These are explicit acceptance criteria for #14. TanStack Query is already the data layer (ADR-005).

## Decision

On a successful mutation, invalidate the `transactions` query so both Home and Transactions refetch — matching the prototype's behavior and ensuring derived totals stay in sync. On failure, surface a calm error message (inline or snackbar) without losing form or UI state. No optimistic cache updates for the MVP swap; correctness and simplicity are preferred.

## Alternatives Considered

- **Optimistic cache updates with rollback**: Snappier perceived performance but meaningfully more complex; correctness risk during the data-source swap. Deferred past this issue — not chosen.

## Consequences

Predictable, refetch-driven consistency across Home and Transactions after every mutation. Failures are visible and recoverable without data loss. A small added latency after mutations (one refetch round-trip) is acceptable for MVP. See ADR-037 for the error/loading UX that complements this.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
