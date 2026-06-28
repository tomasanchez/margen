---
project: margen
adr: 125
title: Budgets: per-category monthly targets on the month-navigator period
category: architecture
date: 2026-06-27
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-125: Budgets: per-category monthly targets on the month-navigator period

## Context

A PFM needs budgets vs actuals. The existing category summaries reader (ADR-042) already provides actuals per category per month. The bounded month navigator (ADR-040, ADR-041) defines the active period. A budget model must align with these existing primitives to avoid a parallel period concept.

## Decision

A budget is a per-category target amount per calendar month, aligned to the existing month navigator period. No rollover between months.

Budget row schema: `(id, user_id, category, period_month, amount, currency)`.

Actuals are derived from the existing `CategorySummary` reader (ADR-042) — no duplication of aggregation logic.

## Alternatives Considered

- **Rollover / envelope budgeting**: Carries per-period state and running balances across months — different mental model, deferred as a later enhancement — rejected for MVP.
- **Zero-based allocation**: Requires allocating total income across all categories upfront — different UX and mental model — rejected.
- **Custom budget periods**: Diverges from the month navigator; creates a parallel period concept and UI complexity — rejected.

## Consequences

- New `budgets` table + budget repository + read model (budget vs actuals per category/month).
- Progress UI on the Home page (budget card) and a dedicated Budgets page.
- i18n keys required for budget surfaces (ADR-100/101).
- Rollover and envelope approaches remain possible future enhancements without schema rework.
- User_id ownership per ADR-131.

## Status History

- 2026-06-27: proposed
- 2026-06-27: accepted
