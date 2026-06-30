---
project: margen
adr: 139
title: Net-income base and household floor as a per-month budget_income row; variable-income base is a computed suggestion
category: data
date: 2026-06-30
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-139: Net-income base and household floor as a per-month budget_income row; variable-income base is a computed suggestion

## Context

ADR-125 (budgets) has no notion of net spendable income; the budget floats against whatever category spend appears. Saving percentages (ADR-138) and the inflation reprice loop (ADR-137) both require an authoritative monthly income base. The household floor concept (ADR-143) is per-period and must align to the month navigator. Extends ADR-125. Reuses ADR-044 (suggest/confirm pattern), ADR-046/ADR-112 (Monotributo trailing-12), ADR-118 (CI auto-migrate), ADR-130 (per-user ownership).

## Decision

A dedicated per-`(user_id, period)` table stores net spendable income and the household floor:

```
budget_income
  id           UUID PK
  user_id      UUID NOT NULL  (ADR-130)
  period       DATE (month_start, ADR-040)
  amount       NUMERIC(18,2)  (ARS, ADR-025)
  currency     VARCHAR(3) DEFAULT 'ARS'
  source       VARCHAR(20) DEFAULT 'manual'   -- 'manual' | 'monotributo' (Phase 3)
  floor_amount NUMERIC(18,2)                  -- household floor, nullable
  floor_source VARCHAR(20)                    -- 'manual' | 'computed'
  created_at / updated_at
  UNIQUE(user_id, period)
  INDEX(user_id)
```

A small `BudgetIncome` aggregate (near-clone of `Budget`) owns this table.

**Net income semantics by profile (all manual in MVP):**

- Salaried: take-home pay after payroll withholdings. Single number, user-entered.
- Independent: `cash collected − tax/social-security reserve − business operating costs`. User enters the net figure manually; Phase 3 derives the reserve from the Monotributo trailing-12 standing (ADR-046/112, settings-gated ADR-126).
- Variable income: `lower_of(last-12-months / 12, lowest-recent-month)` — ships as a **computed suggestion** (`suggest_variable_base()`) that the user accepts into the manual `amount` field. Degrades gracefully to `None` when fewer than 12 months of history exist. Suggest/confirm pattern mirrors ADR-044. Automated true-up is Phase 3.

**Household floor:**

- `floor_amount` is co-located on the `budget_income` row (per-period; same reader call surfaces income + floor together).
- Populated manually (user types the essentials floor) or **computed** = `Σ(kind='spend' targets WHERE is_essential)` via pure `compute_floor(spend_lines, is_essential)` using the `ESSENTIAL_CATEGORIES` constant (ADR-140).
- `floor_source` records which method was used (`'manual'` or `'computed'`).
- The reader exposes `income`, `floor`, and `pressure` together (essentials-floor-vs-income readout for ADR-143).

**Endpoints (MVP):**

```
GET  /budget-income?month=YYYY-MM           → { month, amount, currency, source, floorAmount, floorSource }
PUT  /budget-income                         (UpsertBudgetIncome)
GET  /budget-income/suggested?month=YYYY-MM → { suggestedBase | null }
```

## Alternatives Considered

- **Single `app_settings` scalar**: store net income as a per-user constant — why not chosen: income is period-scoped (it changes month to month and must align to the month navigator); a singleton has the wrong cardinality.
- **`BudgetPlan` aggregate in MVP**: a snapshot/versioned plan entity — why not chosen: presupposes snapshot history and versioning machinery (Phase 2/3 concerns); the simple per-period row is sufficient for MVP and does not foreclose the Phase-2 plan aggregate.
- **Enforced variable-income base**: automatically compute and apply `lower_of(last-12/12, lowest-month)` as the authoritative base — why not chosen: requires ≥12 months of history to be meaningful; forcing it for new users would produce `None` or a misleading figure; the suggest/confirm pattern (ADR-044) keeps the user in control while providing the computed value as a convenience.

## Consequences

- Every percentage-based saving allocation (ADR-138) and the reprice loop (ADR-137) have a stable, honest income base to operate on.
- The floor co-location with income means a single reader call surfaces both, keeping the strategy suggestion (ADR-143) cheap.
- The `suggest_variable_base()` function is unit-tested against the lower-of logic + the <12-month degrade path.
- Phase 3: `source='monotributo'` links to the Monotributo service (ADR-046/112/126) without schema change.
- Relates to ADR-137 (reprice uses this base indirectly via saving rows), ADR-138 (apply-profile requires this row first), ADR-140 (`ESSENTIAL_CATEGORIES` used by `compute_floor`), ADR-143 (floor + income feed the strategy suggestion).

## Status History

- 2026-06-30: accepted
