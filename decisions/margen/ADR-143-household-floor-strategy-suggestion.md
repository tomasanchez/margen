---
project: margen
adr: 143
title: Household-floor readout and pure strategy suggestion; manual-floor MVP; macro-scored selector deferred
category: architecture
date: 2026-06-30
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-143: Household-floor readout and pure strategy suggestion; manual-floor MVP; macro-scored selector deferred

## Context

A complementary "rules-engine" design proposed a full strategy-recommendation engine: adequacy = income÷floor, volatility, FX-exposure, and wage-gap scores, all fed by macro snapshots (INDEC CBT, BCRA rates). The genuinely cheap, feed-free subset — an essentials floor vs. income readout and a ratio-based profile suggestion — can be delivered in MVP without any official-data dependency. The full macro-scored selector requires history and a `MacroSnapshot` aggregate (ADR-144) and is Phase 2/3. Extends ADR-125. Reuses ADR-139 (income base + floor row), ADR-140 (`ESSENTIAL_CATEGORIES`), ADR-141 (no feeds in MVP), ADR-138 (saving profile the suggestion recommends).

## Decision

**MVP: feed-free pure functions only. The user always picks the profile; the app suggests.**

Two pure domain functions shipped in `domain/models/strategy.py`:

```python
def income_pressure(income, floor) -> Literal["Constrained", "Stable", "Comfortable"]:
    ratio = income / floor
    if ratio < 1.3:   return "Constrained"
    if ratio <= 2.5:  return "Stable"
    return "Comfortable"

def suggest_strategy(income, floor, debt_min) -> Literal["conservative", "balanced", "aggressive"]:
    adequacy = income / floor
    debt_ratio = debt_min / income
    if adequacy < 1.3 or debt_ratio > 0.3: return "conservative"
    if adequacy > 2.5 and debt_ratio < 0.1: return "aggressive"
    return "balanced"
```

- `income_pressure`: ratio-to-floor segments (`Constrained <1.3×` / `Stable 1.3–2.5×` / `Comfortable >2.5×`). Replaces nominal income bands, which age badly under inflation.
- `suggest_strategy(income, floor, debt_min)`: adequacy (income÷floor) + debt-ratio → suggests conservative/balanced/aggressive. `debt_min` is a manual UI field (not persisted; YAGNI for MVP).
- Both are **suggestions only** — the user picks the saving profile. No `Recommendation` entity is created in the DB.
- The reader exposes `income`, `floor`, `pressure`, and `suggestedStrategy` from the `budget_income` row (ADR-139).
- The floor-before-percentages guard in `apply_saving_profile` (ADR-138) uses the floor from the same row.

**Deferred to Phase 2/3:**

- Volatility score (needs 6-month income history).
- FX-exposure score (needs per-account currency + history).
- Wage-gap score (needs official wage index — MacroSnapshot, ADR-144).
- Full `choose_strategy` with all four scores (needs all of the above).
- CBT/canasta-de-crianza auto-fetch for the floor (Phase 3 feed cost).

## Alternatives Considered

- **Full macro-scored selector in MVP**: run all four scores (adequacy, volatility, FX, wage-gap) from the start — why not chosen: volatility needs 6 months of history new users do not have; FX and wage-gap need official feeds (ADR-141); delivering an incomplete scorer that silently degrades on most users is worse than a simpler but correct one.
- **Nominal income bands**: e.g., "under ARS 500k → conservative" — why not chosen: nominal ARS bands become wrong within months under Argentine inflation; ratio-to-floor is stable because it tracks the actual cost of living.

## Consequences

- The strategy suggestion is available to all users from day one (no history requirement, no feed requirement).
- `income_pressure` and `suggest_strategy` are trivially unit-testable at the 1.3×/2.5× boundaries.
- The `debt_min` field is a stateless UI input — no new schema.
- Volatility/FX/wage-gap scoring is deferred cleanly; `suggest_strategy` signature can be extended in Phase 2 without breaking callers.
- Relates to ADR-138 (floor-guard uses the floor; strategy suggests a profile), ADR-139 (income + floor row feeds both functions), ADR-141 (no feeds needed for these pure functions), ADR-144 (full macro-scored selector is the Phase 2/3 extension).

## Status History

- 2026-06-30: accepted
