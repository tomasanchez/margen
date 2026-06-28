---
project: margen
adr: 130
title: New aggregates extend per-user app-layer ownership
category: security
date: 2026-06-27
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-130: New aggregates extend per-user app-layer ownership

## Context

App-layer per-user ownership is the established pattern: cross-tenant by-id access returns 404 (ADR-108, ADR-111), and RLS is deferred (ADR-095). The PFM expansion introduces new aggregates — accounts and budgets — that must follow the same ownership model consistently.

## Decision

`accounts`, `budgets`, and any future PFM aggregates (e.g., goals) carry `user_id NOT NULL`. Every read and write query filters by the authenticated user's ID. Cross-tenant access returns 404 via the reader filter, consistent with ADR-111.

Additionally, `account_id` FK references on transactions are ownership-checked at the application layer: a user may only attach a transaction to an account that they own. Attempting to reference another user's account returns 404 or 403.

## Alternatives Considered

- **RLS enforcement**: Deferred per ADR-095; consistent app-layer enforcement is sufficient and avoids Supabase RLS policy maintenance overhead.

## Consequences

- Consistent ownership model across all new tables; no special-casing needed.
- The accounts migration (ADR-124) backfills `user_id` on seeded accounts from the owning transaction's user.
- Future aggregates must follow this same pattern; ADR-108 is the canonical reference.

## Status History

- 2026-06-27: proposed
- 2026-06-27: accepted
