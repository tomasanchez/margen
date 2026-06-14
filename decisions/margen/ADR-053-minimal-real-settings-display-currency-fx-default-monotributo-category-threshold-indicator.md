---
project: margen
adr: 53
title: "Minimal real settings: display currency, FX default, Monotributo category, manual-threshold indicator"
category: business
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-053: Minimal real settings: display currency, FX default, Monotributo category, manual-threshold indicator

## Context

Issue #10 requires real, persisted settings that feed behavior — not cosmetic personalization. Four concrete needs emerged from the existing feature set:

1. Users want to view Home cards and summaries in USD (ADR-016 formats everything ARS today; ADR-042/043 expose the summary data).
2. The FX suggested source on Add/Edit (ADR-044/045) is hardcoded to MEP; users may prefer the official rate.
3. The Monotributo category (ADR-046/048) is editable only from the Monotributo page via a dedicated endpoint; it belongs with the other settings.
4. The A–K AFIP ceilings are a manually maintained constant (ADR-051/048); users need a visible indicator rather than silently stale data.

ADR-012 notes that "settings are a non-goal" for the prototype. Issue #10 explicitly revisits that decision: settings become a goal the moment they drive behavior.

Out-of-scope for this issue: themes, notifications, account/auth, household management, advanced analytics.

## Decision

Ship four real settings on a single-row store:

1. **Preferred display currency** — `ARS` (default) | `USD`. Changes the display of Home metric cards and monthly summaries.
2. **FX default rate source** — `MEP` (default) | `official`. Pre-selects the suggested source on the Add/Edit USD flow (ADR-044/045).
3. **Monotributo current category + activity type** — letter A–K and `services` (default). Feeds the trailing-12-month calculation (ADR-046) and the Monotributo page standing.
4. **Manual-threshold indicator** — the A–K scale is a versioned constant with a scale year. Surfaced as a read-only note on Settings and on the Monotributo page; not user-overridable in MVP.

Each setting must change real behavior:

- Currency → Home cards + summaries display figures (ADR-043/042).
- FX default → the Add/Edit suggested source (ADR-044/045).
- Category → Monotributo calculation (ADR-046).
- Indicator → rendered on Settings page + Monotributo page (ADR-049).

## Alternatives Considered

- **Cosmetic settings screen**: a screen that stores preferences without feeding any behavior — rejected because the issue requires settings to drive summaries, FX, and Monotributo, not just record preferences.
- **Full personalization (themes, notifications, profile)**: explicit non-goals for MVP; keeping the surface small reduces scope and risk.

## Consequences

A small, correctness-focused settings surface where every preference has a concrete consumer. The behavior linkage means a regression in any consumer is detectable via the testing ADR (ADR-058).

Per-category threshold override, automatic AFIP scale updates, and full multi-screen USD reformatting (transaction rows, Monotributo ARS ceiling) are deferred — see the risks ADR (ADR-059).

## Status History

- 2026-06-14: accepted
