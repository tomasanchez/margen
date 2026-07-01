---
project: margen
adr: 141
title: Macro inputs are manual and suggestion-only; no official-data scraping (INDEC/BCRA/ARCA) in MVP
category: risks
date: 2026-06-30
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-141: Macro inputs are manual and suggestion-only; no official-data scraping (INDEC/BCRA/ARCA) in MVP

## Context

The inflation-reprice model (ADR-137) and the household-floor / strategy-suggestion layer (ADR-143) require a monthly inflation figure and potentially other macro inputs (FX rates, CBT/canasta baskets, subsidy/tax rule versions, wage indices). Argentine official-data sources (INDEC CPI, BCRA FX/rates/UVA/CER/ICL, ARCA tax rules) are attractive because they are authoritative, but they carry large maintenance, legal/ToS, and operational costs. Extends ADR-125. Reuses ADR-044 (dolarapi suggest/confirm pattern), ADR-133 (client-side MEP).

## Decision

**All macro inputs in MVP are manual, seeded from suggestion constants, and never auto-applied.**

Specifically:

- **Monthly inflation %**: a single user-set percentage. MVP ships a **REM constant** (~1.8–2.1%/mo as of INDEC May 2026) as an editable frontend suggestion — the user sees the suggestion and confirms or overrides, identical to the dolarapi pattern (ADR-044). The constant can go stale; it is a suggestion, not a source of truth.
- **All official feeds (INDEC CPI, BCRA statistical API, ARCA tax rules)** are suggestion-only in any phase they appear, **never auto-applied** and **never hardcoded into accounting logic**.
- Whether to adopt any official feed at all is the owner's **open maintenance and legal research question**. This ADR does not answer it; it records that the MVP explicitly defers the decision.
- If a feed is built in a future phase, the cheapest first candidate is **BCRA market data** (FX/rates — has a documented statistical API), followed by INDEC CPI baskets (Phase 3, no clean JSON API; scraping = fragility + ToS exposure).
- FX is already solved: `fxClient.fetchSuggestedMepRate()` (dolarapi MEP/Official, client-side, calm-degrade to null — ADR-133). No new server-side FX dependency is introduced.
- Stale/failed feed fallback (when feeds eventually exist): hold the last user-confirmed value; label the figure "pending official release" — never silently switch sources or use an unofficial rate as a planning input without user opt-in.

## Alternatives Considered

- **Live INDEC CPI scraping in MVP**: automatically fetch the monthly CPI print and pre-fill the inflation suggestion — why not chosen: INDEC has no clean official JSON API; scraping is fragile (breaks on INDEC's schedule), legally unclear (ToS/robots.txt exposure), and adds an ops surface the owner has not committed to maintaining; the REM constant is sufficient for a suggestion.
- **BCRA API integration in MVP**: BCRA does publish documented statistical endpoints for rates — why not chosen: still an external HTTP dependency, a maintenance obligation, and a new server-side integration; adding it before the reprice loop is proven in production is premature. Phase 2 candidate if the owner decides to take on the maintenance cost.
- **Hardcoding macro figures**: bake a specific inflation %, CER/UVA factor, or FX rate into business logic — why not chosen: these figures change continuously; hardcoded values become wrong silently and are invisible to the user. The "parameterize, never hardcode" stance is foundational to the whole macro layer.

## Consequences

- The MVP ships with zero external official-data dependencies; no new server-side HTTP calls, no ToS exposure, no ops surface to maintain.
- The REM-seeded constant will go stale between releases; this is accepted because it is surfaced as an editable suggestion, not an auto-applied value.
- Future feed integrations (Phase 2/3) are pre-constrained to suggestion-only, never auto-apply, per this ADR — reduces the risk of silent mutations (consistent with ADR-044).
- The owner must decide whether to take on a BCRA or INDEC feed before any Phase 2/3 macro integration work begins.
- Relates to ADR-137 (reprice input is this manual %), ADR-143 (strategy suggestion requires no feed — pure ratio math), ADR-144 (Phase 2/3 macro rules-engine is explicitly blocked by this open question).

## Status History

- 2026-06-30: accepted
