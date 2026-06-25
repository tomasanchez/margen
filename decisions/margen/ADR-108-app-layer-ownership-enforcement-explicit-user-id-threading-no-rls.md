---
project: margen
adr: 108
title: App-layer ownership enforcement via explicit user_id threading (no RLS)
category: architecture
date: 2026-06-25
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-108: App-layer ownership enforcement via explicit user_id threading (no RLS)

## Context

Per-user data scoping (ADR-107) requires a concrete enforcement mechanism in the
cosmic-python backend. ADR-095 already chose application-layer enforcement over
Row-Level Security: FastAPI connects with a privileged role that bypasses RLS, and
the SQLite e2e tier has no RLS support. The remaining question is how exactly the
authenticated user id flows from the route boundary through commands and readers down
to repository queries.

## Decision

Enforce ownership in the application layer, reaffirming ADR-095 (no RLS). Thread
the authenticated user id **explicitly**:

- **Writes (commands)**: add `user_id` to command schemas so handlers set it on every
  insert.
- **Reads (readers/repositories)**: add a `user_id` parameter to reader and repository
  method signatures so every query filters by it.

The `user_id` value originates from `require_auth_user`'s `AuthUser.id` at the route
boundary and is passed down as an ordinary function argument. No implicit or
context-scoped magic — explicit parameters keep enforcement unit-testable and hard to
accidentally omit.

## Alternatives Considered

- **Postgres RLS (defense-in-depth)**: the privileged connection bypasses it; no effect
  in SQLite e2e tests; requires extra role/session plumbing — ADR-095 already deferred
  this.
- **UoW/request-context-scoped `user_id`**: implicit thread-local or context-var
  injection; easy to forget a filter and silently leak rows across tenants — not chosen.

## Consequences

Many reader, handler, and command call sites gain a `user_id` parameter. The user id
becomes a first-class, visible parameter on every read and write path touching owned
tables. Enforcement gaps are compile-time / grep-visible rather than policy-hidden.

Relates to: ADR-092 (auth dependency that surfaces `AuthUser.id`), ADR-094 (nullable
`user_id` columns being threaded), ADR-095 (no-RLS decision reaffirmed here),
ADR-107 (ownership business decision), ADR-111 (by-id reads filtered in reader),
ADR-113 (testability — explicit params enable unit-level isolation tests).

## Status History

- 2026-06-25: accepted
