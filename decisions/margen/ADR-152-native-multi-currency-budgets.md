---
project: margen
adr: 152
title: Native multi-currency budgets — USD or ARS denominated, spend from FX snapshot
category: business
date: 2026-06-30
status: accepted
supersedes: ADR-125
authors: [Tomas Sanchez]
---

# ADR-152: Native multi-currency budgets — USD or ARS denominated, spend from FX snapshot

## Context

ADR-125 defined budgets as ARS-only: targets, income, and spend actuals are all in ARS. The owner's primary income is USD and they want to plan and track spending in USD with accurate historical figures. Displaying ARS budgets to a USD-income household requires constant mental conversion and is lossy when the ARS/USD rate shifts mid-month. The FX snapshot model (ADR-148) now provides a stored `usd_amount` per transaction, enabling direct USD spend summation without read-time division. ADR-125's ARS-only constraint directly conflicts with this need.

**This decision reverses the currency cut in ADR-125.**

## Decision

Budgets are denominated in the user's preferred display currency — either ARS or USD — determined by the `preferredRateSource` / `displayCurrency` setting (ADR-151).

**Targets and income:** entered and stored natively in the budget currency. A USD budget stores USD targets and a USD income base. An ARS budget stores ARS targets and an ARS income base (ADR-125 behavior preserved for ARS users).

**Category spend actuals:**

- USD budgets: spend = `SUM(usd_amount)` over the budget period for each category, using the stored per-transaction snapshot (ADR-148). Direct summation; no read-time rate conversion.
- ARS budgets: spend = `SUM(amount)` over the budget period — unchanged from ADR-125.

**Null-snapshot handling (unconverted-note rule):** transactions lacking a `usd_amount` (pre-backfill rows, recently imported statement rows pending the rate-fill step per ADR-149) are **excluded** from USD spend totals for that category. Their count is surfaced as an "unconverted transactions" note on the budget surface — not silently dropped. This ensures the user knows their spend figure may be understated and can trigger a backfill (ADR-150).

**Derived figures** — remaining, Needs/Wants/Savings allocation (ADR-146), and left-to-assign (ADR-145) — are all computed in the budget currency.

## Alternatives Considered

- **Display-convert-only at today's MEP rate**: Keep ARS storage; convert to USD for display using the live MEP rate — lossy for historical months (the rate changes); targets entered in USD would need to be stored as ARS; confused provenance; rejected.
- **Keep ARS-only (ADR-125 unchanged)**: Does not meet the stated need — the owner explicitly wants USD-denominated budgeting with accurate historical spend; rejected.
- **Dual-currency budgets (parallel ARS + USD targets)**: Maintain two sets of targets per category — doubles the data model complexity with no additional insight over native denomination; rejected.

## Consequences

- Supersedes ADR-125's ARS-only currency constraint. The budget row schema (`currency` field already present per ADR-125) now carries real semantics: `'USD'` or `'ARS'`.
- The budget spend reader gains a USD path: `SUM(t.usd_amount) WHERE t.usd_amount IS NOT NULL` for USD budgets.
- The frontend threads the preferred currency through: targets entry, income entry, spend display, allocation bar, and the left-to-assign readout (ADR-145).
- The unconverted-note rule prevents silent understatement of USD spend and creates a user-visible prompt to run the backfill (ADR-150).
- ARS users are unaffected: `SUM(amount)` behavior from ADR-125 is unchanged for ARS-denominated budgets.
- Relates to ADR-025 (Decimal precision), ADR-044/133 (client-side FX), ADR-125 (superseded — ARS-only constraint lifted), ADR-145 (allocation bar computed in budget currency), ADR-146 (Needs/Wants grouping unchanged), ADR-148 (usd_amount snapshot enables direct summation), ADR-149 (import rate-fill step), ADR-150 (backfill eliminates unconverted rows), ADR-151 (preferred rate source / display currency setting).

## Status History

- 2026-06-30: accepted
