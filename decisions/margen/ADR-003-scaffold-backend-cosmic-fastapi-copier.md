---
project: margen
adr: 003
title: Scaffold backend from cosmic-fastapi Copier template (gh ref), clean slice
category: architecture
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-003: Scaffold backend from cosmic-fastapi Copier template (gh ref), clean slice

## Context

cosmic-fastapi is the user's own Copier template (FastAPI, Pydantic 2, SQLAlchemy 2, Alembic, uv, Ruff, Pyrefly, pytest; Cosmic Python domain-first). It is generated, not hand-copied. The foundation should not ship domain features.

## Decision

Generate apps/api via `uvx copier copy gh:tomasanchez/cosmic-fastapi apps/api` with include_user_example=false. Copier identity: project_name='Margen API', project_slug='margen-api', package_name='margen_api', description='Margen backend API', author_name='Tomas Sanchez', author_email='tomas.sanchez@wheels.com', github_owner='tomasanchez', license=MIT, python_version=3.13.

## Alternatives Considered

- **Scaffold from local path F:\dev\cosmic-fastapi**: Uses uncommitted local WIP; less reproducible and machine-tied. The gh ref pins a committed state and keeps `copier update` clean — not chosen.
- **include_user_example=true**: Generates a Users domain slice (model/routes/migration/tests) that conflicts with the no-domain non-goals of ADR-001 and would be deleted before real work — not chosen.

## Consequences

Health endpoints /monitor/liveness and /monitor/readiness exist independently of the example, satisfying connectivity criteria. The generated project brings its own README, Dockerfile, docker-compose, Makefile, CI workflows, migrations, and tests. `copier update` can pull future template improvements. See ADR-006 for how the readiness endpoint is used for frontend connectivity.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
