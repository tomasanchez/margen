---
project: margen
adr: 095
title: Defer Row-Level Security; FastAPI enforces ownership at the application layer
category: security
date: 2026-06-23
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-095: Defer Row-Level Security; FastAPI enforces ownership at the application layer

## Context

Supabase offers Row-Level Security (RLS) on Postgres tables. In the hybrid model
(ADR-091), FastAPI is the only data-access path and connects with a privileged
service-role/DB connection, which bypasses RLS anyway. We must decide whether to
enable RLS now or defer it.

## Decision

Do **not** enable RLS initially. FastAPI remains the single gatekeeper and will enforce
per-user ownership in **application code** once ownership is activated post-migration
(ADR-094). RLS may be revisited if any client ever talks to Supabase Postgres directly.

## Alternatives Considered

- **Enable RLS now**: FastAPI uses a privileged connection that bypasses RLS; enabling
  it adds complexity (policy authoring, testing) without providing any protection given
  that no client has direct DB access — not chosen.

## Consequences

Security depends on the FastAPI auth dependency (ADR-092) plus future application-layer
ownership checks in repositories/readers. RLS is explicitly a revisit point if
direct-to-Postgres clients are ever introduced. Tracked as an open item in ADR-097.

Relates to: ADR-091 (hybrid model; FastAPI is sole data-access path), ADR-092 (auth
dependency enforces identity), ADR-094 (ownership columns; enforcement deferred),
ADR-097 (risks and open items).

## Status History

- 2026-06-23: accepted
