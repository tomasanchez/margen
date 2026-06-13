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

Use **two root-level path-filtered workflows**, one per app, both living in the repo-root `.github/workflows/`:

- **`api.yml`** (`name: API`) — triggers on push to `main` and pull_request to any branch, **filtered to `paths: ['apps/api/**', '.github/workflows/api.yml']`**. Two jobs running in `apps/api`: `build` (setup-uv → `make dev/lint/adr-check/cover` 100% coverage gate → docker build of `apps/api`) and `integration` (pgvector/pg17 Postgres service → Alembic migrations → `make integration`).
- **`web.yml`** (`name: Web`) — triggers on push to `main` and pull_request to any branch, **filtered to `paths: ['apps/web/**', '.github/workflows/web.yml']`**. One job `build` running in `apps/web`: setup-node 22 + npm cache → `npm ci`/`lint`/`build`/`test` (Vitest).

The redundant nested `apps/api/.github/workflows/build.yml` was removed, its logic preserved at root.

> **Revised 2026-06-13:** This decision originally specified a single `ci.yml` with no path filters (both apps validated on every push/PR). It was revised before merge to two path-filtered workflows so the API pipeline runs only on `apps/api` changes and the Web pipeline only on `apps/web` changes, and to rename them "API" / "Web". GitHub Actions `paths:` filters are workflow-level (not per-job), so per-app filtering requires separate workflow files.

## Alternatives Considered

- **Keep the backend workflow nested under apps/api**: GitHub does not discover workflows outside the repo-root `.github/workflows/`, so it would never run — not chosen.
- **Single `ci.yml` with all jobs, no path filters**: Simpler file count, but runs the Web pipeline on API-only changes and vice versa, wasting CI minutes — superseded by the per-app split.
- **One workflow with a `dorny/paths-filter` change-detection job gating conditional jobs**: Achieves per-app filtering in a single file, but adds a third-party action and conditional complexity; two small workflow files are clearer — not chosen.

## Consequences

Each app's pipeline runs only when its own files (or its workflow file) change, so API and Web CI are independent and cheaper. API enforces the 100% coverage gate plus a real-Postgres integration tier; Web enforces lint, type-check/build, and unit tests. CI lives at the monorepo root, decoupled from the backend template's internal CI. **Caveat:** if these workflows are later made *required* status checks for merging, a path-filtered workflow that is *skipped* reports no status and can block a PR — branch protection must treat skipped checks as passing (or a passthrough job must be added). See ADR-002 for the monorepo layout this targets, and ADR-008 for the testing scope each enforces.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
- 2026-06-13: revised — split single `ci.yml` into path-filtered `api.yml` + `web.yml`, renamed API/Web
