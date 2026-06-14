---
project: margen
adr: 043
title: Home spending trend and category breakdown consume /summaries
category: architecture
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-043: Home spending trend and category breakdown consume /summaries

## Context

ADR-035 left the Home spending trend and "Where it went" category breakdown panels on mock data. ADR-042 introduces `GET /api/v1/summaries`, and ADR-040/041 establish the shared viewing-month state. Issue #6 (frontend slice, folded into PR #14/#17) switches these two panels from mock to real, reacting to the month navigator.

## Decision

Add a frontend summaries API client module and a TanStack Query hook `useSummaries(viewingMonth)` that calls `GET /api/v1/summaries?month=YYYY-MM` for the selected viewing month, unwraps the `{data}` envelope, parses Decimal strings to numbers, and adapts the response to the existing `TrendPoint[]` / `CategorySpend[]` shapes so `SpendingTrend` and `CategoryBreakdown` render without modification.

`HomePage` replaces the mock `useTrend` / `useCategoryBreakdown` hooks with `useSummaries`; loading states use the existing skeleton components; errors show the existing calm unavailable state (ADR-037). The mock trend and category-breakdown seed data and their hook stubs are removed.

Insights and the Monotributo card remain on mock data — Insights is deferred to a later issue; the Monotributo calculation is issue #8.

## Alternatives Considered

- **Keep deriving trend and categories on the client from raw transactions**: ADR-042 chose server-side aggregation; the client simply consumes the result. Client-side derivation is retained as a theoretical fallback but is not pursued — not chosen.

## Consequences

The spending trend and category breakdown panels are real and fully month-reactive via the viewing-month context (ADR-040/041). One additional TanStack Query call is made per month change; it shares the same calm-error / skeleton loading pattern as the transactions query (ADR-037). The mock layer shrinks further — only Insights and Monotributo remain mock (ADR-035 note updated). Relates to ADR-033 (frontend API client conventions), ADR-037 (error/loading UX), ADR-040/041 (month navigator and viewing-month state), and ADR-042 (the endpoint being consumed).

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
