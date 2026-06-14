---
project: margen
adr: 56
title: "Preferred display currency: convert Home cards + summaries to USD via a live configured-default rate, ARS fallback"
category: architecture
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-056: Preferred display currency: convert Home cards + summaries to USD via a live configured-default rate, ARS fallback

## Context

All monetary amounts in Margen are stored as ARS-equivalent values (ADR-025). There is no single global FX rate; the dolarapi.com client introduced in ADR-044 fetches live rates at transaction time. ADR-016 mandates `es-AR` money formatting with ARS as the base across all screens.

Issue #10 (ADR-053) adds a `preferred_display_currency` setting (ARS | USD). When set to USD the user expects to see the Home metric cards and monthly summaries expressed in US dollars — the two most-used summary surfaces (ADR-042/043). Amounts are stored in ARS; a conversion rate is needed at display time.

Key constraints:

- ARS must remain the authoritative stored and aggregated currency — this is a display transform only.
- The conversion rate is live and volatile; it can fail.
- Transaction rows carry a per-row currency; a blanket "divide by rate" for individual rows is misleading.
- The Monotributo ARS ceiling expressed in USD reads oddly and is not a common user need.

## Decision

When `preferred_display_currency = USD`:

- Convert **only the Home metric cards** (income, expenses, savings) and **the monthly summaries** (trend chart and category breakdown from ADR-042/043) from ARS to USD on the **frontend**, by dividing each ARS figure by a single live rate.
- The rate is fetched from **dolarapi.com** at the user's configured `fx_default_rate_type` (MEP or official) — reusing the existing `fxClient` introduced for ADR-044.
- If the rate fetch fails, **fall back to ARS display** with a small, calm note consistent with ADR-037 (calm UI states). No stored conversion; no error screen.

**Not converted:**

- Transaction rows (each carries its own per-row currency; converting to a single live rate would misrepresent the original entry).
- Monotributo ARS ceiling, used amount, and margin (converting an AFIP regulatory limit to USD at a live rate produces a confusing and volatile figure).

ARS remains the default and the base of all stored/aggregated money. The conversion is a pure display transform; it is never written back.

**Implementation**: `format.ts` call sites for Home cards and summaries become currency-aware via a display-currency context/helper (reading `preferred_display_currency` from the settings store and the fetched rate). All other `format.ts` call sites stay ARS.

## Alternatives Considered

- **Backend converts summaries to USD before returning them**: pushes a volatile display rate into server-side aggregates, making ARS the non-authoritative value and complicating caching — rejected; frontend display transform keeps ARS authoritative.
- **Per-row historical rates for USD display**: no single representative figure for aggregates; out of scope and confusing for month-level summaries — rejected.
- **Convert every screen including Monotributo and transaction rows**: larger blast radius; ARS ceiling in USD is misleading; transaction rows have per-row currencies — rejected; bounded conversion on Home + summaries only.

## Consequences

A bounded, real USD display on the two most-used summary surfaces. ARS stays authoritative everywhere else.

Adds a display-time dolarapi.com dependency for the USD path; graceful ARS fallback (ADR-037) means no hard failure. The `fxClient` (ADR-044) is reused — no new HTTP dependency.

`format.ts` call sites for Home cards and summaries must become currency-aware; a display-currency context or helper is introduced. All other call sites are unchanged.

Related: ADR-016 (es-AR money formatting), ADR-025 (ARS-only storage), ADR-042/043 (summaries endpoint + Home consumption), ADR-044/045 (FX rate source + suggest-confirm flow), ADR-053 (business scope of settings), ADR-057 (UX wiring), ADR-058 (testing the fallback path).

## Status History

- 2026-06-14: accepted
