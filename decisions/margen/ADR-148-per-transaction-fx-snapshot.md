---
project: margen
adr: 148
title: Per-transaction FX snapshot — fx_rate, fx_source, materialized usd_amount
category: data
date: 2026-06-30
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-148: Per-transaction FX snapshot — fx_rate, fx_source, materialized usd_amount

## Context

ADR-025 established that the ARS-equivalent `amount` is the single authoritative monetary figure per transaction, with `usd_amount` and `fx_rate` as nullable companions. Under that model, reconstructing USD spend for a historical or backdated period requires dividing `amount` by whatever rate was in effect at that time — but no per-row rate was reliably captured, making the derivation lossy. The owner's income is USD-denominated, and the PFM repositioning (ADR-119) targets USD-native budgets; accurate historical USD spend sums are therefore a first-class requirement. Summing `amount ÷ some_rate` at read time is both expensive and inaccurate when the rate has drifted or was backdated.

## Decision

Every transaction stores a complete FX snapshot composed of three fields:

- `fx_rate` (`NUMERIC(18,6)`, nullable) — ARS per 1 USD, the rate that was in effect when the transaction was recorded or backfilled.
- `fx_source` (`VARCHAR(20)`, nullable) — provenance of the rate, e.g. `'mep'`, `'oficial'`, `'blue'`, `'manual'`, or `'backfill'`.
- `usd_amount` (`NUMERIC(18,2)`, nullable) — materialized USD equivalent, stored as `round(amount ÷ fx_rate, 2)`.

The ARS-equivalent `amount` remains authoritative (ADR-025 preserved). `usd_amount` is a co-stored materialized figure so USD spend can be summed directly across rows without per-row division at read time. Storing all three preserves full provenance: which rate, from which source, and the derived USD value.

An Alembic migration adds these columns as nullable (no server-side rate fetch in the migration itself; backfill is client-driven per ADR-150).

## Alternatives Considered

- **Rate-only, divide at read time**: store `fx_rate` alone and compute `usd_amount` on the fly — lossy for historical rows where the rate is unknown; requires per-row division in every USD spend query; rejected.
- **USD-only storage**: store `usd_amount` without a rate or ARS amount — loses the ARS provenance needed for ARS-denominated budget actuals and violates ADR-025's authoritative-amount invariant; rejected.
- **No snapshot, recompute from a rate table**: maintain a separate FX history table and join at read time — adds a new table and a join on every spend query; provenance is indirect; rejected.

## Consequences

- Three nullable columns added to `transactions` via a non-destructive Alembic migration; no existing data breaks.
- USD spend sums are historically faithful: `SUM(usd_amount)` over any period is exact as of capture time.
- Provenance is retained per row (`fx_source`); auditing which rate was used for any transaction is O(1).
- Rows without a snapshot (existing transactions pre-backfill, statement imports pre-fill) have null `usd_amount`; the spend-exclusion rule is defined in ADR-152.
- Relates to ADR-025 (ARS-amount authoritative; `usd_amount`/`fx_rate` type conventions), ADR-044/133 (FX is client-side; no server FX feed), ADR-149 (client supplies snapshot on write), ADR-150 (backfill of existing rows), ADR-152 (budget spend path + unconverted-note rule).

## Status History

- 2026-06-30: accepted
