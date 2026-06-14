/**
 * Unit tests for the Home metric derivations (ADR-040).
 *
 * The viewing-month navigator must filter the real transactions by their
 * `occurredOn` year+month — NOT the `month` label, which would conflate the same
 * calendar month across different years. These tests use rows spread across two
 * months (and two years) and assert the metrics + recent activity respond to the
 * selected month, with a clean zero/empty result for a month that has no rows.
 */

import { describe, expect, test } from 'vitest'
import {
  deriveMonthMetrics,
  occurredInMonth,
  recentTransactions,
  transactionsForMonth,
} from './homeMetrics'
import type { Transaction } from '../../mock/types'

/** Minimal transaction builder for the derivation tests. */
function tx(
  id: string,
  occurredOn: string,
  type: 'income' | 'expense',
  amountNum: number,
  extra: Partial<Transaction> = {},
): Transaction {
  return {
    id,
    occurredOn,
    dispDate: occurredOn.slice(5),
    month: 'June',
    name: `Tx ${id}`,
    category: 'Other',
    bank: 'Transfer',
    currency: 'ARS',
    type,
    kind: type === 'income' ? 'income' : 'expense',
    amountNum,
    ...extra,
  }
}

const ROWS: Transaction[] = [
  // June 2026
  tx('a', '2026-06-12', 'income', 1000),
  tx('b', '2026-06-10', 'expense', 400),
  tx('c', '2026-06-05', 'expense', 100),
  // May 2026
  tx('d', '2026-05-20', 'income', 500),
  tx('e', '2026-05-02', 'expense', 200),
  // June 2025 (same calendar month, different year — must NOT leak into 2026)
  tx('f', '2025-06-15', 'income', 9999),
]

describe('occurredInMonth', () => {
  test('matches on year AND month, never the month alone', () => {
    expect(occurredInMonth('2026-06-12', { year: 2026, month: 5 })).toBe(true)
    expect(occurredInMonth('2025-06-12', { year: 2026, month: 5 })).toBe(false)
    expect(occurredInMonth('2026-05-12', { year: 2026, month: 5 })).toBe(false)
  })
})

describe('deriveMonthMetrics', () => {
  test('sums income/expenses for the selected month only', () => {
    const june = deriveMonthMetrics(ROWS, { year: 2026, month: 5 })
    expect(june.income).toBe(1000)
    expect(june.expenses).toBe(500)
    expect(june.savings).toBe(500)
  })

  test('the previous calendar month yields different totals', () => {
    const may = deriveMonthMetrics(ROWS, { year: 2026, month: 4 })
    expect(may.income).toBe(500)
    expect(may.expenses).toBe(200)
    expect(may.savings).toBe(300)
  })

  test('does not conflate the same month across years', () => {
    // June 2025 has only the 9999 income row; it must not bleed into June 2026.
    const june2025 = deriveMonthMetrics(ROWS, { year: 2025, month: 5 })
    expect(june2025.income).toBe(9999)
    expect(june2025.expenses).toBe(0)
  })

  test('an empty month yields all-zero metrics (no crash)', () => {
    const empty = deriveMonthMetrics(ROWS, { year: 2026, month: 0 })
    expect(empty).toMatchObject({ income: 0, expenses: 0, savings: 0 })
  })
})

describe('recentTransactions / transactionsForMonth', () => {
  test('returns only the selected month rows in source (newest-first) order', () => {
    const june = recentTransactions(ROWS, { year: 2026, month: 5 })
    expect(june.map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })

  test('caps to the limit', () => {
    const june = recentTransactions(ROWS, { year: 2026, month: 5 }, 2)
    expect(june).toHaveLength(2)
  })

  test('an empty month yields an empty list', () => {
    expect(transactionsForMonth(ROWS, { year: 2026, month: 0 })).toEqual([])
  })
})
