---
project: margen
adr: 110
title: app_settings becomes per-user (one row per user)
category: data
date: 2026-06-25
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-110: app_settings becomes per-user (one row per user)

## Context

`app_settings` was designed as a single-row table (ADR-054) with `GET /PATCH
/api/v1/settings`. Per-user ownership (ADR-107) requires that each user has their
own settings. The existing single row belongs to the backfill owner (ADR-109).

## Decision

Make `app_settings` per-user:

- Add a **`UNIQUE` constraint on `user_id`** — one row per user, enforced at the DB
  level.
- On first access per user, **lazily get-or-create** a default settings row rather than
  seeding at signup.
- The existing single row is assigned to the backfill owner via ADR-109's script.
- `GET /api/v1/settings` and `PATCH /api/v1/settings` operate exclusively on the
  authenticated user's row.

**This amends ADR-054** (single-row assumption → per-user). An inline note is added
to ADR-054's body; its `status` is not changed.

## Alternatives Considered

- **Eager seed at signup**: requires hooking the auth/login flow; lazy get-or-create
  achieves the same result with no auth-flow coupling — not chosen.

## Consequences

Settings reads must get-or-create rather than assume a row exists. All code relying on
the single-row assumption must be updated. The `UNIQUE(user_id)` constraint is the
DB-level guard against duplicate settings rows per user.

Relates to: ADR-054 (single-row design amended by this ADR), ADR-055 (settings data
migration), ADR-107 (ownership business decision), ADR-109 (backfill that assigns the
existing row to the owner).

## Status History

- 2026-06-25: accepted
