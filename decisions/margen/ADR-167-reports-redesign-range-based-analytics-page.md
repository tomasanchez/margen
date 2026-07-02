---
project: margen
adr: 167
title: Reports redesigned as a range-based analytics page for freelancers
category: ux
date: 2026-07-02
status: accepted
supersedes: ADR-163
authors: [Tomas Sanchez]
---

# ADR-167: Reports redesigned as a range-based analytics page for freelancers

## Context

ADR-163 defined the Reports page as a single-month view composed from four existing readers (summaries, budgets, account balance, net-worth history). After reviewing the first build the owner found the month-scope too narrow and the composition too generic. A freelancer's financial picture is best understood over a multi-month window: invoicing cadence is irregular, income mixes USD and ARS, and the Monotributo ceiling is a trailing-12-month concern — none of which fit a month-at-a-time lens.

A new design concept reframes the page as a range-based analytics dashboard. The owner reviewed it and chose "data-backed redesign now": adopt the concept layout immediately, build only the panels that the current data model supports, and explicitly defer anything requiring new modeling.

## Decision

The Reports page is redesigned with the following structural changes:

1. **Range picker replaces month navigator.** The user selects a preset window — 3M, 6M, 12M, or YTD — that drives every panel on the page. The previous single-month `?month=YYYY-MM` approach is dropped.

2. **"vs previous period" comparison strip.** For every KPI, the page computes the equivalent value for the immediately preceding window of the same length and shows a delta badge (e.g., selecting 6M shows the current 6M versus the prior 6M).

3. **Page composition (panels built in this slice):**
   - **KPI strip** — income, expenses, net saved, savings rate; all denominated in the preferred display currency (see ADR-168).
   - **Cash-flow chart** — per-month bar/line: income vs expenses over the selected range.
   - **Category trends** — per-category total + sparkline series + vs-previous delta.
   - **Monotributo trajectory** — trailing-12-month invoiced vs current category ceiling (see ADR-170).
   - **FX & purchasing-power panel** — avg captured MEP rate, USD invoiced, monthly rate series.
   - **CSV export** — retained from ADR-165; date params updated to accept the range window.

4. **Panels deferred to a future slice** are documented in ADR-171 with rationale.

5. The composition strategy shifts from "four independent client queries against existing readers" (ADR-163) to a **single `GET /reports/overview` endpoint** that returns all range-scoped data in one response (see ADR-169). ADR-163's multi-reader fan-out is superseded for the overview; the net-worth-history endpoint (ADR-164) and CSV export endpoints (ADR-165) are retained.

## Alternatives Considered

- **Keep the single-month scope, add a "next month" nav**: Minimal change — preserves the existing build but does not address the owner's core objection that month-at-a-time is too granular for freelancer cash-flow review; rejected.
- **Full concept build including deferred panels**: Build getting-paid, inflation-adjusted spending, and PDF export now — the transaction model has no client/payer field and no issued-vs-paid dates; inflation index is a new data source; building these now would require significant new modeling out of scope for this slice; rejected for now, deferred explicitly.

## Consequences

- ADR-163 is superseded. The net-worth-history endpoint (ADR-164) and CSV export (ADR-165) are **retained** but the page composition and navigation model change entirely.
- The range picker becomes a page-level shared-state parameter; all panels subscribe to it. Changes to the selected range re-fetch the overview endpoint.
- "vs previous period" deltas require the backend to compute two windows per request (see ADR-169).
- The FX & purchasing-power panel surfaces the MEP rate series captured at transaction time (ADR-148), giving the owner a record of purchasing-power evolution without requiring a new external data source.
- Relates to ADR-128 (reports scope origin), ADR-148 (per-transaction FX snapshot), ADR-149 (client-side FX), ADR-152 (preferred currency denomination), ADR-163 (superseded), ADR-164 (net-worth history retained), ADR-165 (CSV export retained), ADR-168 (currency denomination), ADR-169 (overview endpoint), ADR-170 (Monotributo trajectory), ADR-171 (deferred panels).

## Status History

- 2026-07-02: accepted
