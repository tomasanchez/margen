---
project: margen
adr: 49
title: "Wire the Monotributo page and Home card to the real endpoint with a compact category selector and calm states"
category: ux
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-049: Wire the Monotributo page and Home card to the real endpoint with a compact category selector and calm states

## Context

The Monotributo page (MeterHero, CategoryLadder, ProjectionBreakdown, InvoiceDrilldown, ScaleTable) and the Home MonotributoCard are fully built but fed by mock data from `src/mock/seed.ts`. They must consume the real endpoint without a redesign, mirroring the summariesClient/useSummary wiring established in ADR-033 and ADR-043. ADR-037 defines calm loading, error, and unavailable states. ADR-040 established that the Home month navigator is scoped to Home; the Monotributo page shows the trailing-12-month standing independently. The interface remains English-only throughout.

## Decision

Add **`src/api/monotributoClient.ts`** (fetch `GET /api/v1/monotributo`, unwrap `{data}`, parse Decimal strings to numbers, adapt DTO to the existing Monotributo TypeScript types) and a **PATCH** call to update the category, mirroring the pattern from ADR-033.

Replace the mock-backed hooks in `src/features/monotributo/queries.ts` and the `useMonotributo` standing used by Home with real **TanStack Query** hooks (invalidate the standing query on a successful category change).

Add a **compact, accessible category selector** on the Monotributo page. Reflect status using the existing `StatusPill`. Show:

- `currentCategory`, `limit`, `used`, `remaining`, `percentUsed`, `status`.
- `projectedCategory` with an explicit **"estimate, assumes steady pace"** note per ADR-046.
- The invoice drilldown listing only included invoices.

Apply calm loading, error, and unavailable states from ADR-037. The page does **not** consume the Home month navigator (ADR-040) — it always shows the trailing-12-month standing.

## Alternatives Considered

- **Redesign the Monotributo screens**: the concept-driven UI is complete; only the data source changes.
- **Keep the Home card on mock data**: Home must reflect the same real standing for trust and consistency; diverging sources would undermine confidence.

## Consequences

The Monotributo page and Home card show real, consistent figures. The mock Monotributo seed/store entries for Monotributo data are removed (keeping any still-mock seams for unrelated features). A minimal category control ships now; a richer settings surface arrives with issue #10. The frontend test suite (ADR-050) mocks `monotributoClient` following the pattern from ADR-038.

## Status History

- 2026-06-14: accepted

## Notes

- 2026-06-14: The Monotributo page gains a "Compare to previous period" toggle showing the current vs prior trailing-12-month standing side-by-side with deltas, and a calm "no prior period yet" empty state when no snapshot exists. The `previous` field comes from the revised GET endpoint. See ADR-052.
