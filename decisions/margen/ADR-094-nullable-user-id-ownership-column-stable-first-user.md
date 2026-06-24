---
project: margen
adr: 094
title: Add nullable user_id ownership column now and reserve a stable first-user id
category: data
date: 2026-06-23
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-094: Add nullable user_id ownership column now and reserve a stable first-user id

## Context

The deferred migration (ADR-090) will re-home existing data under an authenticated
user. Adding forward-compatible schema scaffolding now, at low cost, avoids a larger
and riskier migration later. We need to decide the timing and shape of the ownership
column and how to ensure the backfill is trivial.

## Decision

Add a **nullable `user_id` (owner) column** to domain tables (e.g. `transactions` and
other owned aggregates) via an Alembic migration now, left unused/nullable until the
deferred migration runs.

Additionally, design auth so the eventual owner's `user_id` is known and stable —
seed or deterministically identify the first user at auth go-live so the later backfill
is a trivial `UPDATE … WHERE user_id IS NULL`.

Enforcement of ownership at query time is **not turned on yet** (gate-only auth for
now); the column is forward-compat scaffolding only.

## Alternatives Considered

- **Defer schema entirely**: larger, riskier migration later; nullable columns are cheap
  to add now and carry no runtime cost — not chosen.

## Consequences

An Alembic migration adds nullable owner columns to affected tables. The deferred
migration becomes a backfill + NOT NULL tightening rather than an ALTER TABLE on
potentially large tables. A stable first-user id must be captured and recorded when
auth goes live.

Relates to: ADR-090 (auth business decision; deferred migration), ADR-091 (Supabase
managed Postgres), ADR-095 (RLS deferral; FastAPI enforces ownership at app layer).

## Status History

- 2026-06-23: accepted
