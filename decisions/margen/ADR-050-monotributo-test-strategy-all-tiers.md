---
project: margen
adr: 50
title: "Test the Monotributo feature across the ADR-032 tiers"
category: testing
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-050: Test the Monotributo feature across the ADR-032 tiers

## Context

ADR-032 mandates three tiers: fully-mocked fast tests (unit + route) that must pass the `make cover` 100% gate, and a real-Postgres integration tier run only in CI. The Monotributo feature introduces non-trivial financial business logic (status bands, linear annualization, smallest-category lookup) and a SQL aggregation that filters by `counts_toward_monotributo` and a 12-month window (ADR-027/ADR-031). Both must be validated at the appropriate tier. The frontend follows ADR-038 (mock the HTTP client, not fetch).

## Decision

**Backend — pure-logic unit tests** (`service_layer/test_monotributo.py`):

- Status band boundaries at 70%, 90%, 100%.
- Linear-annualization projection including partial-period (first months, low-data low-confidence path).
- Smallest-category-that-fits lookup across the A–K scale.
- Margin/percent computation.
- Exclusion of expenses and `counts_toward_monotributo=false` invoices.

**Backend — mocked-reader route tests** (HTTP contract):

- `GET /api/v1/monotributo` returns 200 with `{data}` envelope, camelCase keys, Decimal-string money.
- `PATCH` category update round-trip returns updated category.

**Backend — `@pytest.mark.integration`** (real Postgres):

- Trailing-12-month SUM and filter correctness.
- Invoice drilldown selection (only `counts_toward_monotributo=true` income within window).

`make cover` stays at 100% and `make lint` stays green.

**Frontend — Vitest + RTL** (mocking `monotributoClient`):

- Status band rendering at each band.
- Projection estimate note present in the DOM.
- Drilldown lists only included invoices.
- Non-counting and expense transactions excluded from display.
- Category-change triggers refetch/invalidation.
- Calm error and loading states per ADR-037.

`pnpm lint`, `pnpm test`, and `pnpm build` stay green.

## Alternatives Considered

- **Only integration tests**: slow and breaks the fully-mocked 100% cover gate mandated by ADR-032.
- **Skip the integration test**: the trailing-12-month SQL aggregation with `counts_toward_monotributo` filtering is exactly the kind of query that needs real-Postgres proof.

## Consequences

High confidence in the financial math via fast, deterministic pure-logic tests; the SQL aggregation is verified end-to-end. The 100% backend cover gate and the CI integration stage both hold. The frontend test suite mirrors the established mock-HTTP-client pattern from ADR-038.

## Status History

- 2026-06-14: accepted
