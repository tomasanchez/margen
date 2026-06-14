---
project: margen
adr: 029
title: Persist an FX metadata block now
category: data
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-029: Persist an FX metadata block now

## Context

FX trust and display UX is issue #7, but the transaction schema needs FX fields at creation time. Adding them in a later migration would require a schema churn pass after #7 lands. The ARS-equivalent `amount` (ADR-025) is already the authoritative figure; the FX block supplements it for USD transactions.

## Decision

Persist `currency` (`ARS | USD`) plus a nullable FX block on every transaction row:

- `usd_amount NUMERIC(18,2)` — nullable
- `fx_rate NUMERIC(18,6)` — nullable
- `fx_rate_type VARCHAR` — nullable, default `'MEP'`
- `fx_rate_as_of TIMESTAMPTZ` — nullable

All FX fields are `NULL` for ARS rows. The ARS-equivalent `amount` remains authoritative. Issue #7 builds trust indicators and display logic on top of this block with no migration required.

## Alternatives Considered

- **Minimal `currency` + `usd_amount` + `fx_rate` only**: Would force a near-term migration when #7 adds `fx_rate_type`, `fx_rate_as_of`, and source metadata — not chosen.

## Consequences

Issue #7 is unblocked schema-wise. USD-without-rate is representable (`fx_rate NULL`) per the lenient validation decision (ADR-032). The full FX block is persisted from day one so no backfill is required. See ADR-025 for the NUMERIC precision conventions used here.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
