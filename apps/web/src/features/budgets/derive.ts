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

import type { BudgetCategory, BudgetPeriod } from '../../api/budgetsClient'

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
