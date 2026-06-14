---
project: margen
adr: 042
title: Backend monthly summaries read endpoint
category: architecture
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-042: Backend monthly summaries read endpoint

## Context

The Home spending trend and category breakdown panels were intentionally left mock in ADR-035 (issue #14 scope boundary). Issue #6 makes them real. The team evaluated where aggregation should live — in the backend (SQL) or on the client after fetching raw transactions — and chose backend aggregation for correctness and scale.

## Decision

Add a query-only endpoint `GET /api/v1/summaries?month=YYYY-MM` (defaults to the current month) returning the standard `ResponseModel {data}` envelope with camelCase fields:

1. `trend` — the 6 calendar months ending at `month`, ordered oldest → newest, each entry: `{month, expenses}` where `expenses` = SUM of the ARS-equivalent amount (`amountNum`) for `kind=expense` in that calendar month. The requested month is flagged `current: true`.
2. `categories` — for the requested `month`, expenses grouped by category: `{category, amount, share (% of the month's total expenses), deltaPct (vs the same category in the prior calendar month, null when prior total is 0)}`, sorted by `amount` descending. Income and invoice kinds are excluded.

Implemented as a cosmic reader port + read models using SQLAlchemy aggregation (`SUM`, `GROUP BY` on `year+month` of `occurred_on`, `GROUP BY category`) over the existing `transactions` table. No new table or migration is required. A new `entrypoint/summaries.py` router is registered in the v1 router.

## Alternatives Considered

- **Client-side derivation from fetched transactions**: The client would fetch all transactions and aggregate locally — fine for tiny data sets but does not scale, duplicates server-side business logic, and pushes ARS-equivalent conversion concerns onto the frontend — not chosen.
- **Precomputed/materialized summary table**: A dedicated summary table (populated by triggers or a background job) is premature at MVP volume; on-the-fly aggregation over the indexed `transactions` table is sufficient and avoids a new migration — not chosen.

## Consequences

Summaries are computed in Postgres on demand and react correctly to any requested month. ARS-equivalent amounts (`amountNum`) are the source of truth — no FX logic required on the frontend. No migration is introduced. If transaction volume grows, an index on `(occurred_on)` and/or `(category)` may be warranted. The endpoint's contract mirrors the `TrendPoint[]` / `CategorySpend[]` shapes expected by the frontend (ADR-043) for a clean drop-in swap. Relates to ADR-028 (cosmic reader pattern), ADR-030 (API contract conventions), ADR-033 (frontend API client that will consume this), and ADR-040/041 (month navigator that drives the selected month).

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
