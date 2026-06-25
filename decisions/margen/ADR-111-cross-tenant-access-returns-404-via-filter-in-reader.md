---
project: margen
adr: 111
title: Cross-tenant access returns 404 via filter-in-reader
category: security
date: 2026-06-25
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-111: Cross-tenant access returns 404 via filter-in-reader

## Context

By-id reads (e.g. `GET /invoices/{id}/document`, `GET /statements/{id}/document`,
single-resource fetches) must not expose another user's row. Two enforcement
strategies exist: filter the query in the reader so the row simply isn't found, or
fetch the row and compare `row.user_id` post-fetch. We must also choose the HTTP
status code for a cross-tenant attempt.

## Decision

Scope by-id reads by **including `user_id` in the lookup query** (filter-in-reader),
so another user's resource id simply isn't found. A cross-tenant access returns
**404 Not Found** (hide existence) rather than 403 Forbidden. No separate post-fetch
ownership check to forget.

## Alternatives Considered

- **Fetch then compare `row.user_id`**: an extra code step after the fetch; easy to
  omit on a new endpoint or return the wrong status code — not chosen.
- **403 Forbidden**: leaks the existence of the foreign resource to the requesting
  user — not chosen.

## Consequences

All by-id reader queries gain a `user_id` predicate as part of the WHERE clause.
Document byte-serving endpoints are ownership-safe by construction. The cross-tenant
contract is: foreign resource id → 404. Isolation tests (ADR-113) must verify this
contract on every relevant router.

Relates to: ADR-108 (explicit `user_id` threading into readers), ADR-107 (ownership
scope), ADR-113 (isolation test strategy verifies 404 contract).

## Status History

- 2026-06-25: accepted
