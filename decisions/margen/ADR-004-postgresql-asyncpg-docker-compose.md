---
project: margen
adr: 004
title: PostgreSQL (asyncpg) as the backend database, Postgres via docker-compose locally
category: data
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-004: PostgreSQL (asyncpg) as the backend database, Postgres via docker-compose locally

## Context

The scaffold supports SQLite (aiosqlite) or PostgreSQL (asyncpg). The readiness probe runs SELECT 1 against the configured engine, so the DB must be reachable locally.

## Decision

Use PostgreSQL with asyncpg (the template default). Run Postgres locally via the generated docker-compose service. Default database_url: `postgresql+asyncpg://margen-api:margen-api@localhost:5432/margen-api`.

## Alternatives Considered

- **SQLite (aiosqlite)**: Lower local friction but diverges from production; production parity was chosen over zero-Docker convenience — not chosen.

## Consequences

Local dev requires Docker running Postgres before `make migrate` and before the readiness probe passes. This dependency must be documented in the README dev steps. See ADR-006 for how the readiness probe is surfaced to the frontend. See ADR-007 for the env var that carries the database_url.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
