---
project: margen
adr: 55
title: "app_settings migration: create the single-row table, migrate the monotributo_config row, drop monotributo_config"
category: data
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-055: app_settings migration: create the single-row table, migrate the monotributo_config row, drop monotributo_config

## Context

ADR-054 consolidates settings into a single-row `app_settings` table and removes `monotributo_config`. The existing `monotributo_config` row carries the user's configured category and activity type (seeded in the ADR-048 migration). That data must not be lost during the transition.

ADR-025 governs money column typing. Validation of currency and FX-default values lives in the domain layer (ADR-054), so the new table uses plain string columns rather than DB-level enums — consistent with the `FxRateType` string pattern established for FX (ADR-044).

## Decision

Write an **Alembic migration** that performs the following steps in order:

**Upgrade path:**

1. Create `app_settings` table:
   - `id` — integer primary key.
   - `preferred_display_currency` — String, default `'ARS'`, not null.
   - `fx_default_rate_type` — String, default `'MEP'`, not null.
   - `monotributo_current_category` — String(2), not null.
   - `monotributo_activity_type` — String(20), default `'services'`, not null.
   - `created_at` — DateTime, server default `now()`.
   - `updated_at` — DateTime, server default `now()`, `onupdate=now()`.

2. Copy the existing `monotributo_config` row's `current_category` and `activity_type` into a seeded `app_settings` row (with `preferred_display_currency='ARS'`, `fx_default_rate_type='MEP'`). If no `monotributo_config` row exists, seed with category `'C'` and `activity_type='services'` — matching the ADR-048 seed default.

3. Drop the `monotributo_config` table.

**Downgrade path:**

1. Recreate `monotributo_config` (columns: `id`, `current_category`, `activity_type`, `created_at`, `updated_at`).
2. Copy `monotributo_current_category` and `monotributo_activity_type` from `app_settings` back into a `monotributo_config` row.
3. Drop `app_settings`.

The `monotributo_config` ORM model and its repository are removed from the codebase. Their test fixtures are updated or replaced in ADR-058.

## Alternatives Considered

- **Keep `monotributo_config` and add `app_settings` in parallel**: the architecture ADR (ADR-054) chose a single store to avoid split write paths — rejected.
- **Drop `monotributo_config` without migrating the category**: would silently reset the user's configured category to the default on every upgrade — rejected; the configured value is user data, not just a seed.

## Consequences

Single settings table after upgrade; the issue #8 `monotributo_config` model, repository, and migration fixture are retired. Integration tests must cover:

- The migrated category is carried forward correctly (the round-trip is proven at the real-Postgres tier per ADR-032/ADR-058).
- The downgrade path restores `monotributo_config` without data loss.

Related: ADR-048 (origin of `monotributo_config`), ADR-054 (architecture decision driving this migration), ADR-058 (test coverage).

## Status History

- 2026-06-14: accepted
