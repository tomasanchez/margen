---
project: margen
adr: 115
title: Transactions calendar named-range filter + monotributo invoice drill-in window
category: ux
date: 2026-06-27
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-115: Transactions calendar named-range filter + monotributo invoice drill-in window

## Context

The Home Monotributo card's "See the N invoices behind this →" link drilled into `/transactions` with no filter applied (effectively All time), so the drilled-in list did not reconcile with the card's count.

The backend computes the monotributo annual total over a **rolling trailing-12-month window** (`service_layer/monotributo.py::trailing_window` = first day of the month 12 months before today → today; `adapters/queries.py` sums rows where `kind IN (invoice, income)` and `counts_toward_monotributo` is set — see ADR-046). The Transactions month filter (ADR-040) only supported a single specific month or "All time" — no range in between — so it was structurally unable to express the window the card's figure is based on.

## Decision

1. **Named quick-ranges on the Transactions month filter.** The filter gains four named sentinels alongside the existing specific-month picker: **This month · Last 12 months · This year · All time**. "Last 12 months" mirrors `trailing_window` exactly: first day of the month 12 months ago → today, inclusive. The first-load default remains the current month (ADR-040 unchanged — calm, smallest list). "Clear filters" resets to All time (existing behaviour unchanged).

2. **Monotributo invoice drill-in uses Last 12 months.** The Monotributo card's "invoices behind this" link opens `/transactions` filtered to the **Invoices** segment over the **Last 12 months** named range, so the drilled-in list reconciles with the card's count.

3. **Category drilldown window unchanged.** The category drilldown (ADR-062) continues to open at All time (full category history). This differs intentionally from the invoice drill-in's 12-month window because category totals are not bounded by a rolling calculation.

## Alternatives Considered

- **Default to This year / YTD**: A calendar cut does not match the rolling trailing window and produces an empty or sparse list in January (cold-start problem).
- **Keep drill-in at All time**: Over-counts versus the card once any data is older than 12 months; the mismatch grows over time.
- **Default to All time**: Unbounded list growth defeats the calm/smallest-list design goal of ADR-040.

## Consequences

- The Transactions filter model gains range sentinels alongside the specific-month and All-time options; filter logic and the MonthPicker / date-range UI are extended to support them.
- **Amends ADR-040** (month filter scope — default month-only selection is preserved but the filter now also supports named ranges).
- **Extends ADR-062** (URL-param drilldown pattern — a range sentinel is now a valid param value alongside category).
- Residual accepted nuance: the backend counts both `income` and `invoice` kinds (flagged `counts_toward_monotributo`), while the drill-in uses the Invoices segment (invoice-kind only) and the page has no `counts_toward_monotributo` UI control. For users who have monotributo-counting income-kind rows, the drilled-in list is an approximation of the exact set counted by the card. This is accepted for MVP.
- Related: ADR-046 (trailing-12-month backend calculation), ADR-047 (monotributo read endpoint), ADR-049 (card wiring), ADR-062 (drilldown URL param).

## Status History

- 2026-06-27: accepted
