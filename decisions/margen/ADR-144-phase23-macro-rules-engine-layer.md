---
project: margen
adr: 144
title: "(Phase 2/3 placeholder) Macro rules-engine layer: immutable MacroSnapshot, trigger-based rebalancing, provenance/confidence and source-priority fallback, Override governance"
category: architecture
date: 2026-06-30
status: proposed
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-144: (Phase 2/3 placeholder) Macro rules-engine layer: immutable MacroSnapshot, trigger-based rebalancing, provenance/confidence and source-priority fallback, Override governance

## Context

A complementary "rules-engine" design document describes a full macro-aware budget layer: an immutable `MacroSnapshot` entity capturing CPI/wage/FX/rates/subsidy/tax versions, trigger-based rebalancing proposals, a provenance/confidence layer over every macro figure, a source-priority fallback chain, and an override governance log. These are the right long-term engineering foundations for an inflation-resistant personal-finance tool in Argentina. They are blocked in MVP by: (a) no official-data feeds are adopted yet (ADR-141 — open owner research), (b) no macro history exists to compute deltas, and (c) no automation exists to govern. Extends ADR-125. Reuses ADR-044 (suggest/confirm/never-silent), ADR-046/052 (snapshot-history precedent — Monotributo), ADR-129 (Forecast pace projector), ADR-130 (per-user ownership), ADR-137 (reprice as the apply step), ADR-141 (feeds suggestion-only), ADR-143 (MVP strategy suggestion this eventually extends).

## Decision

The macro rules-engine is a **Phase 2/3 design**, to be detailed in a future deep-plan once the MVP reprice loop is proven and the owner has resolved the official-data maintenance question (ADR-141). The following design is recorded as a placeholder to constrain the eventual implementation:

**`MacroSnapshot` (Phase 2):**

- Immutable, append-only aggregate keyed `(period, source, captured_at)`, à la the Monotributo snapshot history (ADR-052). Recalculate derived figures against historical snapshots without mutating them. Fields: CPI · wage index · FX (official/MEP/CCL/blue) · policy rates · subsidy/tariff versions · tax rule versions.
- Source provenance on every figure: `official → provincial → media → private`. Show whether a number is synced/official/estimated/unofficial.
- Stale/failed feed fallback: hold the last confirmed value; label "pending official release." Never silently switch sources (ADR-044).

**Trigger-based rebalancing (Phase 2):**

- Pure trigger eval: `(actuals, macro_now, macro_prev) → triggers`. Trigger conditions: overspend >10% for two months; CPI acceleration >1pp; FX shock >5%; subsidy/tax version change.
- A triggered rebalance is a **prompted, capped preview** — never auto-applied. Reuses ADR-137 `RepriceMonth` as the apply step + ADR-042 actuals.

**Provenance/confidence + source-priority/fallback (Phase 3):**

- Provenance value object: `(source, confidence, captured_at)` on every macro figure.
- Pure source-priority resolver: `official → provincial → media → private`.
- Confidence badges shown in the UI; unofficial rates require explicit user opt-in for planning use.

**Override governance (Phase 3):**

- Append-only override log: `(reason_code, source_snapshot_id, old_value, new_value, expires_at, user_id)`.
- Auto-applied parameters carry `expires_at` — the user is re-prompted on expiry.
- Nothing changes silently (ADR-044). The full governance surface only matters once automation proposes changes.

**Scenario simulation (Phase 3):**

- Simulation service extending the Forecast pace projector (ADR-129) with the `MacroSnapshot` as the shock-parameter source (currency shock, regulated-price catch-up, hyperinflation repricing).

## Alternatives Considered

- **Hardcoding or auto-applying official feeds**: bake INDEC CPI or BCRA rates directly into rebalancing logic — why not chosen: violates the "parameterize, never hardcode" and "nothing silent" stances (ADR-044/ADR-141); stale or failed feeds would silently corrupt plans.
- **Mutating snapshots in place**: update the single macro record when new data arrives — why not chosen: loses historical recalculability; the append-only snapshot pattern (ADR-052) is the established precedent in this codebase.
- **Building the macro layer before the reprice loop is proven**: start with `MacroSnapshot` in MVP — why not chosen: the feeds that populate `MacroSnapshot` are the owner's open research question (ADR-141); building the infrastructure before committing to the feeds creates dead code.

## Consequences

- This ADR records the intended Phase 2/3 shape so future implementers understand the constraints (immutability, provenance, nothing-silent) before designing.
- The MVP's manual inflation % (ADR-137/ADR-141) is the "snapshot" stand-in until this layer exists.
- Scenario simulation is explicitly gated on both Forecast (ADR-129) and MacroSnapshot; it cannot be built before Phase 3.
- The owner's decision on official-data feeds (ADR-141) is a hard prerequisite for any Phase 2 macro work.
- Relates to ADR-044 (suggest/confirm governance model), ADR-052 (snapshot-history precedent), ADR-129 (Forecast — simulation host), ADR-137 (reprice = the apply step for triggered rebalancing), ADR-141 (feed adoption is the blocker), ADR-143 (MVP strategy suggestion this extends in Phase 2/3).

## Status History

- 2026-06-30: proposed
