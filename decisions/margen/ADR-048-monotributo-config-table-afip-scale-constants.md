---
project: margen
adr: 48
title: "Persist Monotributo config (current category + activity type) with a migration; A-K ceilings as reference constants; editable via PATCH"
category: data
date: 2026-06-14
status: superseded
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-048: Persist Monotributo config (current category + activity type) with a migration; A-K ceilings as reference constants; editable via PATCH

## Context

The trailing-12-month calculation (ADR-046) requires the user's current Monotributo category and activity type to look up the annual ceiling. Issue #8 chose to persist a configured category now — a minimal slice of the broader settings surface planned for issue #10 — rather than hardcode it. There is no auth/multi-user yet. The A–K AFIP category scale (ceilings and monthly cuotas) is reference data that changes roughly once a year.

ADR-025 mandates Decimal/NUMERIC for all monetary values.

## Decision

Add a **single-row `monotributo_config` table** via an Alembic migration, storing:

- `current_category` — a single letter A–K.
- `activity_type` — enum/string, default `'services'`.

Seed the row with a sensible default (category C, services).

Ship the **A–K AFIP 2026 scale** (annual ceiling + `cuotaServicios` + `cuotaBienes` per letter) as a **versioned backend reference constant/module** — no table. The endpoint returns the full scale in the snapshot so the frontend can render the ladder. Money columns follow ADR-025 (Decimal/NUMERIC).

Expose a minimal **`PATCH /api/v1/monotributo/config`** (or `PATCH /api/v1/monotributo`) accepting `current_category` (and optionally `activity_type`) so the user can set or change their category from the Monotributo page now. The full settings UI remains issue #10.

## Alternatives Considered

- **Hardcode a default category, no persistence**: the "current" value would be fake and the acceptance criterion "I have configured a category" would be unmet.
- **Store the AFIP scale ceilings in a DB table too**: reference data that changes ~yearly; a versioned constant is simpler to maintain for MVP and avoids seed/migration churn.
- **Full settings table and UI now**: that is issue #10; keep this slice minimal.

## Consequences

One small config table plus its Alembic migration and a minimal write path land with issue #8. The AFIP recategorization thresholds are a maintained constant — they must be updated manually when AFIP revises them; this staleness risk is accepted and documented in ADR-051. Category editing is possible from the Monotributo page (ADR-049); issue #10 builds the richer settings surface on top. The reader (ADR-047) depends on this table and constant module.

## Status History

- 2026-06-14: accepted
- 2026-06-14: superseded by ADR-054 (config table → app_settings)
- 2026-06-14: scale-constant aspect superseded by ADR-067 (single current-only constant → versioned effective-dated registry)

## Notes

- 2026-06-14: A `monotributo_snapshot` history table is added alongside `monotributo_config` to persist periodic computed standings (one row per trailing-12-month period, keyed by `period_end` month). This enables the prior-period comparison without recomputing historical figures against today's scale. See ADR-052.
- 2026-06-14: **Superseded by ADR-054** (issue #10). The `monotributo_config` table is replaced by a single-row `app_settings` table that consolidates all user settings (display currency, FX default, Monotributo category + activity type). The `PATCH /api/v1/monotributo/config` endpoint is removed; the category is now written via `PATCH /api/v1/settings`. The data migration (create `app_settings`, carry over the `monotributo_config` row, drop `monotributo_config`) is specified in ADR-055.
