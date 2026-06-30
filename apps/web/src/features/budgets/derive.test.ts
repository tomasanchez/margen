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
  deriveIncomeSaved,
  deriveRepricePreview,
  isRepriceRollover,
  parseMoney,
  priorYearMonth,
  PROFILE_BUCKET_PCT,
  PROFILE_SAVINGS_PCT,
  repriceCap,
  topAttentionCategories,
} from './derive'
import type {
  BudgetCategory,
  BudgetPeriod,
  SavingProfile,
} from '../../api/budgetsClient'

function line(
  category: BudgetCategory['category'],
  target: string | null,
  spent: string,
  remaining: string | null,
): BudgetCategory {
  return { category, target, spent, remaining }
}

/** Build a minimal period with just the categories provided (extended fields empty). */
function periodOf(categories: BudgetCategory[]): BudgetPeriod {
  return {
    month: '2026-06',
    currency: 'ARS',
    savings: [],
    floor: null,
    suggestedStrategy: null,
    pressure: null,
    categories,
  }
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
    savings: [],
    floor: null,
    suggestedStrategy: null,
    pressure: null,
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
      savings: [],
      floor: null,
      suggestedStrategy: null,
      pressure: null,
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

describe('priorYearMonth', () => {
  test('steps back one month, crossing the year boundary', () => {
    expect(priorYearMonth('2026-06')).toBe('2026-05')
    expect(priorYearMonth('2026-01')).toBe('2025-12')
  })
})

describe('repriceCap', () => {
  test('grows the cap by the monthly inflation %', () => {
    expect(repriceCap(100000, 2)).toBe(102000)
  })

  test('adds the optional step-up after the inflation growth', () => {
    expect(repriceCap(100000, 2, 50000)).toBe(152000)
  })

  test('a zero inflation keeps the cap (plus any step-up)', () => {
    expect(repriceCap(100000, 0)).toBe(100000)
    expect(repriceCap(100000, 0, 5000)).toBe(105000)
  })
})

describe('deriveRepricePreview', () => {
  test('reprices only targeted categories, sorted by descending old cap', () => {
    const prior = periodOf([
      line('Food', '100000', '0', null),
      line('Housing', '300000', '0', null),
      line('Transport', null, '0', null), // no target → excluded
    ])
    const rows = deriveRepricePreview(prior, 2)
    expect(rows.map((r) => r.category)).toEqual(['Housing', 'Food'])
    expect(rows[0].newCap).toBe(306000)
    expect(rows[1].newCap).toBe(102000)
  })

  test('applies per-category step-ups from the Decimal-string map', () => {
    const prior = periodOf([line('Housing', '300000', '0', null)])
    const rows = deriveRepricePreview(prior, 2, { Housing: '50000' })
    expect(rows[0].stepUp).toBe(50000)
    expect(rows[0].newCap).toBe(356000)
  })
})

describe('isRepriceRollover', () => {
  test('true only when current has no targets and prior does', () => {
    const withTargets = periodOf([line('Food', '100000', '0', null)])
    const noTargets = periodOf([line('Food', null, '0', null)])
    expect(isRepriceRollover(noTargets, withTargets)).toBe(true)
    expect(isRepriceRollover(withTargets, withTargets)).toBe(false)
    expect(isRepriceRollover(noTargets, noTargets)).toBe(false)
    expect(isRepriceRollover(undefined, withTargets)).toBe(false)
  })
})

describe('deriveIncomeSaved', () => {
  test('sums savings and computes the saved ratio against income', () => {
    const result = deriveIncomeSaved('1000000', [
      { bucket: 'EmergencyFund', percent: 7, amount: '70000' },
      { bucket: 'FxHedge', percent: 3, amount: '30000' },
    ])
    expect(result.income).toBe(1000000)
    expect(result.saved).toBe(100000)
    expect(result.savedRatio).toBeCloseTo(0.1)
  })

  test('null income → null ratio, saved still summed', () => {
    const result = deriveIncomeSaved(null, [
      { bucket: 'EmergencyFund', percent: 7, amount: '70000' },
    ])
    expect(result.income).toBeNull()
    expect(result.saved).toBe(70000)
    expect(result.savedRatio).toBeNull()
  })
})

describe('profile constants', () => {
  test('to-savings percentages are 20/30/40', () => {
    expect(PROFILE_SAVINGS_PCT).toEqual({
      conservative: 20,
      balanced: 30,
      aggressive: 40,
    })
  })

  test('each profile total (excluding the spend-side reserve) matches its rate', () => {
    const profiles: SavingProfile[] = ['conservative', 'balanced', 'aggressive']
    for (const profile of profiles) {
      const total = Object.entries(PROFILE_BUCKET_PCT[profile])
        .filter(([bucket]) => bucket !== 'MaintenanceReserve')
        .reduce((sum, [, pct]) => sum + pct, 0)
      expect(total).toBe(PROFILE_SAVINGS_PCT[profile])
    }
  })
})
