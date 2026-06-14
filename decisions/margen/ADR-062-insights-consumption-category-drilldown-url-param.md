---
project: margen
adr: 062
title: Real Insights consumption + category-to-transactions drilldown via a URL search param
category: ux
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-062: Real Insights consumption + category-to-transactions drilldown via a URL search param

## Context

`src/features/home/Insights.tsx` currently reads from a mock `getInsights` seam (deferred in ADR-035). The CategoryBreakdown rows on the Home screen are not clickable, even though the Transactions screen already supports in-memory category filtering. Issue #6 acceptance criteria require a drilldown from category totals to the transactions that make them up.

## Decision

**Insights wiring:**

Add `src/api/insightsClient.ts` and a `useInsights(viewingMonth)` hook, mirroring `summariesClient` / `useSummary` (ADR-033/ADR-043) with the same calm states pattern (ADR-037). The hook fetches from `GET /api/v1/insights?month=YYYY-MM` (ADR-061) and returns the structured facts. `Insights.tsx` replaces the mock call with `useInsights`, composing the structured facts into calm sentences using the existing es-AR formatters and the display-currency preference (ADR-016/ADR-056). The mock `getInsights` seam, seed data, and demo insights are removed.

**Category drilldown:**

CategoryBreakdown rows become clickable links that navigate to `/transactions?category=<categoryName>`. The Transactions screen reads the optional `category` search param on load and pre-populates the category filter, making category totals directly explainable. The param is a plain URL search param (not router state), keeping the URL shareable and browser-back-friendly. The category name used as the param value matches the value stored on transactions (consistent with ADR-027).

Presentation is English-only; the sorted, scan-friendly layout of the existing prototype is preserved.

## Alternatives Considered

- **In-memory navigation state instead of a URL param**: Navigation state is not shareable and breaks the back button. A URL param decouples the two screens cleanly and makes the drilldown linkable.
- **No drilldown**: The acceptance criteria for #6 explicitly ask for it, and the Transactions screen already has category filtering — wiring it is low-effort.

## Consequences

- Insights and category totals are fully real and explainable; the last mock seam from #6 is removed.
- The Transactions screen gains an optional `?category=` search param that can be linked to from other surfaces in the future.
- Related: ADR-033/ADR-037 (client + calm states pattern), ADR-040/ADR-041 (month navigator drives viewing month), ADR-056 (display-currency formatting), ADR-061 (the endpoint being consumed).

## Status History

- 2026-06-14: accepted
