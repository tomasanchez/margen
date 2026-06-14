---
project: margen
adr: 54
title: "Consolidate settings into a single-row app_settings table with GET/PATCH /api/v1/settings"
category: architecture
date: 2026-06-14
status: accepted
supersedes: ADR-048
authors: [Tomas Sanchez]
---

# ADR-054: Consolidate settings into a single-row app_settings table with GET/PATCH /api/v1/settings

## Context

ADR-048 introduced a single-row `monotributo_config` table (columns: `current_category`, `activity_type`) with a dedicated `PATCH /api/v1/monotributo/config` endpoint, anticipating that issue #10 would build a richer settings surface. Issue #10 (ADR-053) adds three more settings: `preferred_display_currency`, `fx_default_rate_type`, and the same category/activity pair.

Keeping `monotributo_config` as a separate table would mean:

- Two stores and two write paths for closely related settings.
- The Monotributo category living in a different place from every other preference.
- Two endpoints (and double the test surface) for something the same single client manages.

There is no auth or multi-user concern; a single row is the correct shape.

## Decision

Generalize to a **single-row `app_settings` table** holding:

| column | type | default |
|---|---|---|
| `preferred_display_currency` | String | `'ARS'` |
| `fx_default_rate_type` | String | `'MEP'` |
| `monotributo_current_category` | String(2) | `'C'` |
| `monotributo_activity_type` | String(20) | `'services'` |

Expose two endpoints:

- **`GET /api/v1/settings`** — returns the current settings row as a `ResponseModel[T]` envelope (ADR-030), camelCase keys.
- **`PATCH /api/v1/settings`** — partial update; validates:
  - `preferred_display_currency` ∈ `{ARS, USD}` → 422 on unknown.
  - `fx_default_rate_type` ∈ `{MEP, official}` → 422 on unknown.
  - `monotributo_current_category` ∈ `{A…K}` → 422 on unknown.
  - Returns the updated row in the same `ResponseModel[T]` envelope.

**Remove `PATCH /api/v1/monotributo/config`**: the Monotributo page's category selector writes to `/settings` instead. `GET /api/v1/monotributo` continues to compute the standing but reads `current_category` from `app_settings`.

Implementation follows the established read+write seam used by monotributo and summaries: reader port + read model + repository + command/handler + Unit of Work — mirroring the entrypoint structure from ADR-046/047/042.

Money string typing stays consistent with the existing `FxRateType` string column (ADR-044/025); currency and FX-default validation live in the domain, not as DB-level enums.

**This ADR supersedes ADR-048's storage decision** (the `monotributo_config` table is replaced by `app_settings`) and removes its config endpoint. The data migration is specified in ADR-055. ADR-048 is annotated accordingly.

## Alternatives Considered

- **Separate `app_settings` alongside `monotributo_config`**: two stores and two write paths for related settings; the category source remains split — rejected.
- **Generic key-value settings table**: loose typing and no domain-level validation for ~4 typed fields; over-engineered for the current scale — rejected.
- **Keep `/monotributo/config` as an alias**: two endpoints to maintain and test with no current benefit; we control the only client and can update it in the same changeset — rejected.

## Consequences

One source of truth and one write path for all settings. The Monotributo category lives in `app_settings` alongside the display and FX preferences, making the full settings surface reachable via a single round-trip.

Requires:
- A data migration (ADR-055) that carries the existing `monotributo_config` row into `app_settings` and drops the old table.
- Removal of the `monotributo_config` ORM model and its repository.
- A frontend repoint of the Monotributo category selector from `/monotributo/config` to `/settings` (UX ADR-057).
- The `GET /api/v1/monotributo` handler's reader is updated to source `current_category` from `app_settings`.

Related: ADR-030 (ResponseModel envelope), ADR-025 (Decimal/string money), ADR-053 (business scope), ADR-055 (migration), ADR-056 (display currency), ADR-057 (UX wiring), ADR-058 (tests), ADR-059 (risks).

## Status History

- 2026-06-14: accepted

## Notes

- 2026-06-14: This ADR amends and supersedes ADR-048 in its storage decision. The `monotributo_config` table is replaced by `app_settings`; `PATCH /api/v1/monotributo/config` is removed. See ADR-055 for the migration details.
