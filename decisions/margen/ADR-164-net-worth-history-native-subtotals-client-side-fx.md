---
project: margen
adr: 164
title: Net-worth history returns native currency subtotals; frontend converts at live MEP rate
category: data
date: 2026-07-02
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-164: Net-worth history returns native currency subtotals; frontend converts at live MEP rate

## Context

The Reports page (ADR-163) requires a monthly net-worth history series so users can see their balance trajectory over time. The current net-worth snapshot (ADR-122/ADR-123) is a point-in-time sum of account balances. Extending it to a time series raises a fundamental question: should the backend convert multi-currency balances per month using the rate that prevailed at that month-end, or should it return native amounts and let the frontend convert?

A server-side approach would require either storing historical FX rates (no such store exists) or calling an external historical-rate API on the read path. The app's FX principle is client-side (ADR-149): the backend has no FX feed and no server-side rate calls are made on the write path; extending this to the read path is consistent and avoids a new external dependency.

The current net-worth snapshot (ADR-123) already applies the same client-side live MEP rate to mixed-currency balances. The history series should be consistent with the snapshot so a user's "current" data point in the history matches the snapshot card.

## Decision

The new endpoint `GET /api/v1/reports/net-worth-history` returns, per calendar month (month-end, covering the last N months), the **cumulative native balance per currency**:

```json
{
  "months": [
    { "month": "2026-01", "ars_total": 1234567.89, "usd_total": 450.00 },
    { "month": "2026-02", "ars_total": 1389000.00, "usd_total": 450.00 },
    ...
  ]
}
```

Each entry is computed as: `opening_balance + SUM(transaction deltas up to and including that month)` per account, grouped by `account.currency`, then summed across all accounts with the same currency. The backend performs **no currency conversion**.

The frontend converts each month's `(ars_total, usd_total)` pair to the user's display currency using the **single live MEP rate** it already holds (ADR-044/ADR-151), producing a single net-worth figure per month for the chart.

The endpoint is owner-scoped (user_id filter on accounts, as per ADR-131), returning only the authenticated user's accounts.

## Alternatives Considered

- **Backend converts per month using historical rates**: Requires a historical FX rate store or a per-month external API call on every read — introduces a new server-side external dependency, is inconsistent with the client-side-FX principle (ADR-149), and requires sourcing reliable month-end MEP rates going back potentially years; rejected.
- **Backend uses the current live rate for all historical months**: The backend calls dolarapi to get today's MEP rate and applies it server-side to all months — moves FX logic to the server (breaking ADR-149/ADR-133) and still does not produce historically accurate figures; rejected.
- **Store a net-worth snapshot per month in a separate table**: Pre-materialized via a cron or trigger — adds operational complexity and a new table for a feature that can be derived on-demand at current volume; deferred as a later optimisation only.

## Consequences

- The series reflects **today's MEP rate applied uniformly** across all months. It shows the balance trajectory (are holdings growing or shrinking?) but does not show the effect of historical FX swings. A month where the user held USD that appreciated is not distinguished from a month where they added ARS — this is a known, documented limitation.
- Historical per-month MEP rates are a deferred enhancement; if added later, the endpoint contract can be extended with an optional `?fx_mode=historical` parameter without a breaking change.
- The live-rate conversion on the client keeps the "current" data point in the history series consistent with the net-worth snapshot card (ADR-123), which uses the same live rate.
- Backend work: one new SQL reader (cumulative balance per month per currency per user) — no new external dependency, no new table, no migration.
- Relates to ADR-044 (MEP rate source), ADR-122/ADR-123 (net-worth model and mixed-currency aggregation), ADR-128 (reports scope), ADR-131 (ownership scoping), ADR-149/ADR-151 (client-side FX and preferred rate source), ADR-163 (reports page composition).

## Status History

- 2026-07-02: accepted
