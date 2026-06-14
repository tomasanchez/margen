---
project: margen
adr: 060
title: Insights are real, calm, derived observations (no dense analytics)
category: business
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-060: Insights are real, calm, derived observations (no dense analytics)

## Context

The Home Insights card is the last mock piece of GitHub issue #6 (replace all mock data with real derived data). ADR-035 explicitly deferred Insights to a later iteration; that deferral is now resolved. The issue requires summaries and insights to derive from persisted transactions, kept scan-friendly and honest — no fake numbers, no pie charts, no dense analytics.

## Decision

Insights become a small set of real, plain-language observations derived from the viewing month's persisted transactions. The viewing month is driven by the Home month navigator (ADR-040/ADR-041).

The four insight types are:

1. **Biggest category mover vs the prior month** — reuses the summaries category delta already computed server-side (ADR-042/ADR-043).
2. **Recurring expenses this month** — count and total, derived from the transaction `recurring` flag.
3. **Projected savings for the current month** — income minus expenses scaled by the fraction of the month elapsed. For a past month, show actual savings instead.
4. **Latest USD invoice this month** — original USD amount, applied rate, rate type, and date.

Each insight renders only when its underlying data exists. When none of the conditions are met (e.g. an empty month), the existing calm empty state (ADR-037) is shown. No fake percentages, no pre-seeded demo insights, no charts.

## Alternatives Considered

- **Keep Insights mock**: It is the last seeded panel; issue #6 explicitly requires all data to be real and derived from persisted transactions.
- **Add charts / advanced analytics**: Out of scope. The UX principle is scan-friendly calm presentation; dense analytics would contradict it and are not part of the acceptance criteria.

## Consequences

- Insights now reflect the real viewing month; sparse months degrade gracefully to fewer or no insights with no error state.
- Defines the four computable fact types, which drive what the insights endpoint must return (see ADR-061 for the architecture).
- The mock `getInsights` seam and seed data are removed once ADR-061/ADR-062 land.

## Status History

- 2026-06-14: accepted
