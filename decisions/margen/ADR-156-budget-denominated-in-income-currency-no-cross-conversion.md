---
project: margen
adr: 156
title: Budget is denominated in the income's currency; income is never cross-converted
category: architecture
date: 2026-07-01
status: accepted
supersedes: ADR-155
authors: [Tomas Sanchez]
---

# ADR-156: Budget is denominated in the income's currency; income is never cross-converted

## Context

ADR-155 introduced a display-conversion rule: all budget amounts (targets, income, allocation, left-to-assign) are converted to the user's preferred display-currency at the current live rate. In practice this produced a fiction the owner rejected — an ARS income shown as a USD figure implies dollars were bought at that moment, which they were not ("I don't buy USD instantly"). The approach also mixed currencies within a single budget period (income in one currency, targets potentially in another after conversion, spend using per-transaction snapshots) and complicated allocation math. The live-rate conversion of income and targets is not an accurate model of the owner's financial reality.

## Decision

- The budget is denominated in a SINGLE currency: the currency the user set their spendable income in (`budget_income.currency`). Default is ARS when income is unset.
- Income is NEVER cross-converted for display. An ARS income shows in ARS; a USD income shows in USD. The ADR-155 "preferred-rate-source live conversion" of income is removed.
- Targets are entered, stored, and shown in the budget currency (= income currency). No live-rate conversion of targets at display time.
- SPEND remains per-transaction historically accurate (ADR-148/ADR-152): for a USD budget, category spend = Σ stored `usd_amount`; for an ARS budget, Σ `amount`. This is the only place ARS↔USD values cross, and it uses each transaction's own captured snapshot rate — not a live display rate.
- Left-to-assign, allocation (Needs/Wants/Savings), savings, and the plan band are all computed natively in the budget currency.
- The Settings display-currency toggle NO LONGER drives the budget currency. It continues to govern Home net-worth and summaries display (ADR-056). The budget follows income.

## Alternatives Considered

- **ADR-155 display-toggle conversion of the whole budget at the live rate**: fabricates USD for ARS income, implying an instant currency purchase that did not occur; mixes currencies within a single budget view — rejected as factually incorrect for the owner's use case.
- **Keep the toggle but exempt only income from conversion**: still mixes currencies within one budget (targets in preferred currency, income in native) — rejected because it preserves the incoherence and complicates allocation math.

## Consequences

- The frontend drops the live-rate conversion of budget period and income: `convertBudgetPeriod`, `convertBudgetIncome`, and the budgets preferred-rate query become unnecessary and should be removed.
- The budget currency is read from the income's currency field; the UI renders all budget amounts in that currency without FX conversion.
- Targets must always be written in the income currency when created or edited.
- Simpler allocation math: all operands (income, targets, left-to-assign, savings) share a single currency unit.
- The per-transaction FX snapshot and backfill (ADR-148/ADR-150) remain required for spend accuracy.
- Relates to ADR-148 (per-transaction snapshot), ADR-149 (client-side FX capture), ADR-150 (historical backfill), ADR-152 (native multi-currency storage), ADR-056 (preferred display currency governs Home, not budgets).

## Status History

- 2026-07-01: accepted
