---
project: margen
adr: 150
title: Historical FX backfill of existing transactions — client-driven, occurred_on rate
category: data
date: 2026-06-30
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-150: Historical FX backfill of existing transactions — client-driven, occurred_on rate

## Context

72 existing transactions predate the FX snapshot model (ADR-148) and carry no `fx_rate`, `fx_source`, or `usd_amount`. The Alembic migration for ADR-148 adds only nullable columns — the server performs no rate fetch during the migration (ADR-149 prohibits server-side FX calls). Without backfill, USD spend for all historical rows would be unknown, making the USD budgets feature (ADR-152) incomplete at launch.

A correct backfill must use the rate that was in effect on each row's `occurred_on` date, not a single current rate applied uniformly — the MEP rate drifts significantly month to month.

## Decision

A one-time **client-driven backfill** stamps each existing unsnapshotted transaction with the MEP rate that was in effect on its `occurred_on` date. The default source is MEP (`fx_source = 'backfill'`).

**Mechanics:**

1. The client fetches all transactions lacking a snapshot (null `fx_rate`).
2. For each transaction, it looks up the historical MEP rate for `occurred_on` from a client-side historical FX source (default: ArgentinaDatos `api.argentinadatos.com` historical dolar quotes, or dolarapi historical endpoint — VERIFY availability during implementation).
3. The client sends a PATCH with `fx_rate` + `fx_source = 'backfill'`; the backend materializes `usd_amount` per ADR-149.
4. Rate lookups are batched by unique date to minimize API calls.

**Migration boundary:** the Alembic migration only adds the nullable columns. No server-side rate fetch or data mutation occurs in the migration.

## Alternatives Considered

- **Apply the current rate uniformly in the migration**: Single server-side rate stamps all historical rows — historically inaccurate for rows months or years old; the MEP has moved materially; rejected.
- **Leave historical rows null; only snapshot new rows going forward**: Incomplete USD spend history; the budgets and reports features would have gaps for all prior months; rejected.
- **Server-side backfill job with a historical FX feed**: Adds a server-side external dependency (ADR-149 prohibition) and a one-off migration script that is harder to test and rerun safely; rejected in favor of client-driven patch flow.

## Consequences

- Depends on a client-accessible historical FX source providing per-date MEP quotes — **VERIFY** ArgentinaDatos (`api.argentinadatos.com/v1/cotizaciones/dolares/mep`) or dolarapi historical during implementation before relying on it.
- Until the backfill completes, USD spend for historical rows is unknown; ADR-152's unconverted-note rule surfaces this to the user rather than silently excluding rows.
- The backfill uses `fx_source = 'backfill'` so provenance is distinguishable from interactively confirmed rates.
- The client backfill is idempotent: a second pass only patches rows that still have null `fx_rate`.
- ARS-only transactions (no USD involvement) are skipped; no rate is applied to them.
- Relates to ADR-025 (Decimal precision), ADR-148 (snapshot fields introduced), ADR-149 (client supplies rate; server materializes), ADR-151 (preferred rate source used as backfill default), ADR-152 (null-snapshot rows excluded from USD spend with user-visible note).

## Status History

- 2026-06-30: accepted
