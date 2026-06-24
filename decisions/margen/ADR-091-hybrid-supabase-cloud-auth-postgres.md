---
project: margen
adr: 091
title: Hybrid Supabase Cloud: managed Auth + Postgres, FastAPI retains cosmic-python data ownership
category: architecture
date: 2026-06-23
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-091: Hybrid Supabase Cloud: managed Auth + Postgres, FastAPI retains cosmic-python data ownership

## Context

Supabase bundles Auth (GoTrue/JWT), a managed Postgres, RLS, and auto REST. margen
already has a cosmic-python FastAPI backend that owns all data access against a
self-hosted Postgres (ADR-004). We must decide how much of Supabase replaces the
existing stack vs. augments it.

## Decision

Use **Supabase Cloud** (managed, not self-hosted) for BOTH authentication and the
application's Postgres database, in a **hybrid model**:

- FastAPI keeps the cosmic-python architecture and remains the **sole owner** of domain
  data access (repositories, async UoW, readers).
- SQLAlchemy/asyncpg connects to Supabase's managed Postgres connection string.
- Supabase's managed Postgres **replaces** the self-hosted Docker-Compose Postgres.
- The frontend does **not** talk to Supabase's PostgREST for domain data; it continues
  to talk to FastAPI. It communicates with Supabase only for the auth handshake.

## Alternatives Considered

- **Supabase for Auth only, keep self-hosted Postgres**: owner wants to consolidate onto
  Supabase's managed Postgres and it sets up the deferred data migration — not chosen.
- **Full Supabase (DB + Auth + RLS), frontend uses PostgREST directly**: discards the
  cosmic-python data-ownership investment and scatters business logic into RLS/PostgREST
  — not chosen.
- **Self-hosted Supabase via Docker**: more local ops surface (GoTrue/Kong/Studio);
  managed Cloud is faster to stand up for this scope — not chosen.

## Consequences

Partially supersedes ADR-004's **hosting choice** (managed Cloud Postgres replaces the
Docker-Compose Postgres service) while **retaining** Postgres + asyncpg + Alembic +
SQLAlchemy intact. The docker-compose Postgres service is removed/retired from the dev
stack; connection config now points at Supabase. An external runtime dependency on
Supabase Cloud is introduced (login unavailable if Supabase is unreachable — tracked
in ADR-097).

> **Note added 2026-06-23**: ADR-004's Docker-Compose self-hosted Postgres hosting
> choice is partially superseded by this ADR (ADR-091). PostgreSQL + asyncpg + Alembic
> + SQLAlchemy are retained unchanged.

Relates to: ADR-004 (original Postgres hosting, partially superseded — hosting only),
ADR-090 (auth business decision), ADR-092 (JWT verification in FastAPI), ADR-093
(secret management), ADR-095 (RLS deferral).

## Status History

- 2026-06-23: accepted
