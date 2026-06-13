/**
 * Pure derivations for the Home command center (Issue #12).
 *
 * Income / Expenses are computed from the SHARED transactions store for the
 * current prototype month (June) so the hero cards stay consistent with the
 * Transactions screen and with any rows the user adds via the Add flow. The
 * Monotributo margin, trend, breakdown and insights are read-only seed snapshots
 * (ADR-020) and are consumed directly from their hooks.
 *
 * Kept in a non-component module so the section components stay
 * Fast-Refresh-friendly (component files export only components).
 */

import { MEP_RATE } from '../../mock/seed'
import type { MonthName, Transaction } from '../../mock/types'

/** The current month the prototype is centered on (ADR-020). */
export const CURRENT_MONTH: MonthName = 'June'

/** How many recent transactions the Home "Recent activity" section shows. */
export const RECENT_ACTIVITY_LIMIT = 5

export interface MonthMetrics {
  /** Total income (ARS-equivalent) for the month. */
  income: number
  /** Total expenses (ARS-equivalent) for the month. */
  expenses: number
  /** income − expenses; the estimated savings for the month. */
  savings: number
  /** Estimated savings converted to USD at the hardcoded MEP rate. */
  savingsUsd: number
}

/**
 * Sum income and expenses for `month` from the shared transactions list, and
 * derive estimated savings (+ its USD equivalent at MEP). All magnitudes are the
 * ARS-equivalent `amountNum`; the sign is implied by `type`.
 */
export function deriveMonthMetrics(
  transactions: readonly Transaction[],
  month: MonthName = CURRENT_MONTH,
): MonthMetrics {
  let income = 0
  let expenses = 0
  for (const t of transactions) {
    if (t.month !== month) continue
    if (t.type === 'income') income += t.amountNum
    else expenses += t.amountNum
  }
  const savings = income - expenses
  const savingsUsd = MEP_RATE > 0 ? savings / MEP_RATE : 0
  return { income, expenses, savings, savingsUsd }
}

/**
 * The most recent `limit` transactions for the Home activity preview. The seed
 * is in newest-first source order and new rows are unshifted to the front, so a
 * simple slice preserves "most recent first" without re-sorting.
 */
export function recentTransactions(
  transactions: readonly Transaction[],
  limit: number = RECENT_ACTIVITY_LIMIT,
): Transaction[] {
  return transactions.slice(0, limit)
}
