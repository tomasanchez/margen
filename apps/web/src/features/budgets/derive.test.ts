/**
 * Unit tests for the pure budget-progress derivations (ADR-125, ADR-019).
 *
 * Asserts the Decimal-string math the page + Home card share: ratio clamping,
 * over-budget detection, period totals over BUDGETED categories only, and the
 * attention ordering (over-budget first, then by fill ratio, then by spend).
 */

import { describe, expect, test } from 'vitest'
import {
  categoryGroup,
  deriveAllocationSegments,
  deriveBudgetTotals,
  deriveCategoryProgress,
  deriveClearAllTargets,
  deriveFiftyThirtyTwentyTargets,
  deriveGroupAllocation,
  deriveIncomeSaved,
  deriveLeftToAssign,
  deriveMatchAvgTargets,
  deriveMatchLastMonthTargets,
  derivePlanInsight,
  deriveRepricePreview,
  groupShareOfIncome,
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
  BudgetHistoryLine,
  BudgetPeriod,
  SavingLine,
  SavingProfile,
} from '../../api/budgetsClient'

function line(
  category: BudgetCategory['category'],
  target: string | null,
  spent: string,
  remaining: string | null,
  isEssential = false,
): BudgetCategory {
  return { category, target, spent, remaining, isEssential }
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

// ---------------------------------------------------------------------------
// Zero-based allocation surface (ADR-145/146/147).
// ---------------------------------------------------------------------------

const SAVINGS: SavingLine[] = [
  { bucket: 'EmergencyFund', percent: 7, amount: '70000' },
  { bucket: 'FxHedge', percent: 3, amount: '30000' },
]

function hist(
  category: BudgetHistoryLine['category'],
  avg3mo: string,
  lastMonth: string,
): BudgetHistoryLine {
  return { category, avg3mo, lastMonth }
}

describe('categoryGroup', () => {
  test('essential → needs, non-essential → wants', () => {
    expect(categoryGroup(line('Food', null, '0', null, true))).toBe('needs')
    expect(categoryGroup(line('Shopping', null, '0', null, false))).toBe('wants')
  })
})

describe('deriveGroupAllocation', () => {
  test('sums essential targets into needs, the rest into wants, savings from buckets', () => {
    const period = periodOf([
      line('Food', '120000', '0', null, true),
      line('Rent', '200000', '0', null, true),
      line('Shopping', '80000', '0', null, false),
      line('Transport', null, '0', null, false), // untargeted → 0
    ])
    period.savings = SAVINGS
    const alloc = deriveGroupAllocation(period)
    expect(alloc.needs).toBe(320000)
    expect(alloc.wants).toBe(80000)
    expect(alloc.savings).toBe(100000) // 70000 + 30000
    expect(alloc.totalAllocated).toBe(500000)
  })
})

describe('deriveLeftToAssign', () => {
  const alloc = { needs: 300000, wants: 100000, savings: 100000, totalAllocated: 500000 }

  test('income above allocation → under (left to assign)', () => {
    const left = deriveLeftToAssign('600000', alloc)
    expect(left.state).toBe('under')
    expect(left.amount).toBe(100000)
    expect(left.display).toBe(100000)
  })

  test('income below allocation → over (over-assigned)', () => {
    const left = deriveLeftToAssign('400000', alloc)
    expect(left.state).toBe('over')
    expect(left.amount).toBe(-100000)
    expect(left.display).toBe(100000)
  })

  test('income equal to allocation (within a peso) → balanced', () => {
    expect(deriveLeftToAssign('500000', alloc).state).toBe('balanced')
    expect(deriveLeftToAssign('500000.5', alloc).state).toBe('balanced')
  })

  test('null income with nothing allocated → balanced', () => {
    const empty = { needs: 0, wants: 0, savings: 0, totalAllocated: 0 }
    expect(deriveLeftToAssign(null, empty).state).toBe('balanced')
  })
})

describe('groupShareOfIncome', () => {
  test('ratio of group to income, clamped; null when income unset/zero', () => {
    expect(groupShareOfIncome(300000, '1000000')).toBeCloseTo(0.3)
    expect(groupShareOfIncome(300000, null)).toBeNull()
    expect(groupShareOfIncome(300000, '0')).toBeNull()
  })
})

describe('deriveAllocationSegments', () => {
  test('measures against income when income exceeds allocation, leaving a tail', () => {
    const alloc = { needs: 300000, wants: 100000, savings: 100000, totalAllocated: 500000 }
    const seg = deriveAllocationSegments('1000000', alloc)
    expect(seg.needs).toBeCloseTo(0.3)
    expect(seg.wants).toBeCloseTo(0.1)
    expect(seg.savings).toBeCloseTo(0.1)
    expect(seg.unallocated).toBeCloseTo(0.5)
  })

  test('over-assigned: measures against allocation, no unallocated tail', () => {
    const alloc = { needs: 600000, wants: 300000, savings: 100000, totalAllocated: 1000000 }
    const seg = deriveAllocationSegments('500000', alloc)
    expect(seg.needs).toBeCloseTo(0.6)
    expect(seg.unallocated).toBe(0)
  })
})

describe('derivePlanInsight', () => {
  test('over plan: headlines the total + biggest single overspender', () => {
    const period = periodOf([
      line('Shopping', '100000', '180000', '-80000', false), // 80000 over
      line('Food', '100000', '120000', '-20000', true), // 20000 over
    ])
    const insight = derivePlanInsight(period)
    expect(insight.kind).toBe('over')
    if (insight.kind === 'over') {
      expect(insight.overBy).toBe(100000) // (180000+120000) - (100000+100000)
      expect(insight.topCategory).toBe('Shopping')
      expect(insight.topOverBy).toBe(80000)
    }
  })

  test('some over but plan on track: reports the count', () => {
    const period = periodOf([
      line('Shopping', '100000', '120000', '-20000', false), // 20000 over
      line('Food', '500000', '300000', '200000', true), // well under
    ])
    const insight = derivePlanInsight(period)
    expect(insight.kind).toBe('someOver')
    if (insight.kind === 'someOver') expect(insight.count).toBe(1)
  })

  test('all on or under target: reports how far ahead of plan', () => {
    const period = periodOf([
      line('Food', '100000', '40000', '60000', true),
      line('Rent', '200000', '200000', '0', true),
    ])
    const insight = derivePlanInsight(period)
    expect(insight.kind).toBe('onTrack')
    if (insight.kind === 'onTrack') expect(insight.ahead).toBe(60000)
  })
})

describe('quick-start template target maps', () => {
  const period = periodOf([
    line('Food', '120000', '90000', '30000', true),
    line('Rent', null, '200000', null, true),
    line('Shopping', null, '50000', null, false),
    line('Transport', null, '0', null, false),
  ])
  const history = [
    hist('Food', '100000', '95000'),
    hist('Rent', '300000', '310000'),
    hist('Shopping', '60000', '55000'),
    hist('Transport', '0', '0'), // no history → skipped
  ]

  test('match 3-mo avg: each target = avg3mo, skipping zero-history categories', () => {
    const targets = deriveMatchAvgTargets(period, history)
    expect(targets).toEqual({
      Food: '100000.00',
      Rent: '300000.00',
      Shopping: '60000.00',
    })
    expect(targets.Transport).toBeUndefined()
  })

  test('match last month: each target = lastMonth, skipping zeros', () => {
    const targets = deriveMatchLastMonthTargets(period, history)
    expect(targets).toEqual({
      Food: '95000.00',
      Rent: '310000.00',
      Shopping: '55000.00',
    })
    expect(targets.Transport).toBeUndefined()
  })

  test('clear all: maps only currently-targeted categories to null', () => {
    const targets = deriveClearAllTargets(period)
    // Only Food has a target → it is the only deletion.
    expect(targets).toEqual({ Food: null })
  })

  test('50/30/20: distributes the needs/wants pools weighted by avg3mo', () => {
    // income 1,000,000 → needs pool 500,000 across Food+Rent (avg 100k:300k →
    // 1:3), wants pool 300,000 across Shopping+Transport (avg 60k:0 → all to
    // Shopping). Savings is NOT in the map (applied via profile).
    const targets = deriveFiftyThirtyTwentyTargets(period, history, '1000000')
    expect(targets.Food).toBe('125000.00') // 500000 * 100/400
    expect(targets.Rent).toBe('375000.00') // 500000 * 300/400
    expect(targets.Shopping).toBe('300000.00') // all of the 300000 wants pool
    expect(targets.Transport).toBe('0.00') // zero weight → 0 of the pool
  })

  test('50/30/20: even split within a group when all averages are zero', () => {
    const flat = periodOf([
      line('Food', null, '0', null, true),
      line('Rent', null, '0', null, true),
    ])
    const targets = deriveFiftyThirtyTwentyTargets(flat, [], '1000000')
    // needs pool 500000 split evenly across two categories.
    expect(targets.Food).toBe('250000.00')
    expect(targets.Rent).toBe('250000.00')
  })

  test('50/30/20: empty map when income is unset', () => {
    expect(deriveFiftyThirtyTwentyTargets(period, history, null)).toEqual({})
  })
})
