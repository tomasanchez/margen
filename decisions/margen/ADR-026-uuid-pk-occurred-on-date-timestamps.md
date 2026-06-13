---
project: margen
adr: 026
title: Identifiers and time — UUID primary key, real occurred-on date, timestamps
category: data
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-026: Identifiers and time — UUID primary key, real occurred-on date, timestamps

## Context

The prototype mock uses an `int` id and a display date string plus a `month` enum. The durable model needs stable identifiers that are safe to expose in URLs, real sortable dates for range queries and the summaries engine (#6), and audit timestamps. Relies on PostgreSQL via asyncpg (ADR-004).

## Decision

- **Primary key**: UUID v4 (v7 is acceptable where time-ordering is desired), exposed in the API.
- **Transaction date**: `occurred_on DATE` — a real calendar date, not a display string.
- **Audit timestamps**: `created_at TIMESTAMPTZ` and `updated_at TIMESTAMPTZ`, server-managed (DB default / trigger or ORM `onupdate`).
- The prototype's `dispDate` string and `month` enum are **derived** from `occurred_on` (client-side or as a convenience response field) — not persisted.

## Alternatives Considered

- **BIGINT auto-increment id**: Sequential ids are enumerable and leak row volume in URLs; UUID is safe to expose — not chosen.
- **Keep string `dispDate` + `month` enum**: Not a real date — breaks sorting, range queries, and the summaries engine (#6) that depends on real dates — not chosen.

## Consequences

Stable, non-guessable ids throughout the API. Real `occurred_on` enables date-range filtering (planned for #14), chronological sorting, and the summaries engine (#6). The frontend adapts its `int` id and `dispDate` assumptions when #14 wires to this contract (see ADR-015 for the mock layer being replaced, ADR-024 for the full field mapping).

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
