---
project: margen
adr: 151
title: Persisted preferred rate-source setting (MEP/Official) in app settings
category: architecture
date: 2026-06-30
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-151: Persisted preferred rate-source setting (MEP/Official) in app settings

## Context

A MEP/Official selector already exists on the net-worth card (ADR-133) as a transient UI preference. The FX snapshot model (ADR-148/149) requires a designated rate source for transaction capture. The USD budgets feature (ADR-152) needs the same source for converting category spend. Without a single persisted source of truth, these surfaces may diverge — a user who selects MEP on the net-worth card would still see a different rate drive their budget spend. Fragmented per-surface settings increase cognitive load and produce inconsistent figures across the app.

## Decision

The MEP/Official selector is promoted to a **persisted per-user `preferredRateSource`** setting (allowed values: `'mep'` | `'oficial'`; default `'mep'`). It lives alongside `displayCurrency` in the existing app settings store (backend `app_settings` table / frontend settings context).

**What it drives:**

- Transaction capture: the preferred source is the initial suggestion in the Add/Edit FX suggest-confirm flow (ADR-045).
- Historical backfill: the preferred source is the default for the client-driven backfill step (ADR-150).
- Budget spend conversion: the preferred source is used when fetching the live rate for USD budget currency conversions (ADR-152).
- Net-worth card: the existing UI selector reads/writes this persisted setting rather than holding transient local state.

The setting is user-editable at any time; changing it does not retroactively alter captured FX snapshots (those are immutable once stored).

## Alternatives Considered

- **Budgets-only setting separate from the net-worth selector**: Two independent settings for the same conceptual preference — creates fragmentation and potentially contradictory rates across the app; rejected.
- **Hardcode MEP as the only source**: Removes configurability; the owner explicitly wants the ability to switch to the official rate; rejected.
- **Transient per-session preference (no persistence)**: User must re-select on every session; rate source could differ between sessions; inconsistent backfill if run across sessions; rejected.

## Consequences

- Extends the app settings model with one new field (`preferredRateSource`); a small migration or settings-upsert handles the default.
- The net-worth card selector becomes a controlled component reading from and writing to the persisted setting rather than local state.
- All FX-consuming surfaces (capture, backfill, budgets) share a single source of truth — rates are consistent across the app for a given user preference.
- Changing the preference mid-month does not alter past snapshots; existing `usd_amount` values are frozen at capture time.
- Relates to ADR-044/133 (client-side FX, net-worth card rate picker), ADR-148 (snapshot captures rate source per row), ADR-149 (client supplies rate on write), ADR-150 (backfill uses preferred source), ADR-152 (budget conversion uses preferred source).

## Status History

- 2026-06-30: accepted
