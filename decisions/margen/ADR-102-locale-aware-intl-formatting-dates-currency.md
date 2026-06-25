---
project: margen
adr: 102
title: Locale-aware Intl formatting for dates, months, and currency
category: architecture
date: 2026-06-24
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-102: Locale-aware Intl formatting for dates, months, and currency

## Context

Locale data is hardcoded English: `months.ts` produces labels like "June 2026"
(used by MonthSwitcher, monotributo), and currency/amount/date formatting
assumes English. Spanish needs localized month names and number/currency
formatting.

## Decision

Format dates, month labels, numbers, and ARS/USD currency via the **Intl API**
(`Intl.DateTimeFormat` / `Intl.NumberFormat`) keyed off the active locale,
replacing the hardcoded English formatting in `months.ts` and the
Amount/currency helpers. Centralize formatting in locale-aware utilities/hooks
so components don't hardcode locale.

## Alternatives Considered

- **Translate strings only, keep English formatting**: inconsistent Spanish UX
  (e.g. "junio" text but "June 2026" dates) — not chosen.

## Consequences

Touches `months.ts`, MonthSwitcher, the Amount component, monotributo, and any
date/number rendering. Formatting becomes locale-reactive and updates on
language switch without a page reload.

Relates to: ADR-100 (i18n business decision), ADR-101 (active locale source
consumed by these utilities).

## Clarification (2026-06-25)

ARS/USD numeric **grouping** is a **domain constant** (`es-AR`) in both
languages — Argentine peso/USD figures read as `622.500` / `21,1M` regardless of
UI language. Only month/date names and human-readable label words (currency
names, FX source, sign words) localize off the active UI language. This split is
intentional, not an oversight.

## Status History

- 2026-06-24: accepted
- 2026-06-25: clarified (ARS/USD grouping is a domain constant; dates/months/labels localize)
