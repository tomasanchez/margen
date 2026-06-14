---
project: margen
adr: 044
title: USD FX rate suggested via dolarapi.com (MEP), user-confirmed, reusing existing FX fields
category: architecture
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-044: USD FX rate suggested via dolarapi.com (MEP), user-confirmed, reusing existing FX fields

## Context

Issue #7 requires trustworthy USD FX: which rate, what value, when it was captured, and whether it was automatic or manual. Automatic fetching was originally out of scope, but the team chose to fetch a suggested MEP rate from a public API on the frontend with user confirmation, and to reuse the existing transaction FX fields rather than add new columns. The FX block (`fx_rate`, `fx_rate_type`, `fx_rate_as_of`, `usd_amount`, `amount`) was persisted in advance (ADR-029); the create/patch API already accepts `fxRateType` + `fxRateAsOf` (ADR-024/030).

## Decision

The frontend fetches the MEP rate from dolarapi.com (`GET https://dolarapi.com/v1/dolares/bolsa`, CORS-friendly, no API key) to suggest a rate for USD transactions. The user confirms the suggestion (persisted `fx_rate_type = 'MEP'`) or overrides it (`fx_rate_type = 'manual'`). The rate date (`fx_rate_as_of`) defaults to the transaction's own date.

Persistence reuses the existing fields — `fx_rate` (value), `fx_rate_type` (source), `fx_rate_as_of` (= transaction date), `usd_amount`, and `amount` (ARS-equivalent = `round(usd_amount × fx_rate, 2)`). No new columns or migrations are required.

The only backend change is broadening the `FxRateType` enum to add `manual` (and `official`, `configured_default` as stubs for future use); `fx_rate_type` is a string column so no migration is needed.

If dolarapi.com is unavailable, the UI falls back to a required manual entry field — it never silently applies a guessed rate. Editing a confirmed rate recomputes `amount` so summaries (which aggregate `amount`, ADR-042/043) remain consistent.

## Alternatives Considered

- **Fetch via a backend proxy**: Reintroduces backend work and an additional endpoint; dolarapi.com is CORS-friendly and callable directly from the browser — not chosen.
- **Add `fx_rate_manual` / `fx_rate_edited` columns + migration**: The source is already captured in `fx_rate_type` (`MEP` vs `manual`) with no migration; a strict edited-after-creation flag is deferred — not chosen.
- **Auto-apply the fetched rate without confirmation**: A silent guess; issue #7 explicitly requires the user to confirm the suggested rate — not chosen.

## Consequences

Trustworthy USD conversion with one external dependency (dolarapi.com) called from the browser; `amount` recomputes from `usd_amount × fx_rate` on confirm or edit, keeping summaries consistent (ADR-042/043). A small `FxRateType` enum addition lands with no migration. The frontend API client (ADR-033) gains a thin dolarapi adapter module.

Deferred: strict edited-after-creation flag (`manual` source is the observable signal in the interim), historical rate lookup (suggest current rate; user overrides for backdated entries; `as-of` = transaction date), preferred display currency and configured FX default (issue #10), separate invoice-vs-payment rates.

Revisits ADR-031: the UI now requires a rate before saving a USD transaction; the backend remains lenient (ADR-031 unchanged). See ADR-045 for the suggest-then-confirm UX flow. Relates to ADR-029 (FX block persisted), ADR-024/030 (contract fields), ADR-033 (frontend API client), ADR-042/043 (summaries aggregate `amount`).

## Status History

- 2026-06-14: proposed
- 2026-06-14: accepted

> **Update (2026-06-14): Official dollar offered alongside MEP.** The frontend now
> also fetches the official rate (`GET https://dolarapi.com/v1/dolares/oficial`,
> same shape, `venta` side) and offers it as a second selectable suggestion. The
> Add/Edit form exposes an explicit rate-source selector (MEP / Official / Manual):
> picking MEP or Official pre-fills that suggested value and persists
> `fx_rate_type = 'MEP'` or `'official'`; typing a value switches the source to
> `manual`. This uses the `official` enum member already added above (still no
> migration) and supersedes the earlier rate-equals-suggestion heuristic with an
> explicit user choice. The unavailable-API fallback (required manual entry, no
> silent guess) and `amount` recompute are unchanged.
