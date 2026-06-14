---
project: margen
adr: 063
title: Test the insights endpoint and drilldown across the tiers
category: testing
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-063: Test the insights endpoint and drilldown across the tiers

## Context

ADR-032 mandates a fully-mocked fast tier (unit + mocked-reader route tests) that must satisfy the `make cover` 100% gate, plus a real-Postgres integration tier for SQL aggregation. ADR-038 establishes that the frontend mocks the HTTP client adapter in Vitest + RTL tests. Both constraints apply to the insights endpoint (ADR-061) and the category drilldown (ADR-062).

## Decision

**Backend — unit tests (pure logic, no I/O):**

- Biggest-mover selection: correct pick, no-prior-month edge case, `None` delta handling.
- Recurring count + total: correct aggregation from the `recurring` flag.
- Projected-vs-actual savings: correct scaling by elapsed fraction for a current month; actual savings for a past month.
- Latest USD invoice selection: correct pick when multiple USD invoices exist; `null` when none.
- Empty month: all four facts return `null` → insights list is empty.

**Backend — mocked-reader route tests (no database):**

- `GET /api/v1/insights` returns 200 with a `{data: ...}` `ResponseModel` envelope (ADR-030).
- Field names are camelCase; monetary fields are Decimal strings (ADR-025).
- Default month resolves to the current server month when the param is omitted.
- Malformed `month` param returns 422.

**Backend — integration test (`@pytest.mark.integration`, real Postgres):**

- Seeds transactions covering recurring expenses, category amounts across two months, and a USD invoice.
- Proves the SQL aggregation produces the correct structured facts over real data.

**Frontend — Vitest + RTL (HTTP client mocked, ADR-038):**

- Each insight type: given mocked structured facts, the rendered calm sentence contains the correctly formatted money / percentage / date.
- Empty month: the calm empty state is shown and no insight sentences are rendered.
- CategoryBreakdown row click: `router.navigate` is called with `/transactions?category=<name>` (or the rendered link href matches).
- Transactions screen with `?category=Food` in the URL: the category filter is pre-populated to "Food" on mount.

Gates: `make cover` = 100% + `make lint` green on the backend; `pnpm lint` + `pnpm test` + `pnpm build` green on the frontend.

## Alternatives Considered

- **Only integration tests**: Breaks the fully-mocked 100% coverage gate (ADR-032). Pure logic tests run in milliseconds and catch edge cases without a database.
- **Skip the integration test**: The insights SQL aggregation joins multiple tables and applies the ARS-equivalent amount logic; a real-Postgres proof is required by ADR-032 for any new SQL read path.

## Consequences

- Confidence that the four insight types are correctly derived, edge cases (empty month, past month, no USD invoice) are handled, and the category drilldown navigates correctly.
- The 100% backend coverage gate and the CI integration stage both hold.
- Related: ADR-032 (test tiers), ADR-038 (frontend mock strategy), ADR-061 (endpoint under test), ADR-062 (drilldown under test).

## Status History

- 2026-06-14: accepted
