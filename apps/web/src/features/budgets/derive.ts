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
