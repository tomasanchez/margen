---
project: margen
adr: 138
title: Saving-profile presets as code constants; savings stored as kind=saving budget rows
category: architecture
date: 2026-06-30
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-138: Saving-profile presets as code constants; savings stored as kind=saving budget rows

## Context

ADR-125 (budgets) stores spend targets only; there is no first-class savings allocation. Argentine personal-finance research prescribes a pay-yourself-first approach with three fixed saving-rate templates (Conservative 20% / Balanced 30% / Aggressive 40%, each with fixed sub-bucket percentages). A new mechanism is needed to store saving allocations without a schema rework. Extends ADR-125. Reuses ADR-042 (actuals join), ADR-118 (CI auto-migrate), ADR-130 (per-user ownership).

## Decision

**Saving-profile presets are pure domain constants (code, not DB).** The three profiles and their sub-bucket breakdowns are research-fixed templates living in `domain/models/saving_profiles.py`:

- `SavingProfile{CONSERVATIVE, BALANCED, AGGRESSIVE}` with totals 20/30/40%.
- `PROFILE_BUCKETS`: closed `SAVING_BUCKETS` set (`EmergencyFund, DebtAcceleration, ShortTermGoals, MediumTermGoals, LongTermInvestment, FxHedge, MaintenanceReserve`); sub-bucket percentages transcribed verbatim from research.
- `MAINTENANCE_RESERVE_PCT = {Conservative: 5, Balanced: 2, Aggressive: 2}` — this spend-side reserve is stored as a `kind='saving'` `MaintenanceReserve` row.

**Saving rows are stored in the existing `budgets` table under a new `kind` discriminator.** The `kind` column is added and the `UNIQUE` constraint is widened:

```
budgets.kind  VARCHAR(10) NOT NULL DEFAULT 'spend'   -- 'spend' | 'saving'
UNIQUE(user_id, category, period)  →  UNIQUE(user_id, kind, category, period)
```

- Domain: closed `BudgetKind(StrEnum){SPEND, SAVING}`; `Budget.kind` defaults to `SPEND` (back-compatible; all existing rows gain `kind='spend'` via server default).
- `category` on saving rows = bucket key from `SAVING_BUCKETS` (closed set, no collision with spend categories).
- `apply_saving_profile` command: pure `compute_saving_rows(base, profile) -> {bucket: amount}`; handler writes saving rows in one UoW (idempotent re-apply via the widened UNIQUE). Requires a net-income base first (ADR-139).
- **Floor-before-percentages guard:** `apply_saving_profile` runs `floor_guard(income, floor, saving_total)` before writing rows. If savings would push spend below the household floor, the rows are still written but the response includes `floor_breached: true` (+ gap amount) → UI warns. **Warns, never silently rebalances**; the `fund_gap_from_nonessential_buckets` solver is deferred.
- **Reader split:** `_targets()` MUST filter `kind='spend'` (saving buckets have no expense actuals); add `_savings()`; `MonthlyBudget` grows `savings: list[SavingLine]`. One e2e guard confirms saving rows never appear in `categories[]`.
- Saving rows auto-reprice when the income base changes (percentage model); no per-bucket reprice math (see ADR-137).
- Migration: `kind` default `'spend'` back-fills all existing rows; `UNIQUE` swap via `batch_alter_table` (SQLite-safe, ADR-118).

## Alternatives Considered

- **Dedicated `savings_buckets` table in MVP**: separate aggregate with `target_amount`, `target_months`, `due_date`, `account_id` — why not chosen: over-models MVP needs; deferred to Phase 2 once the reprice loop proves its keep (Phase 2 extracts via `WHERE kind='saving'`).
- **Profiles stored in DB** (user-editable templates): why not chosen: profiles are research-derived constants, not user-configured values; storing them adds DB round-trips, schema, and a migration surface for data that changes only when the research changes (code PR is the right change mechanism).
- **Allocation solver that overrides the chosen profile**: automatically rebalances buckets across the floor constraint — why not chosen: silently overriding the user's profile choice violates the "never silent" stance (ADR-044/ADR-137); a warning is sufficient for MVP.

## Consequences

- Saving allocations are visible in the budget model without a new table; Phase-2 migration is a simple `WHERE kind='saving'` extract.
- The `kind` UNIQUE swap is the migration with the most DDL risk; it is kept SQLite-portable via `batch_alter_table` and covered by an integration test against real Postgres.
- An explicit e2e guard (saving rows must not leak into `categories[]`) protects the actuals join (ADR-042).
- Saving percentages auto-adjust when the user updates net income — no separate reprice needed.
- Relates to ADR-137 (reprice excludes saving rows), ADR-139 (income base required before apply), ADR-143 (floor-guard feeds strategy suggestion).

## Status History

- 2026-06-30: accepted
