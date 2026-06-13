---
project: margen
adr: 018
title: Focused interaction tests for the prototype
category: testing
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-018: Focused interaction tests for the prototype

## Context

Per the light-testing pattern (ADR-008), the prototype should prove its key behaviors without heavy e2e infra.

## Decision

Add focused Vitest + Testing Library tests covering: search/filter updates the Transactions list AND the filtered totals; the Add flow toggles required fields when switching Expense vs Invoice/Income; selecting USD shows the FX context line; deleting a row removes it; the filters-no-results empty state renders. Keep the existing connection smoke test.

## Alternatives Considered

- **Smoke tests only**: Would not cover the filter/add/FX behaviors the acceptance criteria call out — not chosen.
- **Full Playwright e2e**: Heavy infra beyond a prototype's scope — not chosen.

## Consequences

Covers the AC-critical interactions. Tests target the mock async layer, so they run fast and offline. Extends the testing baseline from ADR-008 without violating its lightweight scope principle.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
