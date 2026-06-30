# Product Deliverable — Argentina-Aware Budgets

**Owner:** Tomas Sanchez · **Author role:** PM + economist · **Date:** 2026-06-30 · **Status:** Draft for architecture review
**Supersedes/expands:** ADR-125 (per-category monthly targets). **Sits alongside:** Reports (#52, ADR-128), Forecast (#53, ADR-129).
**Source research:** `C:\Users\imtom\Downloads\personal-budgeting-and-saving.md` (INDEC May 2026: 2.1% m/m, 33.2% y/y CPI; REM 23.3% expected 12-mo inflation; REM FX ~ARS 1,422/USD Jun-26 → ~ARS 1,658/USD Dec-26) **+** `C:\Users\imtom\Downloads\budget-design.md` (the "rules-engine" vision — household floors via INDEC CBT + canasta de crianza, income-pressure segments, trigger-based rebalancing, scenario simulation, macro-snapshot/provenance — folded in §7).

---

## 1. Vision / Problem

Today's Budget module (ADR-125) is a **flat nominal per-category monthly target vs actual spend, no rollover, ARS-only**. That model fails an Argentine household on three fronts: (1) **inflation drift** — a cap set in January is silently mugged by ~2% monthly CPI, so by March the budget describes a price level that no longer exists; (2) **gross-vs-net confusion** — the module budgets against whatever spend appears, with no notion of *net spendable income* after tax/social-security reserves, which is the only honest base for an independent worker; and (3) **savings as leftover, not a job** — there are no explicit emergency/goal/FX buckets, so saving is whatever survives the month instead of a pay-yourself-first allocation. The deliverable turns Budgets from a static spend-cap sheet into an **inflation-aware, income-based plan with first-class savings buckets** — the thing the research says actually works in Argentina (zero-based + pay-yourself-first + envelope caps on volatile categories).

---

## 2. The Conceptual Model

Six building blocks. Each maps onto existing primitives where possible (reuse over reinvent).

### 2.1 Net spendable income base

The base every percentage is applied to. **Not** gross collections.

| Profile | Base formula |
|---|---|
| **Salaried** | Take-home pay (after payroll withholdings). Single number, entered by user. |
| **Independent** | `cash collected − tax/social-security reserve − business operating costs`. The tax reserve can be **derived from the existing Monotributo module** (trailing-12-month standing, AFIP scale cuota — `service_layer/monotributo.py`, ADR-046/112) rather than re-entered. |
| **Variable income** | **Lower of** `last-12-months income ÷ 12` **and** `lowest recent month`. Essentials are budgeted from this conservative floor; better-than-base months feed a **true-up** allocation (emergency / debt / pre-funded annual expenses). |

> **Why this matters:** gross income lies once AFIP/provincial obligations haven't been carved out. The independent base is the research's headline rule (`Spendable net = cash collected − tax/social-security reserve − business costs`).

### 2.2 Saving profiles (3 templates)

Applied to **net spendable income**. These are the research's exact tables — ship them as selectable presets.

| Bucket | Conservative (20%) | Balanced (30%) | Aggressive (40%) |
|---|---:|---:|---:|
| Emergency fund | 5% | 7% | 8% |
| Debt acceleration | 5% | 7% | 10% |
| Short-term goals | 3% | 4% | 5% |
| Medium-term goals | 2% | 4% | 5% |
| Long-term investment | 3% | 5% | 7% |
| USD / FX hedge | 2% | 3% | 5% |
| **Total to savings** | **20%** | **30%** | **40%** |

Plus an **inflation/maintenance reserve** on the *spending* side: **5% (Conservative) / 2% (Balanced) / 2% (Aggressive)** of net income.

**Best fit:** Conservative = heavy essentials / unstable or informal income / early cleanup. Balanced = stable salaried or predictable freelance (the default). Aggressive = strong income, controlled fixed costs, no revolving debt.

**Sequencing guardrail (ship as guidance copy, not a hard gate):** 1st goal = one month of essentials → 2nd = kill expensive consumer debt → 3rd = full 4–6 month emergency reserve → 4th = long-horizon investing. "Aggressive percentages when housing+food already eat half your take-home is aspirational theater" — surface a gentle warning when essentials exceed ~50% and the user picks Aggressive.

### 2.3 Bucket / goal taxonomy

Buckets are the savings counterpart to spending categories. Each has: `type`, optional `target_amount`, optional `target_months` (emergency), optional `due_date` (goals), `currency` (ARS or USD), and a `% of net income` contribution.

| Bucket | Definition | Target rule |
|---|---|---|
| **Emergency fund** | Liquid buffer for income shocks | `essential monthly expenses × target months`. Default **4–6 months**; **6–9** if income is irregular/informal. |
| **Debt acceleration** | Extra payment above minimums on expensive debt | `payoff months ≈ debt balance ÷ monthly acceleration`. Outranks investing until expensive debt is dead. |
| **Short-term goals** | < ~12 mo (trip, appliance) | `month count = (target − current) ÷ monthly contribution`. |
| **Medium-term goals** | ~1–3 yr | Same; consider FX-hedged if liability is USD-linked. |
| **Long-term investment** | > 3 yr / retirement-ish | Matched to instrument by horizon. |
| **Inflation / maintenance reserve** | Sinking pool for rate shocks, annual fees, appliance replacement | Funded at the profile % (2–5%). |
| **USD / FX hedge** | Deliberate hard-currency exposure | `% of net income`; held in a USD account. Decide on purpose, not by panic. |

> **Instrument guidance is informational only** (plazo fijo / UVA-CER / bonds / MEP / CCL / USD cash), shown as a tooltip mapping horizon→instrument. **Margen does not recommend products** (see §6 out-of-scope and ADR-120 non-goals).

### 2.4 Sinking funds

Turn non-monthly costs into monthly lines so school fees, insurance renewals, and annual taxes stop ambushing the operating account.

`monthly sinking-fund amount = annual or periodic cost ÷ months until due`

Model as a lightweight bucket variant (`type = sinking`, with `annual_cost` + `due_date`) feeding the **Inflation/maintenance reserve** family or a named goal.

### 2.5 Category taxonomy

> **Superseded by §7.1.** The category reconciliation originally drafted here has been replaced by the **final merged set in §7.1**, which reconciles three inputs: the two research docs' category trees, margen's current `KNOWN_CATEGORIES`, and what the broader product already covers via Accounts/Transfers/Monotributo. Summary of the final decision: keep **Food, Transport, Health, Entertainment, Subscriptions, Fees, Other**; rename `Rent`→**Housing**; split `Services`→**Utilities** + keep Eating-out distinct from Food; add **Education**, **DebtService**, **FamilySupport**; keep `Taxes` for non-monotributo taxes only; and **DROP** Savings-ARS / Savings-USD / Investments / Dollarized-expenses / Cash-informal / FX-purchases as categories because the product already models them as Accounts, Transfers, per-account currency, and tags. See §7.1 for the full mapping table and rationale.

### 2.6 Monthly inflation-reprice loop

The behavioral core. Right after each INDEC CPI release, reprice caps:

`next-month cap = this-month cap × (1 + monthly inflation assumption) + known step-ups`

- **Inflation assumption** is a single user-set monthly % (seed suggestion from REM ~1.8–2.1%/mo, editable). One number drives the whole budget.
- **Step-ups** = known discrete jumps (rent contract index/ICL, tariff increases) entered per-category.
- **Cadence:** weekly light category-drift check; monthly full reprice. The app **prompts** "reprice now?" when a new month opens; the user reviews and one-click applies (never silent).
- Savings buckets contributions, being a `%` of net income, **auto-reprice** when the user updates their net-income base — no per-bucket math.

---

## 3. Scope & Phasing

Decisive cut: **MVP is the inflation reprice loop + saving-profile presets**, because those deliver the two things the flat module can't (drift defense, savings-as-allocation) with the least new machinery. Buckets-as-real-accounts and tax-reserve automation are Phase 2/3.

### MVP — "Inflation-aware percentage budget" (beyond today)

| Capability | Value | Effort |
|---|---|---|
| **Net-income base field** (salaried take-home; independent = manual net) per month | Anchors everything to honest income, not gross | **S** |
| **Saving-profile presets** (Conservative/Balanced/Aggressive) that seed savings-bucket targets as % of net income, stored as budget rows of a new `kind = saving` | Savings become explicit allocations, pay-yourself-first | **M** |
| **Monthly reprice action** — one inflation % + per-category step-ups → `cap × (1+infl) + step-up`, applied on user confirm at month rollover | Kills inflation drift; the single highest-value change | **M** |
| Category change: rename `Rent`→`Housing`, add `Education` (MVP subset of §7.1) | Matches AR reality / INDEC divisions | **S** |
| **Household-floor readout** (manual floor entry; show essentials-floor vs net income) — from budget-design.md §7.2 | Grounds the plan in survival reality, prevents underfunding essentials | **S** |
| **Strategy suggestion** (adequacy = income÷floor + debt-ratio → suggest conservative/balanced/aggressive; user still picks) — §7.2 | Trust/retention; ratio-to-floor beats nominal bands | **S** |
| **Floor-before-percentages** allocation rule (raise essentials to floor before applying preset %) — §7.2 | Correctness: a preset must never underfund survival | **S** |
| Reprice/preset surfaces in i18n (en/es, namespace `budgets`) | Consistency with ADR-100/101 | **S** |

**Explicitly MVP-deferred:** rollover/envelope balances, buckets-as-accounts, tax-reserve automation, FX-denominated goals, variable-income true-up automation, forecast integration.

### Phase 2 — "Buckets as real money"

| Capability | Value | Effort |
|---|---|---|
| **First-class Savings Bucket aggregate** (emergency/goal/sinking/FX) with target_amount, target_months, due_date, currency; progress tracking | Goals with real targets and ETAs (`month count = (target−current)÷contribution`) | **L** |
| **Funding a bucket = a Transfer to a savings Account** (reuse ADR-135 Transfer; bucket references a destination `account_id`) | Saving is observable in net worth, not a notional line | **M** |
| **Emergency-fund auto-target** = essential spend × months (4–6, or 6–9 irregular) | Self-calibrating target | **S** |
| **Sinking funds** (annual cost ÷ months-to-due) | Lumpy costs stop ambushing | **M** |
| Essentials>50% + Aggressive warning; sequencing guidance copy | Keeps profiles honest | **S** |

### Phase 3+ — "Independent-grade + forward-looking"

| Capability | Value | Effort |
|---|---|---|
| **Tax-reserve bucket auto-fed from Monotributo** (trailing-12 standing → reserve %); settings-gated like ADR-126 | Independent net income computed for them | **M** |
| **Variable-income true-up**: base = lower(last-12/12, lowest month); surplus months auto-route to buckets | Survives weak months | **M** |
| **USD/FX-denominated goals** with live MEP via `fxClient.fetchSuggestedMepRate()` (ADR-044/133) | Protect medium/long goals from peso depreciation | **M** |
| **Inflation-aware forecast** — extend the pace-based projector (ADR-129) with the monthly inflation assumption | Honest forward picture | **L** |
| Optional **INDEC/BCRA feed** to pre-fill the inflation % suggestion (see §5 risks) | Less manual upkeep | **L** |

**Roadmap fit:** MVP/Phase 2 expand ADR-125 *without schema rework on the existing budgets table* (ADR-125 explicitly allows this). Reports (#52, CSV-first per ADR-128) and Forecast (#53, ADR-129) stay queued; the inflation assumption introduced here is the natural input that later upgrades the forecast from pace-based to inflation-adjusted.

---

## 4. What Changes vs Today

### Keep
- The `budgets` table shape `(id, user_id, category, period, amount, currency)` + `UniqueConstraint(user_id, category, period)` — extend, don't replace.
- The reader join pattern: targets ⋈ `month_category_expense_totals` (ADR-042) → `MonthlyBudget`. Reuse for spend categories untouched.
- Month-navigator alignment (ADR-040/041), per-user ownership (ADR-130), calm-error UX (ADR-037), non-color status cues (ADR-019), Decimal-string money (ADR-025/034), the `budgets` i18n namespace.
- `BudgetMeter` / `BudgetRow` / `derive.ts` pure math — reused as-is for spending rows.

### Extend
- Add a **`kind` discriminator** to budget rows (`spend` | `saving`) so saving-bucket allocations live in the same table (no new schema for MVP savings). Existing rows default to `spend`.
- Add a per-user **`budget_income`** concept (net spendable income per month) — small new row/table keyed `(user_id, period)`.
- Add a **reprice service**: pure function `next_cap = round(cap × (1+infl)) + step_up`; entrypoint applies it across the month's `spend` rows on user confirm.
- `BudgetsPage`: add net-income header, profile-preset selector, and a "Reprice for {month}" review action. Add a **Savings** section listing `kind=saving` rows with profile %.
- Category list (MVP subset of the §7.1 final set): rename `Rent`→`Housing` and add `Education` in `value_objects.py`, `types.ts`, `seed.ts`. `Utilities`, `Social`, `DebtService`, `FamilySupport` follow in Phase 2 (low-risk — categories are tolerant strings, ADR-027/083).

### Replace / restructure (Phase 2+)
- Promote savings buckets out of the flat budget row into a **dedicated `savings_buckets` aggregate** once targets/due-dates/account links are needed — at that point the `kind=saving` rows migrate into it. Follow the cosmic-python aggregate+repo+UoW pattern (as Account/Transfer/Budget do).

---

## 5. Open Questions & Risks (for the owner's follow-up research)

**Maintenance under Argentine instability is the central risk.** The whole model lives or dies on how the inflation %, FX, and rate inputs are sourced and refreshed.

1. **Where do inflation inputs come from?** MVP recommendation: **manual single monthly %**, seeded with a REM-derived suggestion shipped as a constant, user-editable. A **live INDEC CPI feed** is attractive but: INDEC has no clean official JSON API (scraping/3rd-party = fragility + legal/ToS exposure + an ops surface that breaks on their schedule). **Recommend manual for MVP**; evaluate a feed only in Phase 3 and treat it as a *suggestion*, never an auto-apply. (Mirrors the dolarapi pattern: fetch, suggest, user confirms — ADR-044.)
2. **How automated is repricing?** Recommendation: **prompted, never silent.** App detects month rollover, offers a one-click reprice preview; user confirms. A static budget ages like milk, but a silently-mutating one erodes trust.
3. **FX source.** Already solved: `fxClient.fetchSuggestedMepRate()` (dolarapi MEP/Official, client-side, calm-degrade to null per ADR-133). Reuse it for FX-bucket valuation. **No new server-side dependency.**
4. **Currency of budgets / goals.** MVP stays **ARS-only** (ADR-125). Open question: should medium/long goals be **USD-denominated** (research says yes when the liability is USD-linked)? Phase 3 introduces per-bucket `currency` + live MEP display. Net-worth FX drift (ADR-132/133) is the accepted known limitation.
5. **Do savings buckets = real Accounts/Transfers?** Strong recommendation: **yes, in Phase 2.** Funding a bucket should create a **Transfer** (ADR-135) to a savings Account, so the money is observable in net worth and not a phantom line. MVP can keep buckets notional (% allocations) to ship fast; Phase 2 wires them to `account_id`. Decision needed: is a bucket a *view over* an account, or its own balance that reconciles against the account?
6. **Tax-reserve coupling to Monotributo.** The reserve % can be auto-derived from the trailing-12 standing, but only for monotributo-enabled users (ADR-126 gate). Salaried/autónomo/IIBB cases need manual entry. Open question: how much tax logic do we own vs. leave manual? Recommend manual-with-monotributo-assist.
7. **Variable-income base.** `lower(last-12/12, lowest month)` needs ≥12 months of ledger history to be meaningful; degrade gracefully for new users (manual base).

### Explicitly OUT of scope (liability + focus)
- **No investment-product recommendations / financial advice.** Instrument guidance is *informational mapping of horizon→instrument type only*. Margen never says "buy this plazo fijo / this bond." This is a hard line (ADR-120 non-goals; advice = regulatory/liability exposure).
- **No live bank-sync / open-banking** (ADR-120) — entry stays manual or PDF-import.
- **No tax filing / AFIP submission** — Margen reserves and informs; it does not file.
- **No rollover/envelope running balances in MVP** (ADR-125/132 #5) — Phase 2 if validated.
- **No automated INDEC scraping in MVP** — manual % with suggestion.

---

## 6. Recommended Next Step

**Architect designs the MVP slice first** — specifically the data + service shape for (a) the **net-income base** `(user_id, period)`, (b) the **`kind` discriminator** on budget rows so saving-profile allocations reuse the existing `budgets` table, and (c) the **pure reprice function** `next_cap = cap × (1+infl) + step_up` plus its confirm-on-rollover entrypoint. Capture **four** new ADRs (none exist today): **inflation-reprice model**, **saving-profile presets + savings as `kind` rows**, **net-income base / variable-income rule**, and the **final merged budget-category set (§7.1)** — the last is the owner's explicit main ask and should be recorded as a `data` ADR so the dropped-because-covered-elsewhere rationale is durable. Apply the MVP category change (`Rent`→`Housing`, add `Education`) in the same slice. Defer the `savings_buckets` aggregate, Transfer-funding, the household-floor engine, macro snapshots, and trigger-based rebalancing to Phase 2/3 designs once the MVP proves the reprice loop earns its keep.

Run this through `/deep-plan` to land the ADRs before any code.

---

## 7. Incorporating budget-design.md (the "rules-engine" vision)

`budget-design.md` is a more ambitious design: it treats the budget as a **rules engine over a volatile macro regime** — household floors from official baskets, income-pressure segments as ratios-to-floor, a strategy *recommendation* engine, trigger-based rebalancing, scenario simulation, and a macro-snapshot/provenance/confidence layer fed by official sources (INDEC/BCRA/ARCA). Most of it overlaps §2–§6. The genuinely-new, worthwhile parts are folded below, **MVP-first** — but the bulk of the rules-engine/macro-feed machinery is correctly Phase 2/3, because the official-data feeds are a large maintenance and legal cost the owner is still researching (kept **suggestion-only, never hardcoded**; see §7.3).

### 7.1 FINAL merged budget-category set (the owner's main ask)

Three inputs reconciled: (a) both docs' category trees, (b) margen's current `KNOWN_CATEGORIES` = `Income, Food, Rent, Transport, Subscriptions, Health, Shopping, Entertainment, Services, Taxes, Fees, Other`, (c) **what the product already covers elsewhere** (Accounts incl. a Cash institution, Transfers + funding, per-account/per-transaction currency, the Monotributo module). **Principle: fewest meaningful expense categories; zero duplication with Accounts/Transfers/Monotributo.** A budget category is an *expense* line only — money that leaves the household for consumption or obligation. Anything that is a *movement of the user's own money* (savings, investments, FX purchase, transfer-to-cash) is **not** a category.

| Doc category (budget-design.md) | Decision | Where it lives / why |
|---|---|---|
| Housing (rent, mortgage, expensas, maintenance, property tax, insurance) | **RENAME existing** `Rent` → **`Housing`** | Rent is one line of housing. Keep `Rent` accepted as a tolerant alias (ADR-027). |
| Utilities & regulated services (electricity, gas, water, internet, mobile, garrafa) | **SPLIT existing** `Services` → **`Utilities`** | `Services` is ambiguous; `Utilities` is the INDEC-aligned essential. Carries `subsidy_status` tag later (§7.2). |
| Food at home | **KEEP** `Food` | — |
| Social — eating out, bars, cafés, outings | **ADD `Social`** | Discretionary dining/social, split from essential groceries (`Food`) and from `Entertainment` (games/hobbies/one-off). |
| Transport (SUBE, fuel, tolls, ride-hailing, vehicle) | **KEEP** `Transport` | — |
| Health (prepaga, obra social, meds, dentistry) | **KEEP** `Health` | — |
| Education & childcare | **ADD `Education`** | Separate INDEC division; reprices in lumps → sinking-fund candidate. |
| Personal / clothing / household goods | **KEEP** `Shopping` | Covers clothing + low-ticket home replacement. |
| Entertainment / recreation / subscriptions-above-essentials | **KEEP** `Entertainment` | — |
| Streaming / app subscriptions | **KEEP** `Subscriptions` | Distinct recurring digital; keep separate from `Utilities`. |
| Taxes & social security (monotributo cuota, autónomos, Ganancias, IIBB/AGIP/ARBA, ABL/municipal, domestic-worker) | **KEEP `Taxes`** — all government obligations | **Monotributo cuota IS this category** (a real monthly tax expense). The Monotributo *module* (ADR-046/112/126) separately tracks the income-vs-scale standing + feeds the tax-*reserve* bucket (§2.1) — a different concern from the cuota outflow. Includes ABL (CABA municipal) + AGIP/ARBA IIBB. |
| **Debt service** (card payment, loan instalments, BNPL, overdraft) | **ADD `DebtService`** | A real recurring *expense* (interest + principal leaving the household). Distinct from the *debt-acceleration savings bucket* (extra payoff, §2.2). Decision: **category for the obligation, bucket for the extra**. |
| **Transfers & remittances / family support** | **ADD `FamilySupport`** *(expense)* — but distinguish from account-to-account transfers | Money *given away* (parents, child support, cross-border) is an expense → `FamilySupport`. Money moved between the *user's own* accounts is **not** this — it is the **Transfer** feature (ADR-135). |
| Transfer fees | **KEEP** `Fees` | Already created by ADR-135 (fees-as-expenses). |
| **Dollarized expenses** (USD rent, imported subs, foreign platforms) | **DROP as category** | Currency is **per-account / per-transaction** (ARS/USD, ADR-123/134) + a `rate_type` tag (§7.2), **not** a category. A USD Netflix charge is `Subscriptions` on a USD account — tagged `mep`, not a separate "Dollarized" line. |
| **Savings in ARS** (emergency, sinking, plazo fijo, remunerated acct) | **DROP as category** | Modeled as **savings buckets** (§2.3) funded by a **Transfer** to an ARS savings **Account** (ADR-135). Not an expense. |
| **Savings in USD** (cash dollars, USD bank, MEP bucket) | **DROP as category** | Modeled as the **USD/FX-hedge bucket** + a USD **Account**; funded by a Transfer / FX purchase. Not an expense. |
| **Investments** (bonds, CEDEARs, FCI, broker) | **DROP as category** | Modeled as the **long-term-investment bucket** + a (future) investment Account; net worth covers it (ADR-122 defers non-liquid). Not an expense, and **no product recommendations** (§6 out-of-scope). |
| **Cash & informal economy** (ATM withdrawals, ferias, non-invoiced) | **DROP as category** | A **withdrawal** is a Transfer to the **Cash** institution/Account (ADR-134 `cash` type); the subsequent *spend* lands in its real category (Food, etc.) tagged `evidence_quality = estimated/cash`. "Cash" is a payment channel + account, **not** a spend category. |
| FX purchases / account-to-account moves | **DROP as category** | The **Transfer** feature (ADR-135) — explicitly "not a transaction." |
| `Income` | **KEEP** (system) | Not a budgetable expense category; it is the inflow side. |
| `Other` | **KEEP** (fallback) | Uncategorized bucket; ADR-042 buckets nulls as "Uncategorized". |

**FINAL EXPENSE-CATEGORY SET — LOCKED 2026-06-30 (14 budgetable + Income + Other):**
`Housing, Utilities, Food, Social, Transport, Health, Education, Shopping, Entertainment, Subscriptions, Taxes, DebtService, FamilySupport, Fees` — plus `Income` (inflow) and `Other` (fallback).
Locked definitions: **Housing** = mortgage/rent · expensas · maintenance · insurance (works for owners & renters); **Utilities** = electricity/gas/water + internet/mobile (kept separate — regulated/tariff clock); **Social** = dining out/bars/cafés/outings; **Entertainment** = games (Steam)/hobbies/one-off purchases; **Subscriptions** = recurring digital services; **Taxes** = monotributo cuota · autónomos · Ganancias · IIBB (AGIP/ARBA) · ABL/municipal; **DebtService** = loans/installments/overdraft (kept for multi-user; card payoffs are Transfers, not this).

**Dropped because the product already covers them:** Savings-ARS, Savings-USD, Investments → **Accounts + savings buckets + Transfers** (ADR-122/134/135). Dollarized-expenses → **per-account/transaction currency + `rate_type` tag** (ADR-123/134). Cash & informal → **Cash account + `evidence_quality` tag** (ADR-134). FX purchases / transfers → **Transfer feature** (ADR-135). (The monotributo *cuota* is NOT dropped — it's a real tax expense and lives in the **Taxes** category; the **Monotributo module** separately tracks the income-vs-scale *standing* — ADR-046/112/126.)

**MVP category delta:** rename `Rent`→`Housing`, add `Education` (matches §3 MVP). **Phase 2 delta:** split `Services`→`Utilities`, add `Social`, `DebtService`, `FamilySupport`. Each is a tolerant-string addition across `value_objects.py`, `types.ts`, `seed.ts` (ADR-027/083) — no schema migration.

### 7.2 New ideas folded in — phase decision per item

| Idea (budget-design.md) | Phase | Why |
|---|---|---|
| **Household floor concept** (`floor = CBT + actual housing + debt minimums + health minimum + child costs + essential transport`) | **MVP (concept only)** | Ship as an *informational* "your essentials floor vs your income" readout, with floor entered/estimated **manually**. The CBT/canasta-de-crianza *auto-fetch* is Phase 3 (feed cost, §7.3). The concept is too valuable to omit — it's what stops a preset from underfunding survival. |
| **Strategy *recommendation*** (adequacy = income÷floor, volatility, debt-ratio, FX-exposure → suggest conservative/balanced/aggressive) | **MVP (lightweight)** | A one-screen suggestion using inputs the user already gives (net income, floor, debt) — `adequacy < 1.3 → conservative`, `> 2.5 & stable → aggressive`, else balanced. Pure function, no feed. Big trust/retention win; cheap. The user still picks. |
| **Floor-before-percentages allocation** (fund the floor first, then apply preset %; if preset essentials < floor, top up from non-essential buckets) | **MVP** | This is a correctness fix to §2.2, not new machinery: a preset must never underfund essentials. Fold the "if essentials < floor, raise to floor and reduce savings buckets" rule into the allocation step. |
| **Income-pressure segments as ratio-to-floor** (Constrained <1.3×, Stable 1.3–2.5×, Comfortable >2.5×) | **MVP (drives the suggestion)** | Replaces nominal income bands (which age badly under inflation) with ratios. Reuses the adequacy score above; no extra cost. |
| **Multi-currency `rate_type` tag** on lines/transactions (official/mep/ccl/blue) | **Phase 2** | Useful provenance for USD-linked lines; ride on the per-account currency already in ADR-123/134. Not needed for the ARS-only MVP. |
| **Trigger-based rebalancing** (overspend >10%×2mo, inflation accel >1pp, FX shock >5%, subsidy/tax-rule change → propose rebalance) | **Phase 2** | High value but needs the reprice loop + macro history first. MVP reprices on a single manual inflation %; triggers come once macro snapshots exist. |
| **Scenario simulation** (currency shock, regulated-price catch-up, hyperinflation repricing) | **Phase 3** | "See fragility before reality humiliates you" — excellent, but a forward-modeling feature that should build on the Forecast slice (#53/ADR-129), not the budget MVP. |
| **MacroSnapshot entity** (immutable CPI/wage/FX/rates/subsidy/tax snapshot for recalculation without mutating history) | **Phase 2/3** | The right engineering backbone for everything dynamic — but only worth building once there's a feed to populate it. Until then the single manual inflation % is the "snapshot." |
| **Provenance / confidence layer + source-priority/fallback** (official→provincial→media→private; show whether a number is synced/estimated/official/unofficial) | **Phase 3** | "In a country with multiple valid prices, provenance is part of the product." True, and it pairs with the macro feed. Premature before feeds exist; the MVP's one number is user-entered (implicitly "user estimate"). |
| **Override governance** (reason code, source snapshot, old/new value, expiry, audit) | **Phase 3** | Matters only once *automation* proposes changes (rebalancing). MVP changes are all user-driven, so no governance surface needed yet. |
| **Split emergency fund** (1–2 mo liquid ARS → 2–4 mo ARS/UVA → resilience slice in USD) | **Phase 2** | A refinement of the emergency-fund bucket (§2.3) once buckets map to real Accounts; informational guidance can appear in MVP copy. |
| **Tenure/household-aware default templates** (renter vs owner housing weights; family-with-children) | **Phase 3** | Needs the onboarding profile (household_size, ages, tenure) the second doc proposes — a larger onboarding build. Defer. |

### 7.3 The macro-feed question (unchanged headline risk — now sharper)

`budget-design.md` wants official feeds (INDEC CPI + baskets, BCRA FX/rates/CER/UVA/ICL, ARCA tax rules, subsidy rules) refreshed daily/monthly/event-driven, with coded per-variable fallback. This is the **single largest maintenance and legal/ops cost** in the whole vision and the owner is still researching it. **Recommendation stands and is reinforced:**

- **MVP:** one **manual** monthly inflation % (REM-seeded suggestion) + the existing client-side dolarapi MEP (`fxClient.fetchSuggestedMepRate()`, ADR-044/133). No official feed.
- **Feeds are suggestion-only, never hardcoded into accounting** — exactly the doc's own "truth over vibes / parameterize, never hardcode" stance and margen's dolarapi pattern (fetch → suggest → user confirms). A stale/failed feed degrades to the last user value with a "pending official release" label, never silently switches sources.
- The blue dollar and any unofficial rate are **stress-test only** unless the user explicitly opts them into planning, with provenance shown (Phase 3 provenance layer).
- INDEC/ARCA have **no clean official JSON API**; BCRA does expose statistical APIs. So *if* a feed is built, BCRA market data (FX/rates) is the cheapest first candidate (Phase 2 `rate_type`/snapshot), and INDEC CPI/baskets stay manual-with-suggestion longest (Phase 3). The legal/ToS surface of scraping INDEC/ARCA is the owner's open research item.

**Net effect on MVP scope:** unchanged from §3 — net-income base + saving-profile presets + manual inflation reprice + the `Rent`→`Housing`/`Education` category change — **plus** two cheap additions from this doc: the **household-floor readout (manual)** and the **strategy-suggestion (ratio-to-floor)**, both pure-function and feed-free.
