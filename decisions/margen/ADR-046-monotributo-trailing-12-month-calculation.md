---
project: margen
adr: 46
title: "Monotributo real calculation: trailing-12-month basis, services activity, status bands, projected category"
category: business
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-046: Monotributo real calculation: trailing-12-month basis, services activity, status bands, projected category

## Context

Issue #8 replaces the seeded Monotributo card with a transparent, trustworthy calculation derived from persisted invoice transactions. Argentine Monotributo recategorization evaluates gross income on a trailing annual basis; the user needs early warning before crossing a category ceiling and must be able to trust the figure — which invoices were included, what the limit is, and how the projection was made. The calculation must be transparent, not magical.

ADR-027 and ADR-031 established `counts_toward_monotributo` as the authoritative flag on transactions that determines inclusion. ADR-025 mandates Decimal/NUMERIC for all monetary values.

## Decision

Compute **used** as the SUM of transactions with `kind='invoice'` (or `'income'`) AND `counts_toward_monotributo=true` over the **trailing 12 months ending today** (parameterless; not the calendar year and not tied to the Home month navigator — see ADR-040).

Compare against the user's current category's annual ceiling. Status bands expressed as percentage of ceiling:

| % of ceiling | Status key | Calm copy |
|---|---|---|
| < 70% | `safe` | "On track" |
| 70–90% | `watch` | "Keep an eye on this" |
| 90–100% | `close` | "Close to your limit" |
| > 100% | `over` | "Over your limit" |

Project the category via **linear annualization**: `annualized = used ÷ (fraction of the 12-month period elapsed with data)`. The projected category is the smallest category whose ceiling ≥ annualized. Always label this as an estimate, stating the assumption of steady pace.

Activity type is assumed to be **services** for MVP (display `cuotaServicios`). Goods/bienes activity is deferred.

Derived fields: `remaining = ceiling − used`; `percentUsed = used / ceiling × 100`.

## Alternatives Considered

- **Calendar-year-to-date or monthly period**: diverges from AFIP's trailing-annual recategorization basis; the month navigator (ADR-040) is scoped to the Home dashboard, not Monotributo.
- **Trailing 3-month run-rate projection**: heavier to compute and explain; linear annualization matches the prototype's "steady pace" label and is easy to make transparent.
- **No projection**: drops an acceptance criterion; users want the early-warning estimate.

## Consequences

A real, explainable standing and projection computed from persisted invoices. Expenses and invoices with `counts_toward_monotributo=false` are excluded. The projection is a clearly-labeled estimate — low-confidence when little data exists (early months).

Goods-activity caps/fees and automatic AFIP threshold updates are out of scope (see ADR-051 for scope boundaries). This ADR sets the business rules the backend read endpoint (ADR-047) implements.

## Status History

- 2026-06-14: accepted

## Notes

- 2026-06-14: The GET endpoint now also returns a `previous` field — the prior trailing-12-month window (ending 12 months ago) — for a period-over-period comparison toggle on the Monotributo page. See ADR-052.
