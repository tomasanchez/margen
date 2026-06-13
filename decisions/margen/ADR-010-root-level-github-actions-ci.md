---
project: margen
adr: 010
title: Root-level GitHub Actions CI covering both apps
category: testing
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-010: Root-level GitHub Actions CI covering both apps

## Context

GitHub Actions only runs workflows from the repository-root `.github/workflows/`. The backend scaffold (cosmic-fastapi) shipped a workflow nested at `apps/api/.github/workflows/build.yml`, which GitHub ignores in a monorepo, and the frontend had no CI. A single source of truth was needed so both apps are validated on every push/PR.

## Decision

Add one root workflow `.github/workflows/ci.yml` with three jobs: (1) **backend** — runs in `apps/api` via `setup-uv`, executing `make dev/lint/adr-check/cover` (100% coverage gate) and a docker build of `apps/api`; (2) **backend-integration** — spins up a pgvector/pg17 Postgres service, applies Alembic migrations, and runs `make integration` (the PostgreSQL integration tier); (3) **frontend** — runs in `apps/web` via `setup-node 22` with npm cache, executing `npm ci`, `npm run lint`, `npm run build`, and `npm test` (Vitest). Triggers: push to `main` and pull_request to any branch. The redundant nested `apps/api/.github/workflows/build.yml` was removed, its logic preserved at root.

## Alternatives Considered

- **Keep the backend workflow nested under apps/api**: GitHub does not discover workflows outside the repo-root `.github/workflows/`, so it would never run — not chosen.
- **Separate workflow files per app**: More files to maintain; a single `ci.yml` with scoped jobs is simpler for a two-app foundation and keeps triggers consistent — not chosen.
- **Path-filtered jobs (only run the changed app)**: Premature optimization for a small foundation repo; running both jobs always is simpler and safe. Can be added later — not chosen.

## Consequences

Every push/PR validates both apps from a single workflow. Backend enforces the 100% coverage gate plus a real-Postgres integration tier; frontend enforces lint, type-check/build, and unit tests. CI lives at the monorepo root, decoupled from the backend template's internal CI. Both jobs run unconditionally, so CI cost scales with PR volume until path filters are introduced. See ADR-002 for the monorepo layout this workflow targets, and ADR-008 for the testing scope each job enforces.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
