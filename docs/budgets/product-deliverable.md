# Product Deliverable — Argentina-Aware Budgets

**Owner:** Tomas Sanchez · **Author role:** PM + economist · **Date:** 2026-06-30 · **Status:** Draft for architecture review
**Supersedes/expands:** ADR-125 (per-category monthly targets). **Sits alongside:** Reports (#52, ADR-128), Forecast (#53, ADR-129).
**Source research:** `C:\Users\imtom\Downloads\personal-budgeting-and-saving.md` (INDEC May 2026: 2.1% m/m, 33.2% y/y CPI; REM 23.3% expected 12-mo inflation; REM FX ~ARS 1,422/USD Jun-26 → ~ARS 1,658/USD Dec-26).

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

### 2.5 Category taxonomy — research → existing app categories

The app's canonical set (`domain/models/value_objects.py` `KNOWN_CATEGORIES`, mirrored in `apps/web/src/mock/types.ts`) today is:
`Income, Food, Rent, Transport, Subscriptions, Health, Shopping, Entertainment, Services, Taxes, Fees, Other`.
Categories are tolerant strings (ADR-027/083), so additions are low-risk but must be added to all canonical lists (value_objects.py, types.ts, seed.ts).

| Research category | Map to existing | Action |
|---|---|---|
| Housing (rent/mortgage, building charges, repairs, insurance) | `Rent` | **Rename/extend → `Housing`** (rent is one line of housing; keep `Rent` as alias for back-compat). |
| Utilities & connectivity | `Services` + `Subscriptions` | Keep; `Services` = utilities, `Subscriptions` = streaming/apps. Adequate. |
| Food at home | `Food` | Keep. |
| Transport | `Transport` | Keep. |
| Healthcare & insurance | `Health` | Keep (covers obra social/prepaga, meds, copays). |
| **Education & childcare** | — | **Add `Education`** (separate INDEC division; reprices in lumps → sinking-fund candidate). |
| Personal & household | `Shopping` | Keep. |
| Entertainment & eating out | `Entertainment` | Keep. |
| **Remittances / family support** | `Other` today | **Add `FamilySupport`** (optional) — stops "helping family" cannibalizing rent. Low priority. |
| Taxes & social security | `Taxes` | Keep for paid taxes; **tax *reserve* is a savings bucket, not a spend category** (see §2.1). |
| Inflation & maintenance reserve | — | Modeled as a **bucket** (§2.3), not a spend category. |
| Currency exposure (USD/MEP/CCL) | — | Modeled as the **USD/FX-hedge bucket** + real USD Accounts. |
| Transfer fees | `Fees` | Keep (ADR-135). |

**Net category changes:** add **`Housing`** (extends `Rent`), add **`Education`**; optionally add **`FamilySupport`**. Everything else maps to existing categories. Tax reserve, inflation reserve, and FX exposure are **buckets, not categories**.

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
| Category additions: `Housing`, `Education` | Matches AR reality / INDEC divisions | **S** |
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
- Category list: add `Housing`, `Education` to `value_objects.py`, `types.ts`, `seed.ts`.

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

**Architect designs the MVP slice first** — specifically the data + service shape for (a) the **net-income base** `(user_id, period)`, (b) the **`kind` discriminator** on budget rows so saving-profile allocations reuse the existing `budgets` table, and (c) the **pure reprice function** `next_cap = cap × (1+infl) + step_up` plus its confirm-on-rollover entrypoint. Capture three new ADRs (none exist today): **inflation-reprice model**, **saving-profile presets + savings as `kind` rows**, and **net-income base / variable-income rule**. Add `Housing`/`Education` categories in the same slice. Defer the `savings_buckets` aggregate and Transfer-funding to a Phase 2 design once the MVP proves the reprice loop earns its keep.

Run this through `/deep-plan` to land the ADRs before any code.
