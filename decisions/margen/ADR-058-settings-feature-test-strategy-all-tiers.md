---
project: margen
adr: 58
title: "Test the settings feature across the ADR-032 tiers"
category: testing
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-058: Test the settings feature across the ADR-032 tiers

## Context

ADR-032 mandates a fully-mocked fast tier that satisfies the `make cover` 100% gate (no real I/O) and a real-Postgres integration tier run only in CI (marked `@pytest.mark.integration`). The frontend mocks the HTTP client layer per ADR-038.

The settings feature (ADR-053–057) introduces:

- A new domain with validation rules (currency, FX default, category).
- A new read/write endpoint pair (`GET`/`PATCH /api/v1/settings`).
- A data migration that carries the `monotributo_config` row into `app_settings` and drops the old table (ADR-055).
- A frontend Settings page, display-currency conversion on Home/summaries, and FX default pre-selection on Add/Edit (ADR-056/057).

Each of these surfaces has a concrete failure mode that needs test coverage.

## Decision

### Backend

**Unit tests (fully mocked — fast tier):**

- Settings domain validation: `preferred_display_currency ∈ {ARS, USD}` → success; unknown value → `ValueError`/domain error.
- `fx_default_rate_type ∈ {MEP, official}` → success; unknown → domain error.
- `monotributo_current_category ∈ {A…K}` → success; unknown letter → domain error.
- Partial-PATCH merge: a PATCH with only `preferred_display_currency` leaves other fields unchanged.

**Mocked-reader / fake-UoW HTTP tests (fast tier):**

- `GET /api/v1/settings` → 200, `{data: {...}}` envelope (ADR-030), camelCase keys.
- `PATCH /api/v1/settings` → 200, updated row in envelope.
- `PATCH /api/v1/settings` with bad category → 422.
- `PATCH /api/v1/settings` with bad currency → 422.
- `GET /api/v1/monotributo` reads `current_category` from `app_settings` (not from a hardcoded default or the removed `monotributo_config`).

**Integration tests (`@pytest.mark.integration` — real Postgres, CI only):**

- `app_settings` round-trip: write a category via PATCH, read it back via GET, confirm it matches.
- Migration carries over the `monotributo_config` category: run the upgrade against a DB seeded with a `monotributo_config` row, assert the `app_settings` row has the same `current_category`.
- `GET /api/v1/monotributo` uses the category stored in `app_settings` to compute the correct standing.
- Downgrade path restores `monotributo_config` without data loss.

`make cover` must stay at 100% and `make lint` must stay green.

### Frontend

**Vitest + React Testing Library, `settingsClient` mocked:**

- Settings page: `GET /api/v1/settings` is called on mount; each field renders with the loaded value.
- Changing and saving a field calls `PATCH /api/v1/settings` and invalidates Home, summaries, and Monotributo queries.
- `PATCH` failure shows a calm inline error note (ADR-037); page state is not corrupted.
- Home cards and summaries render in USD when `preferred_display_currency = USD` and a mocked rate is available (value = ARS / rate).
- Home cards and summaries fall back to ARS display with a calm note when the rate fetch fails (ADR-037).
- The FX default pre-selects the Add/Edit suggested source (ADR-044/045) matching the stored `fx_default_rate_type`.
- The manual-threshold indicator renders on the Settings page and on the Monotributo page.

`pnpm lint`, `pnpm test`, and `pnpm build` must stay green.

## Alternatives Considered

- **Only integration tests**: would break the fully-mocked 100% coverage gate mandated by ADR-032 — rejected.
- **Skip the migration integration test**: the `monotributo_config → app_settings` data migration is precisely the behaviour that requires real-Postgres proof; skipping it would leave the most risky step untested — rejected.

## Consequences

Confidence that settings drive behaviour and that the migration preserves the user's configured category. The 100% gate and the CI integration stage both hold.

The `monotributo_config` fixture and its associated tests are removed; the `app_settings` fixtures and tests replace them. No orphaned test coverage.

Related: ADR-032 (test tiers), ADR-038 (frontend HTTP client mocking), ADR-054 (architecture — what to test), ADR-055 (migration — integration proof), ADR-056/057 (display currency + UX — frontend coverage).

## Status History

- 2026-06-14: accepted
