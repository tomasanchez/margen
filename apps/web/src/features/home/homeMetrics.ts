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

/**
 * A `YYYY-MM-DD` ISO date as a comparable ordinal (`year*10000 + month*100 +
 * day`, month 1-based). Parses the leading date fields directly — no `Date`
 * construction, so no timezone day-rollover — to compare day-precise ranges.
 */
function dateOrdinal(year: number, month1: number, day: number): number {
  return year * 10_000 + month1 * 100 + day
}

/** The ISO `occurredOn`'s date ordinal (see {@link dateOrdinal}). */
function occurredOrdinal(occurredOn: string): number {
  const year = Number.parseInt(occurredOn.slice(0, 4), 10)
  const month1 = Number.parseInt(occurredOn.slice(5, 7), 10)
  const day = Number.parseInt(occurredOn.slice(8, 10), 10)
  return dateOrdinal(year, month1, day)
}

/**
 * True when `occurredOn` (`YYYY-MM-DD`) falls in the rolling "Last 12 months"
 * window: from the FIRST DAY of the month twelve months before `now` through
 * `now` (today), inclusive. Replicates the backend Monotributo trailing window
 * (`monotributo.py::trailing_window` — `add_months(today, -12)` first-of-month
 * → today) using local date math, not a `Date` round-trip on the row.
 */
export function occurredInLast12Months(
  occurredOn: string,
  now: Date = new Date(),
): boolean {
  const startYear = now.getFullYear()
  const startMonth = now.getMonth() // 0-based
  // First day of the month twelve months back (crossing the year boundary).
  const startTotal = startYear * 12 + startMonth - 12
  const lower = dateOrdinal(
    Math.floor(startTotal / 12),
    (((startTotal % 12) + 12) % 12) + 1,
    1,
  )
  const upper = dateOrdinal(now.getFullYear(), now.getMonth() + 1, now.getDate())
  const ord = occurredOrdinal(occurredOn)
  return ord >= lower && ord <= upper
}

/**
 * True when `occurredOn` (`YYYY-MM-DD`) falls in the current calendar year to
 * date: January 1 of `now`'s year through `now` (today), inclusive.
 */
export function occurredInYearToDate(
  occurredOn: string,
  now: Date = new Date(),
): boolean {
  const year = now.getFullYear()
  const lower = dateOrdinal(year, 1, 1)
  const upper = dateOrdinal(year, now.getMonth() + 1, now.getDate())
  const ord = occurredOrdinal(occurredOn)
  return ord >= lower && ord <= upper
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
