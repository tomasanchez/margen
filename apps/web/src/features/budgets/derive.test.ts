/**
 * Unit tests for the pure budget-progress derivations (ADR-125, ADR-019).
 *
 * Asserts the Decimal-string math the page + Home card share: ratio clamping,
 * over-budget detection, period totals over BUDGETED categories only, and the
 * attention ordering (over-budget first, then by fill ratio, then by spend).
 */

import { describe, expect, test } from 'vitest'
import {
  deriveBudgetTotals,
  deriveCategoryProgress,
  parseMoney,
  topAttentionCategories,
} from './derive'
import type { BudgetCategory, BudgetPeriod } from '../../api/budgetsClient'

function line(
  category: BudgetCategory['category'],
  target: string | null,
  spent: string,
  remaining: string | null,
): BudgetCategory {
  return { category, target, spent, remaining }
}

describe('parseMoney', () => {
  test('parses Decimal strings and coerces null / garbage to 0', () => {
    expect(parseMoney('120000.50')).toBe(120000.5)
    expect(parseMoney(null)).toBe(0)
    expect(parseMoney('abc')).toBe(0)
  })
})

describe('deriveCategoryProgress', () => {
  test('within budget: clamped ratio, not over, remaining positive', () => {
    const p = deriveCategoryProgress(line('Food', '100000', '40000', '60000'))
    expect(p.hasTarget).toBe(true)
    expect(p.ratio).toBeCloseTo(0.4)
    expect(p.overBudget).toBe(false)
    expect(p.remaining).toBe(60000)
  })

  test('over budget: ratio clamps to 1 and overBudget is true', () => {
    const p = deriveCategoryProgress(line('Food', '100000', '130000', '-30000'))
    expect(p.ratio).toBe(1)
    expect(p.overBudget).toBe(true)
    expect(p.remaining).toBe(-30000)
  })

  test('no target: ratio 0, not over, remaining null', () => {
    const p = deriveCategoryProgress(line('Transport', null, '15000', null))
    expect(p.hasTarget).toBe(false)
    expect(p.target).toBeNull()
    expect(p.ratio).toBe(0)
    expect(p.overBudget).toBe(false)
    expect(p.remaining).toBeNull()
  })
})

describe('deriveBudgetTotals', () => {
  const period: BudgetPeriod = {
    month: '2026-06',
    currency: 'ARS',
    categories: [
      line('Food', '100000', '130000', '-30000'),
      line('Rent', '200000', '200000', '0'),
      // No target: its spend must NOT count toward the budgeted-vs-spent totals.
      line('Transport', null, '50000', null),
    ],
  }

  test('sums targets + spend over BUDGETED categories only', () => {
    const totals = deriveBudgetTotals(period)
    expect(totals.budgeted).toBe(300000)
    expect(totals.spent).toBe(330000) // 130000 + 200000, NOT + 50000
    expect(totals.remaining).toBe(-30000)
    expect(totals.budgetedCount).toBe(2)
    expect(totals.overCount).toBe(1)
    expect(totals.hasAnyBudget).toBe(true)
  })

  test('reports no budget when nothing has a target', () => {
    const totals = deriveBudgetTotals({
      ...period,
      categories: [line('Transport', null, '50000', null)],
    })
    expect(totals.hasAnyBudget).toBe(false)
    expect(totals.budgetedCount).toBe(0)
  })
})

describe('topAttentionCategories', () => {
  test('ranks over-budget first, then by ratio, ignoring untargeted', () => {
    const period: BudgetPeriod = {
      month: '2026-06',
      currency: 'ARS',
      categories: [
        line('Food', '100000', '50000', '50000'), // 50%
        line('Rent', '100000', '130000', '-30000'), // over
        line('Health', '100000', '90000', '10000'), // 90%
        line('Transport', null, '999999', null), // no target → excluded
      ],
    }
    const top = topAttentionCategories(period, 3).map((c) => c.category)
    expect(top).toEqual(['Rent', 'Health', 'Food'])
    expect(top).not.toContain('Transport')
  })
})
