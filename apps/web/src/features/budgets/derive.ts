/**
 * Pure budget-progress derivations (ADR-125, ADR-019).
 *
 * Shared by the Budgets page rows, the Home budget-progress card, and their
 * tests so the math (Decimal-string parsing, spent/target ratio, over-budget
 * detection, period totals) lives in ONE place and never drifts between
 * surfaces. No React, no i18n — just numbers in, numbers out.
 *
 * Money arrives as Decimal STRINGS (ADR-025/034) and is parsed to numbers here
 * for ratios + totals; the display edge formats via the shared helpers (ADR-102).
 * Over-budget is conveyed beyond color downstream (label + icon, ADR-019); this
 * module only computes the boolean + the ratio.
 */

import type {
  BudgetCategory,
  BudgetHistoryLine,
  BudgetPeriod,
  SavingLine,
  SavingProfile,
} from '../../api/budgetsClient'

/** Parse a Decimal string to a number; nullish / non-finite → 0. */
export function parseMoney(value: string | null | undefined): number {
  if (value == null) return 0
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** A category's progress, derived once for both display + a11y. */
export interface CategoryProgress {
  /** Target amount, or `null` when the category has no target set. */
  target: number | null
  /** Actual expense total for the month. */
  spent: number
  /** `target − spent` (signed) when a target exists, else `null`. */
  remaining: number | null
  /** `spent / target` clamped to [0, 1] for the meter fill; 0 when no target. */
  ratio: number
  /** Whether spend exceeds the target (target set AND spent > target). */
  overBudget: boolean
  /** Whether the category has a target set at all. */
  hasTarget: boolean
}

/** Derive a category's progress from its (Decimal-string) budget line. */
export function deriveCategoryProgress(
  category: BudgetCategory,
): CategoryProgress {
  const hasTarget = category.target != null
  const target = hasTarget ? parseMoney(category.target) : null
  const spent = parseMoney(category.spent)
  const remaining = category.remaining != null ? parseMoney(category.remaining) : null
  // Fill ratio: spent / target clamped to [0, 1]. With no target (or a zero/
  // negative one) there is nothing to fill against, so the ratio is 0.
  const ratio =
    target != null && target > 0 ? Math.min(Math.max(spent / target, 0), 1) : 0
  const overBudget = target != null && target > 0 && spent > target
  return { target, spent, remaining, ratio, overBudget, hasTarget }
}

/** Aggregate totals across the period's categories that HAVE a target set. */
export interface BudgetTotals {
  /** Sum of targets across budgeted categories. */
  budgeted: number
  /** Sum of spend across budgeted categories only (the comparable figure). */
  spent: number
  /** `budgeted − spent` (signed). */
  remaining: number
  /** Number of categories with a target set. */
  budgetedCount: number
  /** Number of budgeted categories whose spend exceeds their target. */
  overCount: number
  /** Whether ANY target is set in the period (drives the Home empty state). */
  hasAnyBudget: boolean
}

/**
 * Totals across the BUDGETED categories only (the comparable budgeted-vs-spent
 * figure the Home card headlines). Spend from categories with no target is
 * excluded so "budgeted vs spent" compares like with like.
 */
export function deriveBudgetTotals(period: BudgetPeriod): BudgetTotals {
  let budgeted = 0
  let spent = 0
  let budgetedCount = 0
  let overCount = 0
  for (const category of period.categories) {
    if (category.target == null) continue
    const progress = deriveCategoryProgress(category)
    budgeted += progress.target ?? 0
    spent += progress.spent
    budgetedCount += 1
    if (progress.overBudget) overCount += 1
  }
  return {
    budgeted,
    spent,
    remaining: budgeted - spent,
    budgetedCount,
    overCount,
    hasAnyBudget: budgetedCount > 0,
  }
}

/**
 * The budgeted categories CLOSEST to / over their target, most-consumed first —
 * the "attention" list the Home card surfaces. Categories over budget rank
 * above those merely close to it (a ratio of 1 ties; the over flag breaks it),
 * and ties fall back to higher spend. Only categories with a target are
 * considered; the list is capped at `limit`.
 */
export function topAttentionCategories(
  period: BudgetPeriod,
  limit = 3,
): BudgetCategory[] {
  return period.categories
    .filter((c) => c.target != null)
    .map((category) => ({ category, progress: deriveCategoryProgress(category) }))
    .sort((a, b) => {
      // Over-budget first, then by fill ratio, then by spend.
      if (a.progress.overBudget !== b.progress.overBudget) {
        return a.progress.overBudget ? -1 : 1
      }
      if (b.progress.ratio !== a.progress.ratio) {
        return b.progress.ratio - a.progress.ratio
      }
      return b.progress.spent - a.progress.spent
    })
    .slice(0, limit)
    .map((entry) => entry.category)
}

// ---------------------------------------------------------------------------
// MVP budgets additions (ADR-137 reprice, ADR-138 savings, ADR-139 income/floor,
// ADR-143 pressure/strategy). All pure: numbers / strings in, numbers / strings
// out — no React, no i18n.
// ---------------------------------------------------------------------------

/** Round a number to 2 decimals and emit a Decimal string (ADR-025/034). */
export function toMoneyString(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2)
}

/**
 * The prior calendar month for a `YYYY-MM` string, crossing year boundaries.
 * e.g. `"2026-01"` → `"2025-12"`. Used to detect the reprice rollover.
 */
export function priorYearMonth(month: string): string {
  const [yearStr, monthStr] = month.split('-')
  const year = Number.parseInt(yearStr, 10)
  const m = Number.parseInt(monthStr, 10) // 1-based
  const total = year * 12 + (m - 1) - 1
  const py = Math.floor(total / 12)
  const pm = ((total % 12) + 12) % 12 // 0-based
  return `${py}-${String(pm + 1).padStart(2, '0')}`
}

/** Sum of saving allocations for the period (the "saved this month" figure). */
export function deriveSavingTotal(savings: SavingLine[]): number {
  return savings.reduce((sum, line) => sum + parseMoney(line.amount), 0)
}

/**
 * Whether the current month is a reprice-rollover candidate (ADR-137): it has no
 * spend targets set, while the prior month does. The page surfaces a "Reprice
 * for {month}?" prompt only then; it never auto-applies.
 */
export function isRepriceRollover(
  current: BudgetPeriod | undefined,
  prior: BudgetPeriod | undefined,
): boolean {
  if (!current || !prior) return false
  const currentHasTargets = current.categories.some((c) => c.target != null)
  const priorHasTargets = prior.categories.some((c) => c.target != null)
  return !currentHasTargets && priorHasTargets
}

/** One row of the reprice preview: a category's old cap → its repriced cap. */
export interface RepricePreviewRow {
  category: string
  /** Current (prior-month) target as a number. */
  oldCap: number
  /** The optional per-category step-up amount applied (0 when none). */
  stepUp: number
  /** The repriced cap: `oldCap × (1 + inflation/100) + stepUp`. */
  newCap: number
}

/** Pure reprice of a single cap (ADR-137): `cap × (1 + infl/100) + stepUp`. */
export function repriceCap(
  cap: number,
  monthlyInflation: number,
  stepUp = 0,
): number {
  const grown = Math.round(cap * (1 + monthlyInflation / 100) * 100) / 100
  return Math.round((grown + stepUp) * 100) / 100
}

/**
 * Build the reprice preview rows from the prior month's spend targets at a
 * monthly-inflation % with optional per-category step-up amounts (Decimal
 * strings keyed by category). Only categories that HAVE a target are repriced;
 * the result is sorted by descending old cap so the largest lines lead.
 */
export function deriveRepricePreview(
  prior: BudgetPeriod,
  monthlyInflation: number,
  stepUps: Record<string, string> = {},
): RepricePreviewRow[] {
  return prior.categories
    .filter((c) => c.target != null)
    .map((c) => {
      const oldCap = parseMoney(c.target)
      const stepUp = parseMoney(stepUps[c.category])
      return {
        category: c.category,
        oldCap,
        stepUp,
        newCap: repriceCap(oldCap, monthlyInflation, stepUp),
      }
    })
    .sort((a, b) => b.oldCap - a.oldCap)
}

/** Net-income + saved summary for the Home card line (ADR-139). */
export interface IncomeSavedSummary {
  /** Net spendable income as a number, or `null` when unset. */
  income: number | null
  /** Total allocated to saving buckets this month. */
  saved: number
  /** `saved / income` in [0, 1], or `null` when income is unset / zero. */
  savedRatio: number | null
}

/**
 * Derive the net-income / saved-this-month summary the Home card surfaces from
 * the income amount (Decimal string or null) and the period's saving rows.
 */
export function deriveIncomeSaved(
  incomeAmount: string | null,
  savings: SavingLine[],
): IncomeSavedSummary {
  const income = incomeAmount != null ? parseMoney(incomeAmount) : null
  const saved = deriveSavingTotal(savings)
  const savedRatio =
    income != null && income > 0 ? Math.min(Math.max(saved / income, 0), 1) : null
  return { income, saved, savedRatio }
}

/**
 * Saving-profile bucket percentages (ADR-138) — the research-fixed templates,
 * transcribed verbatim. Used by the picker to PREVIEW a profile's allocation
 * before applying; the backend is the source of truth for what gets written.
 * Each profile's spend-side `MaintenanceReserve` is included (5/2/2%).
 */
export const PROFILE_BUCKET_PCT: Record<
  SavingProfile,
  Record<SavingLine['bucket'], number>
> = {
  conservative: {
    EmergencyFund: 5,
    DebtAcceleration: 5,
    ShortTermGoals: 3,
    MediumTermGoals: 2,
    LongTermInvestment: 3,
    FxHedge: 2,
    MaintenanceReserve: 5,
  },
  balanced: {
    EmergencyFund: 7,
    DebtAcceleration: 7,
    ShortTermGoals: 4,
    MediumTermGoals: 4,
    LongTermInvestment: 5,
    FxHedge: 3,
    MaintenanceReserve: 2,
  },
  aggressive: {
    EmergencyFund: 8,
    DebtAcceleration: 10,
    ShortTermGoals: 5,
    MediumTermGoals: 5,
    LongTermInvestment: 7,
    FxHedge: 5,
    MaintenanceReserve: 2,
  },
} as const

/** The to-savings total for a profile (excludes the spend-side reserve): 20/30/40%. */
export const PROFILE_SAVINGS_PCT: Record<SavingProfile, number> = {
  conservative: 20,
  balanced: 30,
  aggressive: 40,
} as const

// ---------------------------------------------------------------------------
// Zero-based allocation surface (ADR-145, ADR-146, ADR-147). All pure: the
// math behind the allocation bar, the left-to-assign readout, the plan insight
// line, and the quick-start template target maps. Numbers / strings in, numbers
// / strings out — no React, no i18n.
// ---------------------------------------------------------------------------

/** The three allocation groups of the zero-based surface (ADR-146). */
export type BudgetGroup = 'needs' | 'wants' | 'savings'

/**
 * The Needs/Wants group a (spend) category belongs to (ADR-146): essential
 * categories are Needs, the rest are Wants. Savings is NOT a spend category — it
 * comes from the saving profiles — so a category is only ever Needs or Wants.
 */
export function categoryGroup(category: BudgetCategory): 'needs' | 'wants' {
  return category.isEssential ? 'needs' : 'wants'
}

/** Per-group + total allocation for the allocation bar + legend (ADR-145). */
export interface GroupAllocation {
  /** Σ targets of essential categories. */
  needs: number
  /** Σ targets of non-essential categories. */
  wants: number
  /** Σ saving-bucket amounts (the applied profile, ADR-138). */
  savings: number
  /** `needs + wants + savings` — everything assigned a job. */
  totalAllocated: number
}

/**
 * The group allocation totals from the period's category targets + saving rows
 * (ADR-145/146). Needs = Σ essential targets, Wants = Σ non-essential targets,
 * Savings = Σ saving-bucket amounts. Untargeted categories contribute 0.
 */
export function deriveGroupAllocation(period: BudgetPeriod): GroupAllocation {
  let needs = 0
  let wants = 0
  for (const category of period.categories) {
    if (category.target == null) continue
    const target = parseMoney(category.target)
    if (categoryGroup(category) === 'needs') needs += target
    else wants += target
  }
  const savings = deriveSavingTotal(period.savings)
  return { needs, wants, savings, totalAllocated: needs + wants + savings }
}

/** The state of the zero-based "left to assign" readout (ADR-145). */
export type AllocationState = 'under' | 'over' | 'balanced'

/** The live left-to-assign readout: income − everything assigned (ADR-145). */
export interface LeftToAssign {
  /** `income − totalAllocated` (signed). 0 when income is unset. */
  amount: number
  /** Absolute amount for display (the readout never shows a sign). */
  display: number
  /**
   * `under` (income > allocation → left to assign), `over` (income <
   * allocation → over-assigned), or `balanced` (≈ 0, all assigned). Treated as
   * balanced within a 1-peso tolerance so rounding never flips the state.
   */
  state: AllocationState
}

/**
 * The zero-based left-to-assign readout from the spendable income (Decimal
 * string or null) and the group allocation (ADR-145). A null/zero income with
 * nothing allocated is `balanced`; otherwise the sign of `income − allocated`
 * picks under/over, with a 1-peso tolerance around zero for "all assigned".
 */
export function deriveLeftToAssign(
  incomeAmount: string | null,
  allocation: GroupAllocation,
): LeftToAssign {
  const income = incomeAmount != null ? parseMoney(incomeAmount) : 0
  const amount = income - allocation.totalAllocated
  let state: AllocationState
  if (Math.abs(amount) < 1) state = 'balanced'
  else if (amount > 0) state = 'under'
  else state = 'over'
  return { amount, display: Math.abs(amount), state }
}

/**
 * A group's share of income as a ratio in [0, 1] for the legend % readout and
 * the group progress bars. Returns `null` when income is unset/zero (so the
 * caller renders an em-dash rather than a bogus 0%).
 */
export function groupShareOfIncome(
  groupTotal: number,
  incomeAmount: string | null,
): number | null {
  const income = incomeAmount != null ? parseMoney(incomeAmount) : 0
  if (income <= 0) return null
  return Math.min(Math.max(groupTotal / income, 0), 1)
}

/**
 * Per-segment widths for the stacked allocation bar as ratios in [0, 1] (ADR-145).
 * Segments are measured against the LARGER of income or total allocation, so an
 * over-assigned month fills the whole bar (the unallocated segment is 0) and an
 * under-assigned month leaves an unallocated tail. Income of 0 with no allocation
 * yields all-zero widths (an empty bar).
 */
export interface AllocationSegments {
  needs: number
  wants: number
  savings: number
  unallocated: number
}

export function deriveAllocationSegments(
  incomeAmount: string | null,
  allocation: GroupAllocation,
): AllocationSegments {
  const income = incomeAmount != null ? parseMoney(incomeAmount) : 0
  const denom = Math.max(income, allocation.totalAllocated, 1)
  const ratio = (n: number) => Math.min(Math.max(n / denom, 0), 1)
  return {
    needs: ratio(allocation.needs),
    wants: ratio(allocation.wants),
    savings: ratio(allocation.savings),
    unallocated: ratio(Math.max(0, income - allocation.totalAllocated)),
  }
}

/**
 * The plain-language "this month vs plan" insight (ADR-145). Derived entirely
 * client-side from the budgeted-vs-spent totals + the per-category overspend.
 * The page localizes the wording from this discriminated result; the math lives
 * here so it stays testable and never drifts.
 */
export type PlanInsight =
  | {
      kind: 'over'
      /** Total amount over plan (positive). */
      overBy: number
      /** The single biggest overspending category. */
      topCategory: BudgetCategory['category']
      /** How much that category alone is over its target (positive). */
      topOverBy: number
    }
  | {
      kind: 'someOver'
      /** How many categories are over target while the plan is still on track. */
      count: number
    }
  | {
      kind: 'onTrack'
      /** How far ahead of plan (remaining; ≥ 0). */
      ahead: number
    }

/**
 * Derive the plan-insight result from the period's BUDGETED categories (ADR-145).
 * If the overall plan is over (spent > budgeted) and at least one category is
 * over, the insight headlines the total overshoot + the biggest single
 * overspender. If individual categories are over but the overall plan is not,
 * it reports the count. Otherwise it reports how far ahead of plan you are.
 */
export function derivePlanInsight(period: BudgetPeriod): PlanInsight {
  const totals = deriveBudgetTotals(period)
  const overspenders = period.categories
    .filter((c) => c.target != null)
    .map((c) => ({ category: c, progress: deriveCategoryProgress(c) }))
    .filter((entry) => entry.progress.overBudget)
    .map((entry) => ({
      category: entry.category.category,
      overBy: entry.progress.spent - (entry.progress.target ?? 0),
    }))
    .sort((a, b) => b.overBy - a.overBy)

  if (totals.remaining < 0 && overspenders.length > 0) {
    return {
      kind: 'over',
      overBy: -totals.remaining,
      topCategory: overspenders[0].category,
      topOverBy: overspenders[0].overBy,
    }
  }
  if (overspenders.length > 0) {
    return { kind: 'someOver', count: overspenders.length }
  }
  return { kind: 'onTrack', ahead: Math.max(0, totals.remaining) }
}

/**
 * A map of category → target (Decimal string) a quick-start template wants to
 * write. A `null` value means "clear that category's target" (DELETE). The page
 * applies the map by batching the existing per-category PUT/DELETE mutations.
 */
export type TemplateTargets = Partial<Record<BudgetCategory['category'], string | null>>

/** Index a history list by category for O(1) lookup in the template builders. */
function historyByCategory(
  history: BudgetHistoryLine[],
): Map<BudgetCategory['category'], BudgetHistoryLine> {
  return new Map(history.map((line) => [line.category, line]))
}

/**
 * "Match 3-mo avg" (ADR-147): each category's target = its trailing 3-month
 * average spend. Categories whose `avg3mo` is 0 (or missing from history) are
 * skipped — no point writing a zero target.
 */
export function deriveMatchAvgTargets(
  period: BudgetPeriod,
  history: BudgetHistoryLine[],
): TemplateTargets {
  const byCategory = historyByCategory(history)
  const targets: TemplateTargets = {}
  for (const category of period.categories) {
    const avg = parseMoney(byCategory.get(category.category)?.avg3mo)
    if (avg > 0) targets[category.category] = toMoneyString(avg)
  }
  return targets
}

/**
 * "Match last month" (ADR-147): each category's target = last month's actual
 * spend. Categories whose `lastMonth` is 0 (or missing) are skipped.
 */
export function deriveMatchLastMonthTargets(
  period: BudgetPeriod,
  history: BudgetHistoryLine[],
): TemplateTargets {
  const byCategory = historyByCategory(history)
  const targets: TemplateTargets = {}
  for (const category of period.categories) {
    const last = parseMoney(byCategory.get(category.category)?.lastMonth)
    if (last > 0) targets[category.category] = toMoneyString(last)
  }
  return targets
}

/**
 * "Clear all" (ADR-147): every category that currently HAS a target is cleared
 * (mapped to `null` → DELETE). Categories with no target are omitted (nothing to
 * clear), so the batch only issues the deletes that actually change state.
 */
export function deriveClearAllTargets(period: BudgetPeriod): TemplateTargets {
  const targets: TemplateTargets = {}
  for (const category of period.categories) {
    if (category.target != null) targets[category.category] = null
  }
  return targets
}

/**
 * "50 / 30 / 20" spend legs (ADR-147): the Needs pool (income × 0.5) is
 * distributed across essential categories and the Wants pool (income × 0.3)
 * across non-essential categories, each weighted by the category's 3-month
 * average spend. When a group's averages are all zero (no history), the pool is
 * split EVENLY across that group's categories instead. The 20% Savings leg is
 * NOT part of this map — the page applies it via `POST /budgets/apply-profile`
 * with the Conservative preset (ADR-138).
 *
 * Returns an empty map when income is unset/zero (nothing to distribute).
 */
export function deriveFiftyThirtyTwentyTargets(
  period: BudgetPeriod,
  history: BudgetHistoryLine[],
  incomeAmount: string | null,
): TemplateTargets {
  const income = incomeAmount != null ? parseMoney(incomeAmount) : 0
  if (income <= 0) return {}
  const byCategory = historyByCategory(history)
  const targets: TemplateTargets = {}

  const distribute = (
    members: BudgetCategory[],
    pool: number,
  ) => {
    if (members.length === 0 || pool <= 0) return
    const weights = members.map((c) => parseMoney(byCategory.get(c.category)?.avg3mo))
    const weightSum = weights.reduce((sum, w) => sum + w, 0)
    members.forEach((category, i) => {
      const share =
        weightSum > 0 ? pool * (weights[i] / weightSum) : pool / members.length
      targets[category.category] = toMoneyString(share)
    })
  }

  const needs = period.categories.filter((c) => categoryGroup(c) === 'needs')
  const wants = period.categories.filter((c) => categoryGroup(c) === 'wants')
  distribute(needs, income * 0.5)
  distribute(wants, income * 0.3)
  return targets
}
