---
project: margen
adr: 116
title: Transactions filters are URL-synced two-way — URL as source of truth
category: architecture
date: 2026-06-27
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-116: Transactions filters are URL-synced two-way — URL as source of truth

## Context

The Transactions screen carries multiple filter dimensions: free-text search query, transaction type, currency, month/range, categories, banks, and amount range. Until now, filter state was held in-memory (a reducer), per the ADR-012 "prototype state in-memory" stance. The URL could only *seed* filters one-way — ADR-062 introduced `?category=` for the insights drilldown, and a later `?type=` param enabled the Monotributo invoice drill-in from ADR-115 — but user changes to any filter never wrote back to the URL.

The consequences were: filtered views could not be shared or bookmarked; a page reload or browser Back/Forward lost all filter state; and the Monotributo drill-in relied on a hidden hook mapping internal sentinels to the right query rather than expressing the window explicitly in the URL.

The app has since outgrown its prototype assumptions: it has a real backend, authentication (ADR-090), and is in production (ADR-099). The user requested that filter changes be reflected in the URL.

## Decision

Make the Transactions filters **two-way URL-synced, with the URL as the single source of truth** for all filter dimensions:

1. **All filter dimensions serialize to validated query params.** Every active filter — search query, type, currency, month/range sentinel or specific month, categories, banks, amount min/max — is reflected in the URL. Params are validated in the route's `validateSearch` using the same robustness already applied to `category` and `type` (unknown or invalid values are silently ignored and fall back to defaults).

2. **Default values are omitted from the URL.** Params that equal their default (e.g. `type=all`, or the absence of an explicit month meaning "current month") are not written to the URL, keeping links clean. Absence implies the default at read time.

3. **Filter changes use `replace`-mode navigation.** Filter tweaks are not history steps — each change replaces the current history entry rather than pushing a new one. This keeps the browser Back button useful: pressing Back leaves the Transactions page entirely rather than stepping through every intermediate filter state.

4. **Free-text search is debounced (~300ms) before writing to the URL.** A local input value tracks keystrokes immediately for a responsive feel; the URL (and therefore any downstream query) only updates after the debounce settles. This prevents a history entry and a re-fetch on every keystroke.

5. **The Monotributo invoice drill-in passes its window explicitly.** The link now opens `/transactions?type=invoice&month=last12` rather than relying on a hidden hook that mapped a sentinel to the right params — the URL is self-describing.

## Alternatives Considered

- **Keep URL as seed-only / in-memory filters (status quo)**: Not shareable; filters are lost on reload and on Back/Forward navigation. Rejected.
- **Sync only primary params (type + month)**: Leaves free-text search and multi-select filters (categories, banks, amount range) unshareable; creates an inconsistent and confusing half-synced state. Rejected.
- **`push`-mode navigation on every filter change**: Floods browser history with every keystroke and every multi-select toggle; makes the Back button effectively unusable on the screen. Rejected.

## Consequences

- **Amends ADR-012** (Transactions filter state is no longer purely in-memory — it is URL-backed). The reducer is replaced by URL params as the authoritative state store.
- **Extends ADR-062** (one-way seed URL params → full two-way sync across all filter dimensions). The `validateSearch` approach pioneered for `category` and `type` is now the uniform validation boundary for every filter param.
- **Relates to ADR-115**: the month/range sentinels (e.g. `last12`) introduced there are among the synced params; the Monotributo drill-in window is now explicit in the URL (`?type=invoice&month=last12`) rather than implicit.
- The route's `validateSearch` becomes the single validation boundary for all Transactions filter params; invalid or unknown values are discarded and fall back to defaults.
- A relative default such as "current month" is intentionally omitted from the URL, so a shared link without an explicit `month` param shows the viewer's current month at view time. This is accepted: explicit specific-month and named-range selections (e.g. `month=last12`, `month=2025-06`) are always encoded and are deterministic for any viewer.

## Status History

- 2026-06-27: accepted
