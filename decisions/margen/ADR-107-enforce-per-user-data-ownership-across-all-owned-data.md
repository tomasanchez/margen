---
project: margen
adr: 107
title: Enforce per-user data ownership across all owned data
category: business
date: 2026-06-25
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-107: Enforce per-user data ownership across all owned data

## Context

Auth is live (Supabase JWT gates all user-facing routes, ADR-090/092), but data is
owner-less: the nullable `user_id` columns are NULL on every row and no query filters
by user, so ANY authenticated account sees ALL data. This is the deferred follow-up
to ADR-090/094/095. Signups are Google OAuth whitelisted to test users (low current
exposure), but the data must be isolated per user before any further rollout.

## Decision

Scope all owned data to the authenticated user across `transactions`, `app_settings`,
`invoice_document`, `statement_document`, and `monotributo_snapshot`. After this work,
a logged-in user sees and mutates ONLY their own rows. Reference/config data (the AFIP
monotributo scale registry) stays shared and ownerless.

## Alternatives Considered

- **Stay gate-only (auth but no ownership scoping)**: any other authenticated or test
  user would see the owner's financial data; authentication without isolation is not real
  multi-user safety — not chosen.

## Consequences

Every read/write path becomes user-scoped. A backfill assigns existing rows to the
owner. Multi-tenant row isolation is the new invariant the test suite must defend.

Relates to: ADR-090 (auth business decision), ADR-094 (nullable user_id ownership
columns), ADR-095 (app-layer enforcement, no RLS), ADR-097 (auth open items),
ADR-108 (enforcement mechanism), ADR-109 (backfill + NOT NULL tightening),
ADR-110 (app_settings per-user), ADR-111 (cross-tenant 404), ADR-112 (monotributo
scoping), ADR-113 (isolation test strategy), ADR-114 (scope boundaries and risks).

## Status History

- 2026-06-25: accepted
