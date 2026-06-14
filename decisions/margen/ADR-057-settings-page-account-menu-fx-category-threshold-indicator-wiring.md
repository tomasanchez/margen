---
project: margen
adr: 57
title: "Settings page wired from the account menu; FX default + category + manual-threshold indicator consumption"
category: ux
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-057: Settings page wired from the account menu; FX default + category + manual-threshold indicator consumption

## Context

ADR-012 (the prototype) notes that "settings are a non-goal" and left the account-menu Settings entry as a disabled placeholder. No `/settings` route exists. Issue #10 revisits this and requires a real, small Settings surface (ADR-053) that visibly feeds behavior.

The account menu (desktop top-right Menu; mobile account drawer) is the existing affordance for settings navigation. The frontend follows ADR-033 for HTTP clients, ADR-037 for calm UI states, and ADR-043 for the TanStack Query + mutation pattern. The Monotributo page currently writes the category to `PATCH /api/v1/monotributo/config` (ADR-048); that endpoint is removed by ADR-054.

## Decision

Add a **`/settings` route + Settings page** reachable by enabling the account-menu Settings entry (both the desktop Menu item and the mobile account drawer entry).

The page provides:

- **Display currency selector** — ARS / USD (drives Home cards + summaries per ADR-056).
- **FX default rate source selector** — MEP / official (pre-selects the suggested source on Add/Edit per ADR-044/045).
- **Monotributo category selector** — letters A–K, plus activity type — writes to `PATCH /api/v1/settings` (ADR-054; one source of truth, removing the separate write path from the Monotributo page).
- **Manual-threshold indicator** — a read-only note: `"Thresholds are manually maintained · AFIP scale <year>"`. Shown here and on the Monotributo page (ADR-049/051).

Implementation follows the established client pattern (ADR-033): a `settingsClient` wrapping `GET /api/v1/settings` and `PATCH /api/v1/settings`, a TanStack Query `useSettings` hook, and a mutation that **invalidates the dependent queries** (Home/summaries/Monotributo) on successful save so all consumers reflect the change immediately.

Calm states (ADR-037): loading skeleton, error note if GET fails, save-error inline note if PATCH fails — no full-page error screens.

The Monotributo page's category selector is **repointed to the settings write path** (it now calls the same `settingsClient` mutation); the old `PATCH /api/v1/monotributo/config` call is removed. The category displayed on the Monotributo page is read from the `app_settings` row via `useSettings` (or the `/monotributo` endpoint which now reads from `app_settings` per ADR-054).

English-only, consistent with current app copy.

## Alternatives Considered

- **Settings inline in the account drawer (no dedicated route)**: a dedicated route is clearer for a multi-field form, matches the existing nav affordance, and is linkable — rejected.
- **Leave the Monotributo category selector on its own `/monotributo/config` endpoint**: two write paths for the same datum; ADR-054 removes that endpoint — rejected; consolidate.

## Consequences

A real Settings screen reachable from the existing account menu. Preferences visibly drive Home/summaries display (ADR-056), the FX default suggestion (ADR-044/045), and the Monotributo calculation (ADR-046). The Monotributo page and Settings agree on the category — one source of truth.

Theme preference remains localStorage-only (ADR-013) and is out of scope for this Settings page.

Related: ADR-012 (settings were a non-goal; now revisited), ADR-033 (frontend client pattern), ADR-037 (calm states), ADR-043 (TanStack Query pattern), ADR-044/045 (FX suggest-confirm), ADR-046 (Monotributo calc), ADR-049 (Monotributo page), ADR-053 (business scope), ADR-054 (settings endpoint), ADR-058 (tests).

## Status History

- 2026-06-14: accepted
