---
project: margen
adr: 109
title: Backfill existing rows to the owner via a one-off script; then tighten user_id to NOT NULL
category: data
date: 2026-06-25
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-109: Backfill existing rows to the owner via a one-off script; then tighten user_id to NOT NULL

## Context

Existing rows across `transactions`, `app_settings`, `invoice_document`,
`statement_document`, and `monotributo_snapshot` have `user_id = NULL` (ADR-094).
They must be assigned to the owner's Supabase account before application-layer
scoping hides them and before a `NOT NULL` constraint can be enforced. The owner id
is install-specific and cannot be embedded in a migration that runs in every
environment.

## Decision

Backfill via a **one-off script** (sibling to `migrate_to_supabase.sh` /
`sync_from_supabase.sh`) that accepts the owner's Supabase `user_id` as a CLI
argument and sets `user_id` on all existing NULL rows across the owned tables. The
owner id is provided at execution time — it is NOT hardcoded.

Rollout order:

1. **Run backfill** against production to assign all existing rows.
2. **Deploy enforcement** (app-layer inserts set `user_id`; reads filter by it — ADR-108).
3. **Tighten**: add an Alembic migration to set `user_id NOT NULL` once no NULLs remain.

Per ADR-094, no foreign key to `auth.users` is introduced — the column stays a plain
non-null UUID, preserving SQLite e2e compatibility and avoiding coupling to Supabase's
managed schema.

## Alternatives Considered

- **Alembic data migration for the backfill**: would hardcode the install-specific
  owner id into a migration that runs in CI and other environments — not chosen.
- **FK to `auth.users`**: Postgres-only; breaks SQLite e2e; couples to Supabase's
  managed schema — ADR-094 explicitly rejected this.
- **Keep `user_id` nullable indefinitely**: a missed insert would create an owner-less,
  globally-visible row — a permanent footgun — not chosen.

## Consequences

A new backfill shell script is added alongside existing data migration scripts. A
subsequent Alembic migration enforces `NOT NULL` on `user_id` across owned tables
(run only after the backfill completes). There is a brief operational window between
backfill and NOT NULL tightening during which a missed insert could create a NULL row;
the enforcement deploy (ADR-108) must land before the NOT NULL migration runs.

Relates to: ADR-094 (nullable `user_id` columns; no FK rationale), ADR-107 (ownership
scope this backfill enables), ADR-108 (app-layer enforcement deployed between backfill
and NOT NULL tightening).

## Status History

- 2026-06-25: accepted
