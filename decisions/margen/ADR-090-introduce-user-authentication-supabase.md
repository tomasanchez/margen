---
project: margen
adr: 090
title: Introduce user authentication via Supabase
category: business
date: 2026-06-23
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-090: Introduce user authentication via Supabase

## Context

margen has been effectively single-user with no identity model. The only auth in place
is a static bearer token on the M2M capture endpoint (ADR-064). The owner wants real,
user-facing authentication and intends to later migrate existing data to be owned by an
authenticated user, establishing a clear multi-user direction.

## Decision

Adopt user-facing authentication for margen using Supabase as the identity provider.
Auth is introduced now; the bulk migration of existing data under a new authenticated
user is a **deferred** follow-up — explicitly out of scope for this work — but the
design must not block it.

## Alternatives Considered

- **Roll our own auth in FastAPI**: significant security-sensitive surface (password
  hashing, reset flows, OAuth, token rotation) to build and maintain for a small app —
  not chosen.
- **Stay single-user**: owner explicitly wants authentication and a path to per-user
  data ownership — not chosen.

## Consequences

A login experience and protected routes are added to the product. Future features can
assume an authenticated user context. A deferred data-ownership migration becomes the
next planned chunk of work.

Relates to: ADR-064 (existing M2M static-token auth, kept as-is), ADR-091 (architecture
of the hybrid Supabase model), ADR-097 (open items and accepted risks).

## Status History

- 2026-06-23: accepted
