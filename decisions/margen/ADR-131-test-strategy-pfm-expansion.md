---
project: margen
adr: 131
title: Test strategy for the PFM expansion
category: testing
date: 2026-06-27
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-131: Test strategy for the PFM expansion

## Context

The project maintains a 100% coverage gate enforced across unit and e2e tiers (ADR-019). Prior feature expansions (auth, i18n, per-user ownership) each bundled their test work into the same delivery slice. The PFM expansion adds four new slices: accounts/net worth, budgets, reports/export, and cash-flow forecasting.

## Decision

Each new module is covered at all applicable tiers, bundled into the same delivery slice as the implementation:

- **Unit**: domain model, command handlers, readers, service functions.
- **Integration**: the accounts migration backfill (ADR-124) is tested against real Postgres to verify seed logic, backfill correctness, and NOT NULL enforcement after migration.
- **e2e**: API route tests for accounts, budgets, reports/CSV export, and forecast endpoints.
- **Frontend**: component and interaction tests for accounts/net-worth UI, budget progress surfaces, reports page.
- **i18n**: en-pinned tests updated for all new i18n keys (ADR-105 precedent).

The 100% coverage gate (ADR-019) applies to all new code. No new coverage exceptions.

## Alternatives Considered

- **Defer integration-tier migration tests**: Risk of undetected seed/backfill bugs reaching production — rejected.

## Consequences

- Test work is non-optional and scoped into each delivery slice.
- CI gates are unchanged; new code must pass the existing 100% gate.
- Migration tests require a real Postgres instance in CI (already available per ADR-032).

## Status History

- 2026-06-27: proposed
- 2026-06-27: accepted
