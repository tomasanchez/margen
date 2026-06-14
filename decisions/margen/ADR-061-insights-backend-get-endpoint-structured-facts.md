---
project: margen
adr: 061
title: Insights via a backend GET /api/v1/insights endpoint returning structured facts (frontend formats)
category: architecture
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-061: Insights via a backend GET /api/v1/insights endpoint returning structured facts (frontend formats)

## Context

Summaries and Monotributo are computed server-side via the cosmic read seam (ADR-042/ADR-047); Insights should be consistent and independently testable rather than ad-hoc client-side math. However, money formatting and the preferred display currency (ADR-016/ADR-056) are frontend concerns, so the backend must not return pre-formatted prose.

## Decision

Add `GET /api/v1/insights?month=YYYY-MM` (default: current server month, mirroring summaries) backed by the same layered read seam proven by summaries:

- `AbstractInsightsReader` (port)
- Frozen read models (e.g. `InsightsFacts`)
- `SqlAlchemyInsightsReader` (adapter, mirrors `SqlAlchemySummaryReader`)
- Pure insight-logic layer (mirrors `summaries.py` / `summary_reader.py` / `summary_read_models.py`)
- Registered with DI + router under `/api/v1`

API contract follows established conventions:

- `ResponseModel[T]` envelope (ADR-030)
- camelCase field names
- `Decimal` money fields as strings (ADR-025)

The endpoint returns **structured facts** for each applicable insight, not pre-formatted prose:

```
topCategoryMover: { category, deltaPct, currentTotal, priorTotal } | null
recurringExpenses: { count, total } | null
savings: { amount, isProjected, elapsedFraction } | null
latestUsdInvoice: { usd, arsAmount, rate, rateType, occurredOn } | null
```

The frontend receives these facts and composes calm sentences using its es-AR formatters and the display-currency preference (ADR-016/ADR-056). Monetary aggregation uses the ARS-equivalent `amount` field on transactions, consistent with summaries.

## Alternatives Considered

- **Derive insights client-side from already-fetched data**: The team chose a dedicated server endpoint for consistency with the summaries/monotributo pattern (ADR-042/ADR-047) and to keep aggregation logic backend-testable. Client-side derivation would scatter business logic and make it harder to gate with the 100% coverage requirement.
- **Backend returns pre-formatted text**: Money formatting and the USD display preference live on the frontend (ADR-016/ADR-056). Returning text strings would bypass those formatters, produce inconsistent output, and couple the backend to locale/currency display decisions.

## Consequences

- A new read endpoint that follows the proven cosmic read seam; pure insight logic is fully unit-testable without a database.
- The SQL aggregation gets a Postgres integration test (see ADR-063).
- The frontend swaps the mock `getInsights` for a real `insightsClient` and formats the structured facts (see ADR-062).
- Related: ADR-030 (envelope), ADR-025 (Decimal), ADR-042 (summaries read seam to mirror).

## Status History

- 2026-06-14: accepted
