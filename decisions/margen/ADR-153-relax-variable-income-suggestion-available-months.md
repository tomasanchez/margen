---
project: margen
adr: 153
title: Relax variable-income suggestion — estimate from available months, not 12-month minimum
category: architecture
date: 2026-06-30
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-153: Relax variable-income suggestion — estimate from available months, not 12-month minimum

## Context

ADR-139 defined `suggest_variable_base()` to return `null` unless a full 12 months of inflow history exist, applying the conservative `lower_of(average, lowest)` formula over that window. Users with sparse ledgers — new users, or users who recently started recording transactions — receive no income estimate at all, leaving the budget income field empty and the zero-based allocation bar (ADR-145) non-functional until 12 months have elapsed. This creates a friction barrier that defeats the quick-start goal.

## Decision

**Amends ADR-139:** `suggest_variable_base()` estimates from **available months (≥ 1)** rather than requiring a full 12-month window.

The formula is unchanged: `lower_of(average_over_available_months, lowest_month_in_window)`. With a single month of history, average and lowest are the same figure — a conservative single-data-point estimate. The function returns `null` only when zero inflow history exists.

**Currency:** for USD budgets (ADR-152), the suggestion sums `usd_amount` on inflow rows (using the stored FX snapshot, ADR-148) to produce a USD estimate. For ARS budgets, it sums `amount` as before.

**Sparse-estimate labeling:** when fewer than 12 months of data back the estimate, the API response includes `{ suggestedBase, monthsAvailable, isSparse: true }`. The frontend labels the suggestion visibly (e.g., "Estimated from N month(s) of history") so the user understands it may not reflect their full income pattern.

## Alternatives Considered

- **Keep 12-month hard minimum (ADR-139 unchanged)**: Correct for well-established ledgers but leaves new users with no estimate — a significant onboarding friction; rejected.
- **Fixed fallback default (e.g., ARS 500,000 or USD 1,000)**: A hardcoded number is meaningless for most users and misleading; rejected.
- **Require at least 3 months**: A compromise minimum — arbitrary; one month is sufficient as a conservative lower bound via the `lower_of` formula; rejected.

## Consequences

- The income suggestion works from day one; new users get an actionable (if sparse) estimate immediately.
- The `isSparse` flag and `monthsAvailable` field are surfaced in the API response so the frontend can display an appropriate caveat — no silent overstatement of confidence.
- The conservative `lower_of` formula is preserved, so a sparse estimate is always pessimistic (safer than optimistic for budgeting).
- For USD budgets, the suggestion depends on inflow rows having a `usd_amount` snapshot; rows without a snapshot are excluded from the USD estimate (same unconverted-note pattern as ADR-152).
- Amends ADR-139 (the 12-month minimum floor is removed; formula and endpoint contract are otherwise unchanged). Relates to ADR-044 (suggest/confirm pattern), ADR-148 (usd_amount for USD inflow summation), ADR-151 (preferred currency determines which sum path is used), ADR-152 (USD budget income path).

## Status History

- 2026-06-30: accepted
