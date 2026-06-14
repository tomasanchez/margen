/**
 * Pure derivations for the Home command center (Issue #12, ADR-040).
 *
 * Income / Expenses are computed from the SHARED transactions store for the
 * SELECTED viewing month so the hero cards stay consistent with the Transactions
 * screen and with any rows the user adds via the Add flow. Filtering is by the
 * transaction's `occurredOn` ISO date (year + month), not the `month` label, so
 * the same calendar month in different years is never conflated (ADR-040). The
 * Monotributo margin, trend, breakdown and insights remain read-only mock
 * snapshots (ADR-035) and are consumed directly from their hooks — they do NOT
 * react to the selected month.
 *
 * Kept in a non-component module so the section components stay
 * Fast-Refresh-friendly (component files export only components).
 */

import { MEP_RATE } from '../../mock/seed'
import type { Transaction } from '../../mock/types'
import type { ViewingMonth } from '../../components/months'

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
 * True when `occurredOn` (`YYYY-MM-DD`) falls in the given viewing month.
 *
 * Parses the ISO date's leading `YYYY-MM` directly (no `Date` construction, so
 * no timezone surprises) and compares against the 0-based viewing month.
 */
export function occurredInMonth(
  occurredOn: string,
  view: ViewingMonth,
): boolean {
  const year = Number.parseInt(occurredOn.slice(0, 4), 10)
  const month = Number.parseInt(occurredOn.slice(5, 7), 10) - 1
  return year === view.year && month === view.month
}

/** Keep only the transactions whose `occurredOn` falls in the viewing month. */
export function transactionsForMonth(
  transactions: readonly Transaction[],
  view: ViewingMonth,
): Transaction[] {
  return transactions.filter((t) => occurredInMonth(t.occurredOn, view))
}

/**
 * Sum income and expenses for the selected viewing `month` from the shared
 * transactions list, and derive estimated savings (+ its USD equivalent at MEP).
 * All magnitudes are the ARS-equivalent `amountNum`; the sign is implied by
 * `type`. A month with no matching rows yields all-zero metrics.
 */
export function deriveMonthMetrics(
  transactions: readonly Transaction[],
  view: ViewingMonth,
): MonthMetrics {
  let income = 0
  let expenses = 0
  for (const t of transactions) {
    if (!occurredInMonth(t.occurredOn, view)) continue
    if (t.type === 'income') income += t.amountNum
    else expenses += t.amountNum
  }
  const savings = income - expenses
  const savingsUsd = MEP_RATE > 0 ? savings / MEP_RATE : 0
  return { income, expenses, savings, savingsUsd }
}

/**
 * The most recent `limit` transactions of the selected viewing month for the
 * Home activity preview. The list is in newest-first source order (the API
 * returns newest-first and new rows are unshifted to the front), so filtering by
 * month then slicing preserves "most recent first". An empty month yields `[]`.
 */
export function recentTransactions(
  transactions: readonly Transaction[],
  view: ViewingMonth,
  limit: number = RECENT_ACTIVITY_LIMIT,
): Transaction[] {
  return transactionsForMonth(transactions, view).slice(0, limit)
}
