---
project: margen
adr: 023
title: Monotributo page: UI-first with hardcoded AFIP 2026 scale and linear pace projection
category: data
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-023: Monotributo page: UI-first with hardcoded AFIP 2026 scale and linear pace projection

## Context

Issue #8 calls for Monotributo tracking with a limit meter, projection, category scale, and the invoices behind the calculation. The frontend is built first (UI-first, mock data, per ADR-012) so the real backend calculation and persistence can follow with the data shape validated. The page must reuse the existing shell, theme, components, and mock-async/TanStack Query pattern (ADR-015).

## Decision

Build a `/monotributo` page with mock data:

1. **Hardcoded AFIP 2026 scale**: Encode the official AFIP 2026 category scale A–K (annual gross-income ceiling + servicios and bienes cuotas) as reference data in the mock layer. Include an outbound link to the authoritative ARCA (ex-AFIP) table as the source of truth.
2. **Meter hero from existing seed**: Reuse the existing `SEED_MONOTRIBUTO` snapshot (Category C, used ARS 12.713.696 of 21.113.697 = 60%, margin ARS 8.400.001, projected D, Watch) for the limit meter hero component.
3. **Dedicated fiscal-period invoice list**: Provide a dedicated fiscal-period invoice list (7 invoices Jan–Jun 2026, oldest-first with running cumulative) for the drilldown. This list is separate from the recent transactions store — which covers only recent months — so Home/Transactions data is undisturbed. An "Open in Transactions" link routes to `/transactions`.
4. **Simple linear pace projection**: The projection is a simple linear pace estimate (monthly average × 12 → projected annual total → lands-in category), explicitly labeled an estimate, not a guarantee.
5. **Wire the nav placeholder**: Connect the existing "Monotributo" nav entry (sidebar + mobile pill) to the new route (ADR-014, ADR-017).

## Alternatives Considered

- **Derive the drilldown from the shared transactions store**: The store only has recent-month invoices; the annual view needs Jan–Jun, and seeding those into the store would alter the already-reviewed Home/Transactions data — not chosen.
- **Implement real recategorization/threshold logic now**: That is issue #8's backend scope and a non-goal for the UI-first slice (ADR-012) — not chosen.
- **Fetch the live AFIP scale**: No backend exists and this is a non-goal; hardcode the 2026 scale and link to ARCA for the source of truth instead — not chosen.

## Consequences

The page is visually and behaviorally complete on mock data and previews exactly the inputs the real calculation (issue #8) will need: per-category thresholds, the period invoices, and the projection inputs. The hardcoded scale must be refreshed when AFIP revises it (next review ~Jul/Aug 2026) — the ARCA link surfaces the authoritative table. The projection is illustrative only.

Reaffirms ADR-012 (UI-first, no backend) and ADR-020 (hardcoded Monotributo thresholds). Follows the mock-async/TanStack Query data pattern from ADR-015. Responsive layout follows ADR-017.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
