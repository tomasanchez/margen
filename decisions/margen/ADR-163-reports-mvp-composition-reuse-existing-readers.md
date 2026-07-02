---
project: margen
adr: 163
title: Reports MVP composition — reuse existing readers, add net-worth history and CSV export
category: architecture
date: 2026-07-02
status: superseded
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-163: Reports MVP composition — reuse existing readers, add net-worth history and CSV export

## Context

ADR-128 defines the Reports scope: month-over-month comparison, category breakdown, net-worth-over-time, and CSV export. The project already has three production readers that cover most of this scope:

- The summaries reader (ADR-042) returns a 6-month spending trend and per-category breakdown with month-over-month `delta_pct`.
- The budgets reader (ADR-125) returns budget target-vs-actual per category per month.
- The account-balance reader (ADR-122/ADR-123) returns a current net-worth snapshot across all accounts.

The only metric not yet available is a **monthly net-worth history series** — the balance trajectory over time rather than a single current snapshot.

A naive implementation could add a new aggregator endpoint that re-derives spending, categories, and balances from scratch. This would duplicate the logic in the three existing readers, create divergence risks, and violate the "one aggregation" spirit established in ADR-042 and ADR-125.

## Decision

The Reports page is composed by calling the **existing readers directly** from the frontend:

1. `GET /api/v1/summaries?month=YYYY-MM` — spending trend and category breakdown (ADR-042).
2. `GET /api/v1/budgets?month=YYYY-MM` — budget target-vs-actual (ADR-125).
3. `GET /api/v1/accounts` (balance reader) — current net-worth snapshot (ADR-122/ADR-123).
4. `GET /api/v1/reports/net-worth-history` — **new endpoint**; monthly net-worth series (see ADR-164).

CSV export is delivered via two new endpoints (see ADR-165):

- `GET /api/v1/reports/export/transactions`
- `GET /api/v1/reports/export/summary`

No new aggregator endpoint is added. The frontend composes the view from the four queries above.

## Alternatives Considered

- **Single aggregator endpoint (`GET /reports/full`)**: Returns all report data in one call — simplifies the client fetch but requires the backend to replicate the summaries, budgets, and net-worth aggregation logic, introducing a second source of truth for each metric; rejected.
- **New per-metric read models duplicating existing queries**: Separate report-flavored readers for spending and budgets, isolated from ADR-042/ADR-125 — creates divergence risk whenever the canonical readers change; rejected.

## Consequences

- The Reports page makes up to four parallel queries; Tanstack Query caches each independently.
- Each metric's source of truth remains in its canonical reader — no aggregation duplication.
- The only net-new backend work for reports data is the net-worth-history endpoint (ADR-164) and the CSV export endpoints (ADR-165).
- Changes to the summaries, budgets, or account-balance readers automatically flow through to the Reports page without coordination.
- Relates to ADR-042 (summaries reader), ADR-122/ADR-123 (account/net-worth model), ADR-125 (budgets reader), ADR-128 (reports scope), ADR-164 (net-worth history endpoint), ADR-165 (CSV export endpoints).

## Status History

- 2026-07-02: accepted
- 2026-07-02: superseded by ADR-167
