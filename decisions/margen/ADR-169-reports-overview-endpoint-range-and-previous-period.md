---
project: margen
adr: 169
title: New GET /reports/overview endpoint returns current and previous window for KPIs, cash-flow, categories, and FX summary
category: architecture
date: 2026-07-02
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-169: New GET /reports/overview endpoint returns current and previous window for KPIs, cash-flow, categories, and FX summary

## Context

ADR-163's composition strategy dispatched four independent queries from the frontend to existing readers. The redesigned page (ADR-167) requires range-scoped data and "vs previous period" deltas across every panel. Computing deltas client-side would require the frontend to fetch two sets of data from multiple endpoints, correlate them, and handle partial failures gracefully — a significant coordination burden.

The budgets and summaries readers (ADR-042, ADR-125) are month-scoped and do not support arbitrary date ranges or previous-period comparison. A new endpoint that owns the range logic and returns both windows in one response is the cleanest path; it also preserves the "one aggregation per metric" principle by routing through the existing month-category aggregation rather than reimplementing it.

Owner scoping follows ADR-108/ADR-130: the endpoint filters by `user_id` derived from the JWT (ADR-092) without exposing a user param.

## Decision

Add `GET /api/v1/reports/overview` with the following contract.

**Query parameters:**

| Param | Values | Default |
|-------|--------|---------|
| `range` | `3M`, `6M`, `12M`, `YTD` | `6M` |
| `currency` | `ARS`, `USD` | user preference (ADR-053/ADR-151) |

**Response shape (both `current` and `previous` windows are returned):**

```json
{
  "range": "6M",
  "currency": "USD",
  "current": {
    "from": "2026-01-01",
    "to": "2026-06-30",
    "kpis": {
      "income": 4200.00,
      "expenses": 1800.00,
      "net_saved": 2400.00,
      "savings_rate": 0.571
    },
    "cash_flow": [
      { "month": "2026-01", "income": 700.00, "expenses": 310.00 },
      ...
    ],
    "categories": [
      {
        "category": "food",
        "total": 420.00,
        "vs_previous_pct": -0.05,
        "monthly_series": [
          { "month": "2026-01", "amount": 65.00 },
          ...
        ]
      },
      ...
    ],
    "fx_summary": {
      "avg_mep_captured": 1245.50,
      "usd_invoiced": 4200.00,
      "monthly_rate_series": [
        { "month": "2026-01", "avg_rate": 1198.00 },
        ...
      ]
    },
    "unconverted_count": 3,
    "unconverted_amount_ars": 15000.00
  },
  "previous": {
    "from": "2025-07-01",
    "to": "2025-12-31",
    "kpis": { ... },
    "cash_flow": [ ... ],
    "categories": [ ... ],
    "fx_summary": { ... },
    "unconverted_count": 1,
    "unconverted_amount_ars": 4500.00
  }
}
```

**Implementation notes:**

- The endpoint resolves the two date windows from `range` (current ends today; `YTD` starts Jan 1 of the current year).
- Category totals and per-month series are computed by re-using the existing month-category aggregation SQL (the same query layer used by the summaries reader — ADR-042) applied over the resolved date range, not duplicating its logic.
- `vs_previous_pct` on each category is computed server-side to avoid floating-point surprises on the client.
- `fx_summary` is derived from `fx_rate` on income transactions in the window (where `fx_source` is not null). It does not call any external FX API — it reads only stored snapshot values (ADR-148).
- The endpoint is owner-scoped (ADR-108/ADR-130) and protected by JWT bearer auth (ADR-064/ADR-092).
- The Monotributo trajectory panel is **not** in this endpoint — it is served by the existing Monotributo reader (ADR-046/ADR-047); see ADR-170.

## Alternatives Considered

- **Retain ADR-163 multi-reader fan-out, extend each reader for range**: Each existing reader gains a `from_date`/`to_date` param — avoids a new endpoint but requires coordinated changes to three separate readers, each of which must also produce a "previous period" result, and the client must correlate; rejected.
- **Separate endpoints per panel (`/reports/kpis`, `/reports/categories`, `/reports/fx`)**: Granular and cacheable independently — adds three new endpoints and forces the client to manage five parallel inflight requests plus delta computation; the panel data is highly correlated (all share the same date windows) so granularity adds complexity without benefit at current scale; rejected.
- **GraphQL or batched query**: Allows the client to request exactly the fields it needs — introduces a new query layer not present anywhere else in the stack; rejected.

## Consequences

- A single cache key (`range` + `currency`) covers the entire page; Tanstack Query invalidates all panels together on navigation, which is semantically correct.
- The backend bears the cost of two window computations per request. At personal-finance data volumes this is negligible.
- The `previous` window enables delta badges without additional round trips.
- Adding a new panel to the page in a future slice may require extending the response shape — this is a backwards-compatible addition (new fields).
- The CSV export endpoints (ADR-165) are separate and unaffected; their `from_date`/`to_date` params can be pre-populated from the range picker client-side.
- Relates to ADR-042 (month-category aggregation reused), ADR-046/ADR-047 (Monotributo reader — separate, not bundled here), ADR-064/ADR-092 (JWT auth), ADR-108/ADR-130 (ownership scoping), ADR-148 (FX snapshot used for fx_summary), ADR-165 (CSV export — separate), ADR-167 (reports redesign that motivates this endpoint), ADR-168 (currency denomination logic implemented here), ADR-170 (Monotributo trajectory panel, served separately).

## Status History

- 2026-07-02: accepted
