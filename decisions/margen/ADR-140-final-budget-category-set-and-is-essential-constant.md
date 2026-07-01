---
project: margen
adr: 140
title: Final reconciled budget-category set (LOCKED) and is_essential as a code constant
category: data
date: 2026-06-30
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-140: Final reconciled budget-category set (LOCKED) and is_essential as a code constant

## Context

ADR-125 established `KNOWN_CATEGORIES = Income, Food, Rent, Transport, Subscriptions, Health, Shopping, Entertainment, Services, Taxes, Fees, Other`. The budgets module expansion (ADR-137–ADR-139) and a complementary "rules-engine" design doc each proposed category changes. Three inputs needed reconciliation: (a) both design documents' category trees, (b) margen's current `KNOWN_CATEGORIES`, (c) what the product already covers via Accounts/Transfers/Monotributo (ADR-122/134/135). Principle: fewest meaningful expense categories; zero duplication with Accounts/Transfers/Monotributo. A budget category is an *expense* line only — money leaving the household for consumption or obligation. Extends ADR-125. Reuses ADR-027/083 (tolerant category strings), ADR-046/112/126 (Monotributo module), ADR-122/134/135 (accounts, transfers, net worth).

## Decision

**FINAL EXPENSE-CATEGORY SET — LOCKED 2026-06-30 (14 budgetable + Income + Other):**

`Housing, Utilities, Food, Social, Transport, Health, Education, Shopping, Entertainment, Subscriptions, Taxes, DebtService, FamilySupport, Fees` — plus `Income` (inflow, system only) and `Other` (uncategorized fallback).

**Locked definitions:**

- `Housing`: mortgage/rent · expensas · maintenance · property insurance. Works for owners and renters alike. Supersedes the narrower `Rent`.
- `Utilities`: electricity · gas · water · internet · mobile · garrafa. Kept separate from Housing — regulated/tariff clock applies here.
- `Food`: groceries and essential food at home only.
- `Social`: dining out · bars · cafés · outings. Discretionary dining/social, split from essential `Food` and from `Entertainment`.
- `Transport`: SUBE · fuel · tolls · ride-hailing · vehicle costs.
- `Health`: prepaga · obra social · medications · dentistry.
- `Education`: school fees · childcare · tutoring · courses. Separate INDEC division; reprices in lumps → sinking-fund candidate.
- `Shopping`: clothing · low-ticket household goods replacement.
- `Entertainment`: games · hobbies · one-off purchases.
- `Subscriptions`: recurring digital services (streaming, apps).
- `Taxes`: monotributo cuota · autónomos · Ganancias · IIBB (AGIP/ARBA) · ABL/municipal. Covers all government obligations. The **monotributo cuota is NOT dropped** — it is a real monthly tax expense in this category. The Monotributo *module* (ADR-046/112/126) separately tracks the income-vs-scale standing and feeds the tax-reserve bucket — a different concern from the cuota outflow.
- `DebtService`: loan instalments · card minimum payments · BNPL · overdraft interest. A recurring expense (obligation leaving the household). Distinct from the *debt-acceleration savings bucket* (ADR-138 extra payoff).
- `FamilySupport`: money given away — parent support · child support · cross-border remittances. **Not** account-to-account transfers (which are the Transfer feature, ADR-135).
- `Fees`: transfer/FX fees already created by ADR-135.

**Phased rollout (tolerant strings, no migration required — ADR-027/083):**

- **MVP delta**: rename `Rent` → `Housing` in `value_objects.py`, `types.ts`, `seed.ts`; keep `Rent` accepted as a tolerant alias (do NOT remove it; existing data is unaffected); add `Education`.
- **Phase 2 delta**: split `Services` → `Utilities`; add `Social`, `DebtService`, `FamilySupport`. Additive string additions only — no schema migration.

**`is_essential` as a code constant:**

`ESSENTIAL_CATEGORIES` is a pure code constant (`is_essential(cat: str) -> bool`). Essentials = `{Housing, Utilities, Food, Transport, Health, Education, Taxes, DebtService}`. Used by `compute_floor` (ADR-139) and the floor-before-percentages guard (ADR-138). Per-user override of essentiality is deferred (Phase 2).

**Dropped because the product already covers them:**

- `Savings-ARS`, `Savings-USD`, `Investments` → Accounts + savings buckets + Transfers (ADR-122/134/135). Not expenses.
- `Dollarized expenses` → per-account/per-transaction currency + `rate_type` tag (ADR-123/134). A USD Netflix charge is `Subscriptions` on a USD account.
- `Cash & informal` → Cash account + `evidence_quality` tag (ADR-134). Withdrawal is a Transfer to the Cash institution; the subsequent spend lands in its real category.
- `FX purchases / account-to-account moves` → Transfer feature (ADR-135). Not a transaction.

## Alternatives Considered

- **Per-user `Category` aggregate in MVP**: allow users to define their own categories — why not chosen: YAGNI; the research-aligned fixed set covers all Argentine household expense types; custom categories add significant model complexity for uncertain marginal value; deferred indefinitely.
- **Destructive `Rent` rename (remove the old string)**: drop `Rent` after renaming to `Housing` — why not chosen: breaks existing transaction data that already carries the `Rent` label; tolerant strings (ADR-027) make keeping the alias essentially free.
- **Treating the monotributo cuota as a dropped/non-category**: the cuota is a real monthly government obligation that leaves the household — why not chosen: the cuota is exactly what `Taxes` covers; conflating it with the Monotributo module's standing-tracking concern would create a false product gap and force users to record their cuota as `Other`.
- **Merging `Social` into `Entertainment`**: why not chosen: Argentine discretionary spend research clearly separates dining/outings (social, frequent, inflation-sensitive) from one-off purchases/hobbies; the split enables more accurate sinking-fund guidance.

## Consequences

- The category set is frozen at this definition; additions require a new ADR or an amendment to this one.
- `Rent` kept as a tolerant alias means no data migration; existing rows are silently valid.
- `ESSENTIAL_CATEGORIES` as a code constant means essentiality changes require a code PR (auditable), not a DB update.
- The dropped-because-covered-elsewhere rationale is durably recorded here, preventing category proliferation in future iterations.
- Phase 2 tolerant-string additions (`Utilities`, `Social`, `DebtService`, `FamilySupport`) carry no migration risk.
- Relates to ADR-125 (base category mechanism), ADR-138 (saving bucket keys are distinct from this set), ADR-139 (`compute_floor` uses `ESSENTIAL_CATEGORIES`), ADR-143 (strategy suggestion uses `is_essential`).

## Status History

- 2026-06-30: accepted
