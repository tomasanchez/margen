---
project: margen
adr: 032
title: Test strategy — fully-mocked unit and route tests, real Postgres integration in CI only
category: testing
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-032: Test strategy — fully-mocked unit and route tests, real Postgres integration in CI only

## Context

The team wants fast, offline, deterministic feedback for #3 and a single real-DB verification in CI. The cosmic template's e2e tier normally runs on in-memory SQLite; the team is deliberately deferring DB-backed e2e. CI runs a Postgres service (ADR-010); the cosmic domain seams (ADR-028) provide testable fakes.

## Decision

Three tiers:

**Fast tiers (no real SQL — form the `make cover` gate):**

1. **Unit tests**: domain object + application handlers exercised with fakes / mocked Unit of Work and repository.
2. **Repository adapter tests**: SQLAlchemy repository adapter tested by mocking `AsyncSession` and asserting the expected statements/execute calls were made — no real DB.
3. **Route tests**: FastAPI endpoints driven with the repository/UoW **mocked**; assert the mock was called with the expected arguments. These are NOT true end-to-end tests — persistence is mocked — accepted as interim.

**Integration tier (`@pytest.mark.integration`, `make integration`):**

- Runs against the real test PostgreSQL in CI only (excluded from the coverage percentage gate).
- Verifies that the SQLAlchemy mappings, Alembic migration, and actual SQL work end-to-end.
- Excluded from local `make cover`.

## Alternatives Considered

- **Template's SQLite-backed e2e in the fast tier**: The team chose no real SQL in fast tiers for now; route tests assert mock calls instead. Revisit DB-backed e2e in a future iteration — not chosen.
- **Skip the Postgres integration tier entirely**: CI Postgres is the only place real persistence is proven; omitting it would leave mapping/migration correctness unverified — not chosen.

## Consequences

Very fast, deterministic, offline unit and route tests. Real-DB correctness depends on the CI integration tier (ADR-010 provides the Postgres service). Adapter line coverage comes from mocked-`AsyncSession` call assertions rather than real SQL — a follow-up should introduce real DB-backed e2e when the team circles back. The cosmic domain model's handler/fake seams (ADR-028) are what make the mocked tiers meaningful.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
