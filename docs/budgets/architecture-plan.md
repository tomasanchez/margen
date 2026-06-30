# Architecture Plan — Argentina-Aware Budgets Module

**Author role:** Principal architect (margen) · **Date:** 2026-06-30 · **Status:** Draft for owner review
**Spec:** `docs/budgets/product-deliverable.md` · **Research:** the Argentina personal-budgeting report.
**Extends:** ADR-125 (per-category monthly targets). **Reuses:** ADR-126 (settings gate), ADR-129 (forecast), ADR-130 (per-user ownership), ADR-133 (live MEP), ADR-135 (Transfers), ADR-044 (dolarapi), ADR-046/112 (Monotributo trailing-12), ADR-118 (CI auto-migrate).

> This is a planning artifact, drafted to be refined with the owner's pending research on maintaining a budget under Argentine economic instability. No app code has been written.

---

## 1. Current state (reusable primitives)

The budget slice is a textbook cosmic-python vertical and supplies almost every primitive we need:

- **`Budget` aggregate** — `id, user_id, category, period (month-start), amount, currency, timestamps`. No "kind" today; every row is implicitly a spend target.
- **`BudgetRecord`** — `NUMERIC(18,2)`, `UNIQUE(user_id, category, period)` (the upsert key — the biggest constraint on the kind discriminator), no cross-schema FK (ADR-094), `Index(user_id)`.
- **Reader** (`budget_queries.py`) — projects `{category: amount}` and joins `month_category_expense_totals` (the same aggregation summaries uses, ADR-042). Spend-category shaped: one row per category.
- **`app_settings`** — per-user singleton (`UNIQUE(user_id)`, lazy get-or-create), carries `monotributo_enabled` (ADR-126 toggle precedent) + `preferred_display_currency`. Home for low-cardinality per-user scalars.
- **`Transfer`** — built aggregate: `from/to_account`, net-zero same-currency, fees-as-expense, atomic in one UoW (ADR-135). The Phase-2 funding rail, already built.
- **Monotributo service** — `trailing_window()`, `build_standing()`, `project()`. The Phase-3 tax-reserve + variable-income engine, already pure.
- **Frontend** — `BudgetsPage` owns its `MonthSwitcher`, reads `useBudgets`, writes set/clear, invalidates `budgets`+`home`; `derive.ts` holds all pure math.
- **FX** — client-side only via `fxClient.fetchSuggestedMepRate()` (ADR-133), degrade to native on null. No server FX dependency, and we won't add one.

**The three failures to fix:** (1) a January cap describes a price level gone by March (no reprice); (2) no net-spendable-income notion; (3) savings is leftover, not a job.

---

## 2. MVP design — inflation-aware percentage budget

Adds exactly three things to the existing slice: a **net-income base**, a **`kind` discriminator** (saving rows in the same table), and a **pure reprice function** with a confirm-on-rollover entrypoint. Plus two categories.

### 2.1 Net spendable income base
A dedicated per-month table (NOT `app_settings` — income is period-scoped and must align to the month navigator; a singleton is the wrong cardinality):

```
budget_income
  id UUID PK · user_id UUID NOT NULL (ADR-130) · period DATE (month_start, ADR-040)
  amount NUMERIC(18,2) (ARS, ADR-025) · currency VARCHAR(3) DEFAULT 'ARS'
  source VARCHAR(20) DEFAULT 'manual'  -- 'manual' | 'monotributo' (Phase 3)
  created_at/updated_at · UNIQUE(user_id, period) · INDEX(user_id)
```
A small `BudgetIncome` aggregate (near-clone of `Budget`). MVP: salaried = take-home (manual); independent = user enters `collected − tax reserve − business costs` (manual). The **variable-income base** (`lower of last-12/12 vs lowest recent month`) ships as a **computed suggestion** (`suggest_variable_base()`, returns `None` when <12 months) the user accepts into the manual field — suggest/confirm like dolarapi (ADR-044). Automated true-up is Phase 3.

### 2.2 Budget `kind` discriminator (load-bearing)
Add a `kind` column **and widen the UNIQUE**:
```
budgets + kind VARCHAR(10) NOT NULL DEFAULT 'spend'   -- 'spend' | 'saving'
         UNIQUE(user_id, category, period) → UNIQUE(user_id, kind, category, period)
```
- Domain: closed `BudgetKind(StrEnum){SPEND,SAVING}` (parse() like `Kind`/`Currency`); `Budget.kind` defaults SPEND (back-compatible).
- Saving rows reuse `category` as a **bucket key** from a closed `SAVING_BUCKETS` set (`EmergencyFund, DebtAcceleration, ShortTermGoals, MediumTermGoals, LongTermInvestment, FxHedge, MaintenanceReserve`); `amount` = base × profile %.
- **Reader split:** `_targets()` MUST filter `kind='spend'` (saving buckets have no expense actuals); add `_savings()`; `MonthlyBudget` grows `savings: list[SavingLine]`.
- Commands gain `kind='spend'`; spend writes behaviorally unchanged. Saving rows are written by apply-profile, not hand-edited.
- Migration additive: `kind` default `'spend'` back-fills; swap UNIQUE via `batch_alter_table` (SQLite-safe); CI auto-migrate (ADR-118).
- Rationale: distinct `(kind, category)` keeps spend/saving taxonomies from colliding, keeps the vs-actuals join clean, and makes the Phase-2 extract a simple `WHERE kind='saving'`.

### 2.3 Saving-profile presets (code constants, not DB)
Research-fixed templates live in pure domain (`domain/models/saving_profiles.py`):
- `SavingProfile{CONSERVATIVE,BALANCED,AGGRESSIVE}`; `PROFILE_BUCKETS` summing to 20/30/40% (sub-buckets transcribed verbatim from the research); `MAINTENANCE_RESERVE_PCT = {Cons:5, Bal:2, Agg:2}` (spend-side reserve, stored as a `kind='saving'` `MaintenanceReserve` row).
- Pure `compute_saving_rows(base, profile) -> {bucket: amount}`; `ApplySavingProfile` command + handler writes the saving rows in one UoW (requires a net-income base first). Idempotent re-apply via the widened UNIQUE.
- Because saving = % of net income, buckets **auto-reprice** when the base changes — no per-bucket reprice math. The essentials>50%+Aggressive warning + sequencing guidance are **frontend copy** for MVP (guidance, not a hard gate).

### 2.4 Inflation-reprice service
Pure domain function:
```python
def reprice_cap(cap, monthly_infl, step_up=0):
    return (cap * (1 + monthly_infl/100)).quantize(CENTS) + step_up
```
`RepriceMonth` command + handler reprices **spend rows only** (saving re-derives from base) from `from_period`→`to_period`, with optional per-category `step_ups` (rent/ICL, tariffs). Inputs (MVP): one manual `monthly_infl` % (REM-seeded **frontend** suggestion ~1.8–2.1%/mo, suggest/confirm; **no INDEC scraping**). **Confirm-on-rollover, never silent:** the UI detects current month has no spend rows while prior does, shows a "Reprice for {month}?" preview (old→new per category, editable), user confirms → one `POST /budgets/reprice`.

### 2.5 Two new categories
Additive (categories are tolerant strings, ADR-027): add `Housing` (extends `Rent`; keep `Rent` as a back-compat alias — do NOT remove) and `Education` to `KNOWN_CATEGORIES` + `mock/types.ts` + `seed.ts`. No data migration.

### 2.6 Frontend shape
Add to `BudgetsPage` (all math in `derive.ts`): a **NetIncomeHeader** (inline edit → `PUT /budget-income`, "use suggested base"), a **RepricePrompt** (ResponsiveModal preview at rollover), the existing **SpendSection** (unchanged), and a new **SavingsSection** (profile picker + read-mostly saving rows with bucket/%/amount). Home card gains a compact net-income/saved line + a reprice nudge (ADR-127). New strings in the `budgets` i18n namespace (en+es, en-pinned tests).

### MVP endpoints (camelCase)
```
GET  /budget-income?month=YYYY-MM        → { month, amount, currency, source }
PUT  /budget-income                      (UpsertBudgetIncome)
GET  /budget-income/suggested?month=…    → { suggestedBase | null }
GET  /budgets?month=YYYY-MM              → { month, currency, categories[], savings[] }  (extended)
POST /budgets/apply-profile              (ApplySavingProfile)
POST /budgets/reprice                    (RepriceMonth)
PUT/DELETE /budgets                       (existing; body gains optional kind)
```

---

## 3. Phase 2 sketch — buckets as real money
Promote saving rows into a first-class **`SavingsBucket`** aggregate (`type: emergency|goal|sinking|fx`, `target_amount?/target_months?/due_date?/annual_cost?`, `currency`, `account_id?`, `monthly_pct`). **Funding = a real `Transfer`** (ADR-135) from operating → savings Account, so saving is observable in net worth (ADR-122/123). Emergency auto-target = essential spend × months; sinking = annual_cost ÷ months_until(due). Migrate MVP saving rows via `WHERE kind='saving'` extract. **Recommendation:** a bucket is a *view over a designated savings account* (single source of truth = account balance) — avoid a reconciliation engine. Full design = a Phase-2 deep-plan once the reprice loop proves its keep.

## 4. Phase 3 sketch — independent-grade + forward-looking
- Tax-reserve auto-fed from Monotributo (settings-gated, ADR-126): when enabled, derive a reserve % from the trailing-12 standing and pre-fill the independent base (`source='monotributo'`). Salaried/autónomo/IIBB stay manual-with-assist.
- Variable-income true-up: promote `suggest_variable_base` to an automated base; route surplus into buckets.
- USD-denominated goals: `currency=USD` on buckets; display via client-side live MEP (ADR-133) — no new server FX.
- Inflation-aware forecast: extend the pace projector (ADR-129) using the §2.4 monthly inflation assumption as the growth rate.
- Optional INDEC/BCRA feed to *suggest* (never auto-apply) inflation — Phase-3 evaluation only.

---

## 5. Data model + migrations per phase
| Phase | Migration (additive, ADR-118 auto-applies) | Backfill |
|---|---|---|
| MVP | `budget_income` table | none |
| MVP | `budgets.kind DEFAULT 'spend'`; swap UNIQUE to `(user_id,kind,category,period)` via `batch_alter_table` | server-default back-fills to `spend` |
| MVP | `Housing`/`Education` (tolerant strings) | none |
| Phase 2 | `savings_buckets` table (FK-less per ADR-094) | extract `WHERE kind='saving'` |
| Phase 3 | indices / `savings_buckets.currency` | none |

Per-user ownership (ADR-130) on every new table; no cross-schema FK (ADR-094); owner-scoped composite index; 404 cross-tenant (ADR-111). All additive with server defaults → CI auto-migrate (ADR-118) is clean; the `kind` UNIQUE swap is the only non-trivial DDL (kept SQLite-portable via `batch_alter_table`).

## 6. Test strategy (100% gate, ADR-0019)
Deliberately pure-function-heavy: unit-test `reprice_cap`, `compute_saving_rows` (profiles sum to 20/30/40), `suggest_variable_base` (lower-of + <12mo→None), `BudgetKind.parse`, the `kind` aggregate; handlers against fake repos/UoW. e2e (in-memory SQLite, client-side UUIDs per the PgUUID gotcha): apply-profile writes saving rows, reprice produces the new month, budget-income round-trips, `GET /budgets` returns `savings[]`, and a guard that saving rows never leak into `categories[]`. Integration (real PG, excluded from gate): the `kind`/`budget_income` UNIQUE behavior. Frontend: `derive.ts` reprice-preview + profile math; extended `BudgetsPage.test.tsx`; en-pinned.

## 7. ADRs to record (6 — route to decision-writer)
1. **ADR-137 — Inflation-reprice model** *(architecture)*: pure `cap×(1+infl)+step_up`, reprices only `kind='spend'`, applied on user confirm at rollover. *Rejected:* silent auto-reprice (erodes trust).
2. **ADR-138 — Saving-profile presets as code constants; savings as `kind='saving'` budget rows** *(architecture)*: widened `UNIQUE(user_id,kind,category,period)`. *Rejected:* dedicated table in MVP (over-models; deferred to Phase 2); profiles in DB (they're templates).
3. **ADR-139 — Net-income base as a per-month `budget_income` row; variable base is a suggestion** *(data)*. *Rejected:* a single `app_settings` scalar (wrong cardinality); enforced variable base in MVP.
4. **ADR-140 — Add `Housing` (extends `Rent`) + `Education`; `Rent` retained as alias** *(data)*. *Rejected:* destructive rename.
5. **ADR-141 — Inflation input = manual monthly %, REM-seeded suggestion, no INDEC scraping in MVP** *(risks)*. *Rejected:* live INDEC scraping (no clean API; ToS/ops fragility).
6. **ADR-142 (Phase 2 placeholder) — Savings buckets become a first-class aggregate funded by real Transfers; a bucket is a view over its account, not a reconciling balance** *(architecture)*. *Rejected:* notional reconciling balance.

ADR-126 (settings gate) + ADR-133 (client MEP) are reused as-is by Phase 3.

## 8. Risks & trade-offs (maintenance-under-instability — for the owner's research)
- **Reprice cadence:** prompt monthly at rollover; weekly drift is UI-only; persistent "last repriced {month}" nudge. *Open:* mid-month nudge after a big INDEC print?
- **Inflation input source (Open Q):** manual % + REM-seeded suggestion (MVP); the shipped REM constant can go stale → it's only a suggestion, user always edits. Phase-3 feed = suggestion only, never auto-apply.
- **ARS vs USD (Open Q):** ARS-only MVP; Phase-3 per-bucket USD via client-side MEP (ADR-133); net-worth FX drift is the accepted limitation (ADR-132).
- **Bucket-as-account reconciliation (Open Q):** Phase 2; recommend "view over a designated account."
- **Tax-reserve coupling (Open Q):** Phase 3, settings-gated; manual-with-assist for non-monotributo.
- **Variable-income data maturity:** lower-of needs ≥12 months; degrade to manual (suggestion returns None).
- **Cross-cutting:** the `kind` UNIQUE swap is the migration with teeth (batch_alter_table + integration test); a reader that forgets `kind='spend'` would surface buckets as fake spend (explicit e2e guard); resist building buckets-as-accounts in MVP.

---

### Files for the implementing agents
**Backend new:** `domain/models/{saving_profiles,reprice,budget_income}.py` (+ commands, handlers, repo port, reader, mapper, model, migration). **Backend extend:** `domain/models/budget.py` (+kind), `value_objects.py` (BudgetKind, SAVING_BUCKETS, Housing/Education), `domain/commands/budget.py`, `adapters/models/budget.py`, `adapters/budget_queries.py`, `service_layer/budget_read_models.py`, `budget_handlers.py`, `entrypoint/budgets*.py`.
**Frontend extend:** `features/budgets/{BudgetsPage,derive,queries}.ts(x)`, `api/budgetsClient.ts`, `mock/types.ts`, `seed.ts`, `budgets` i18n (en/es).
