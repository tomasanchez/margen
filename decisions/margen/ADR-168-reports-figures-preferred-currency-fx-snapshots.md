---
project: margen
adr: 168
title: Reports figures denominated in preferred display currency via per-transaction FX snapshots
category: data
date: 2026-07-02
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-168: Reports figures denominated in preferred display currency via per-transaction FX snapshots

## Context

The redesigned Reports page (ADR-167) presents KPIs and cash-flow figures that mix USD-denominated income (invoices) with ARS-denominated expenses (credit-card, daily spending). To produce a single coherent number (net saved, savings rate, category total) all transactions must share one denomination.

The money model (ADR-148) attaches a per-transaction FX snapshot (`usd_amount`, `fx_rate`, `fx_source`) to every transaction at capture time. The budgets feature (ADR-152) already exploits this: when `currency=USD` is requested, the budgets reader sums `usd_amount` for USD-denominated lines and returns an `unconverted` count for rows lacking a snapshot. The same approach — preferred currency via FX snapshot, explicit caveat for missing snapshots — is the correct consistency extension for Reports.

The alternative of hardcoding ARS as the reports currency (as the design concept sketched) would break for users whose preferred currency is USD and would ignore the snapshot model already in production.

## Decision

The Reports overview endpoint (ADR-169) accepts a `currency` query parameter (`ARS` or `USD`, defaulting to the user's stored preference — ADR-053/ADR-151).

**Denomination logic (mirrors ADR-152):**

| Requested currency | Value used per transaction |
|--------------------|---------------------------|
| `ARS` | `amount` (native ARS, or ARS equivalent for ARS-native rows) |
| `USD` | `usd_amount` when present; row excluded from totals when absent |

When `currency=USD`, the response includes an `unconverted_count` at the top level (count of transactions where `usd_amount IS NULL`) and a `unconverted_amount_ars` (their combined ARS value), so the frontend can surface a caveat banner identical to the budgets page pattern.

The FX & purchasing-power panel uses the raw `fx_rate` series from the snapshot, not a live rate — this shows the rates actually captured at transaction time (ADR-148/ADR-149), which is the meaningful signal for a freelancer reviewing their effective USD purchasing power over a period.

KPIs and the cash-flow chart are always computed in the single requested denomination; the frontend does **not** do further conversion on top of the backend totals.

## Alternatives Considered

- **Hardcode ARS in the reports endpoint**: Simpler backend — no `currency` param, always sum `amount`. Breaks USD-preferred users; inconsistent with the budgets pattern (ADR-152); rejected.
- **Frontend converts at live rate (like net-worth history — ADR-164)**: Backend returns native amounts, frontend converts using the live MEP rate. Inconsistent with budgets; the live rate applied to historical months misrepresents the purchasing power actually captured; rejected for aggregated cash-flow figures (retained only for the FX rate series itself).
- **Backend stores and uses historical month-end rates**: No historical rate store exists; building one is out of scope; rejected.

## Consequences

- Reports figures are consistent with budgets figures (ADR-152) when both use the same preferred currency — a user reviewing a budget overage can compare it directly with the cash-flow panel using the same denomination.
- Users with mostly ARS transactions and no FX snapshots on income rows will see a large `unconverted_count`; the caveat banner guides them to capture FX at transaction time.
- The `currency` param is the single toggle; there is no mixed-denomination view.
- Relates to ADR-048 (FX snapshot model origin), ADR-148 (per-transaction FX snapshot), ADR-149 (client-side FX capture), ADR-151 (persisted preferred rate source), ADR-152 (budgets preferred currency — pattern reused here), ADR-153 (variable income), ADR-167 (reports redesign), ADR-169 (overview endpoint that implements this logic).

## Status History

- 2026-07-02: accepted
