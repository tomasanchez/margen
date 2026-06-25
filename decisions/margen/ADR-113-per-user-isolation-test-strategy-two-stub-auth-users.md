---
project: margen
adr: 113
title: Per-user isolation test strategy: two stub auth users
category: testing
date: 2026-06-25
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-113: Per-user isolation test strategy: two stub auth users

## Context

The hermetic e2e tier overrides auth to a single stub user and the 100 % coverage gate
runs on in-memory SQLite (ADR-032/098). Ownership enforcement (ADR-107/108) introduces
security-critical branches — cross-tenant 404, get-or-create default settings,
capture-owner attribution — that must be proven end-to-end without breaking the
existing hermetic setup.

## Decision

Extend the e2e auth override fixture to **switch between two stub users (A and B)**.
Add isolation tests asserting:

- User B cannot read or mutate User A's transactions, settings, or documents
  (foreign resource id → 404, per ADR-111).
- Each user's list/collection reads return only their own rows.

Keep the hermetic SQLite tier and the 100 % unit + e2e coverage gate. Every new
ownership branch (foreign-id 404, get-or-create default settings, capture-owner
attribution) gets an explicit test case.

## Alternatives Considered

- **Single stub user + unit checks only**: weaker end-to-end guarantee for a security
  invariant; a missed `user_id` predicate in a reader would go undetected at the
  integration boundary — not chosen.

## Consequences

The conftest auth-override fixture becomes parametrizable by stub user id. New
isolation tests are added across the gated routers (transactions, settings, invoices,
statements, monotributo). The 100 % coverage gate continues to apply; the new
ownership branches must be covered.

Relates to: ADR-032 (backend test strategy; hermetic SQLite tier), ADR-098 (auth
dependency override mechanism extended here), ADR-108 (explicit `user_id` params that
make unit-level tests straightforward), ADR-111 (404 cross-tenant contract verified by
these tests), ADR-107 (ownership invariant this strategy defends).

## Status History

- 2026-06-25: accepted
