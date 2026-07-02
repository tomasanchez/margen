---
project: margen
adr: 176
title: Forecast engine, GET /forecast contract, committed-vs-discretionary and no-double-count rules
category: architecture
date: 2026-07-02
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-176: Forecast engine, GET /forecast contract, committed-vs-discretionary and no-double-count rules

## Context

ADR-173 established that the forecast is commitment-driven. ADR-174 added the transaction-level fields the engine reads. This ADR defines the engine composition rules, the API contract, and the correctness invariants that prevent double-counting actuals and projections.

## Decision

### Engine composition

The forecast engine is a **pure function**: given a stream of tagged transactions (owner-scoped per ADR-108/ADR-130) and a forward horizon, it returns a per-month series of committed outflows. It has no side effects and no database writes.

Committed streams projected in v1:

| Stream | Source | Projection rule |
|--------|--------|-----------------|
| Recurring subscriptions | `recurring_cadence IN ('monthly','quarterly','annual')` | Latest captured amount, projected at cadence frequency |
| Monotributo cuota | Configured category (ADR-177) | Fixed monthly ARS outflow per scale table |
| Installment tails | `recurring_cadence='installment'` and `installments_index < installments_total` | One more outflow per remaining cuota (`installments_total - installments_index`) |

**No-double-count rule**: for each stream, the projection covers only months **strictly after** the month of that stream's latest actual transaction. Actuals own the past; the projection owns the future. This prevents a month with a real transaction from also appearing as a projected one.

**Confidence tiers** (reuses the monotributo low-confidence idea from ADR-046):

- `committed` — recurring/installment tagged transactions and the monotributo cuota.
- `estimated` — reserved for a future discretionary band; not emitted in v1.

**Denomination** mirrors ADR-168/ADR-152:

- ARS sums use `amount`.
- USD sums use `usd_amount`; rows where `usd_amount IS NULL` are counted as `unconverted` and excluded from USD totals.

### API contract

```
GET /api/v1/reports/forecast?horizon=<N>&currency=<ARS|USD>
```

- `horizon`: integer, number of future months to project (default 3, max 12).
- `currency`: `ARS` or `USD`; defaults to user's stored preferred currency (ADR-053/ADR-151).
- Authentication: owner-scoped bearer token (ADR-064/ADR-092); the engine only sees the authenticated user's transactions.
- Response: `ResponseModel[ForecastOut]` (camelCase, consistent with existing endpoints).

`ForecastOut` shape (indicative):

```json
{
  "months": [
    {
      "month": "2026-08",
      "committed": 120000.00,
      "confidenceTier": "committed",
      "streams": [
        {"label": "Netflix", "amount": 5000.00, "cadence": "monthly"},
        {"label": "Monotributo", "amount": 85000.00, "cadence": "monthly"},
        {"label": "Samsung TV cuota 8/12", "amount": 30000.00, "cadence": "installment"}
      ],
      "unconvertedCount": 0
    }
  ],
  "currency": "ARS",
  "horizon": 3
}
```

### v1 scope boundary

- **No discretionary band** — the `estimated` confidence tier is reserved; not computed in v1.
- **No projected income** — the engine covers outflows only.
- **No live FX in projections** — USD projections use the `usd_amount` snapshot from the latest actual transaction; the engine does not call the FX API.

## Alternatives Considered

- **Include discretionary band in v1**: Requires defining a trailing window and handling overlap with committed streams; deferred — validate committed layer first.
- **Project income streams (invoices)**: Income cadence is irregular for a freelancer; projecting it reliably requires different modeling (client retainer, invoice schedule); deferred.
- **Store projections in a materialized table**: Adds a write path, cache invalidation, and staleness concerns; the engine is fast enough to compute on demand for a 12-month horizon; rejected.
- **Mixed denomination response** (ARS subtotal + USD subtotal in one response): Adds response complexity; the single-currency toggle pattern (ADR-168/ADR-152) is established and consistent; rejected.

## Consequences

- The forecast endpoint is owner-scoped and read-only — no new write paths.
- The no-double-count rule is a hard correctness invariant; tests must cover the boundary month (last actual = projected month must not appear twice).
- When a discretionary band is added, it extends `ForecastOut.months[].estimated` without breaking the existing `committed` field.
- Confidence tiers provide a foundation for future UI differentiation (solid bar for committed, dashed for estimated) consistent with the monotributo low-confidence pattern (ADR-046).
- Relates to ADR-046 (confidence tier concept from monotributo), ADR-053/ADR-151 (preferred currency stored setting), ADR-064/ADR-092 (auth — owner scope), ADR-108/ADR-130 (owner-scoped queries), ADR-148/ADR-149 (FX snapshots — used for USD denomination), ADR-152/ADR-168 (denomination logic reused), ADR-173 (commitment-driven forecast — this ADR implements it), ADR-174 (transaction columns the engine reads), ADR-177 (monotributo cuota as a committed stream).

## Status History

- 2026-07-02: accepted
