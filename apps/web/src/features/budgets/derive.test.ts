/**
 * Unit tests for the pure budget-progress derivations (ADR-125, ADR-019).
 *
 * Asserts the Decimal-string math the page + Home card share: ratio clamping,
 * over-budget detection, period totals over BUDGETED categories only, and the
 * attention ordering (over-budget first, then by fill ratio, then by spend).
 */

import { describe, expect, test } from 'vitest'
import {
  budgetMeterColor,
  categoryGroup,
  convertAmount,
  convertBudgetIncome,
  convertBudgetPeriod,
  convertMoneyString,
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
  BudgetIncome,
  BudgetHistoryLine,
  BudgetPeriod,
  SavingLine,
  SavingProfile,
} from '../../api/budgetsClient'
import type { Currency } from '../../mock/types'

function line(
  category: BudgetCategory['category'],
  target: string | null,
  spent: string,
  remaining: string | null,
  isEssential = false,
): BudgetCategory {
  return {
    category,
    target,
    // The native target currency only exists when a target is set (ADR-152/155).
    targetCurrency: target != null ? 'ARS' : null,
    spent,
    remaining,
    isEssential,
  }
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
    unconverted: 0,
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
    unconverted: 0,
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
      unconverted: 0,
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

describe('budgetMeterColor', () => {
  test('graduates by ratio: <40 green, 40-60 white, 60-85 gold, 85+ red', () => {
    expect(budgetMeterColor(0)).toBe('var(--mg-safe)')
    expect(budgetMeterColor(0.39)).toBe('var(--mg-safe)')
    expect(budgetMeterColor(0.4)).toBe('var(--mg-text)')
    expect(budgetMeterColor(0.59)).toBe('var(--mg-text)')
    expect(budgetMeterColor(0.6)).toBe('var(--mg-watch)')
    expect(budgetMeterColor(0.84)).toBe('var(--mg-watch)')
    expect(budgetMeterColor(0.85)).toBe('var(--mg-risk)')
    expect(budgetMeterColor(1)).toBe('var(--mg-risk)')
  })

  test('over budget is always red regardless of ratio', () => {
    expect(budgetMeterColor(0.1, true)).toBe('var(--mg-risk)')
    expect(budgetMeterColor(0, true)).toBe('var(--mg-risk)')
  })
})

// ---------------------------------------------------------------------------
// Preferred-currency conversion (ADR-152/155). The rate is ARS per 1 USD.
// ---------------------------------------------------------------------------

/** A native-currency budget line for the conversion tests. */
function nativeLine(
  category: BudgetCategory['category'],
  target: string | null,
  targetCurrency: Currency | null,
  spent: string,
  remaining: string | null,
  isEssential = false,
): BudgetCategory {
  return { category, target, targetCurrency, spent, remaining, isEssential }
}

describe('convertAmount', () => {
  test('same currency passes through unchanged (no rate needed)', () => {
    expect(convertAmount(100, 'ARS', 'ARS', null)).toBe(100)
    expect(convertAmount(100, 'USD', 'USD', 1000)).toBe(100)
  })

  test('USD → ARS multiplies by the rate', () => {
    expect(convertAmount(5, 'USD', 'ARS', 1000)).toBe(5000)
  })

  test('ARS → USD divides by the rate', () => {
    expect(convertAmount(5000, 'ARS', 'USD', 1000)).toBe(5)
  })

  test('a needed conversion with a missing/invalid rate returns null (never NaN)', () => {
    expect(convertAmount(5000, 'ARS', 'USD', null)).toBeNull()
    expect(convertAmount(5000, 'ARS', 'USD', 0)).toBeNull()
    expect(convertAmount(5000, 'ARS', 'USD', -1)).toBeNull()
    expect(convertAmount(5000, 'ARS', 'USD', Number.NaN)).toBeNull()
  })
})

describe('convertMoneyString', () => {
  test('returns a Decimal string in the target currency', () => {
    expect(convertMoneyString('5', 'USD', 'ARS', 1000)).toBe('5000.00')
    expect(convertMoneyString('5000', 'ARS', 'USD', 1000)).toBe('5.00')
  })

  test('null amount → null; unavailable rate for a needed conversion → null', () => {
    expect(convertMoneyString(null, 'USD', 'ARS', 1000)).toBeNull()
    expect(convertMoneyString('5000', 'ARS', 'USD', null)).toBeNull()
  })

  test('same currency passes through as a Decimal string without a rate', () => {
    expect(convertMoneyString('120000', 'ARS', 'ARS', null)).toBe('120000.00')
  })
})

describe('convertBudgetPeriod', () => {
  test('converts ARS-native targets to USD and recomputes remaining; spend untouched', () => {
    // Spend already arrives in the preferred (USD) currency from the backend.
    const period = periodOf([
      nativeLine('Food', '120000', 'ARS', '90', '—', true),
      nativeLine('Transport', null, null, '15', null, false),
    ])
    const converted = convertBudgetPeriod(period, 'USD', 1000)
    expect(converted.currency).toBe('USD')
    // 120000 ARS / 1000 = 120 USD; targetCurrency is now the preferred currency.
    expect(converted.categories[0].target).toBe('120.00')
    expect(converted.categories[0].targetCurrency).toBe('USD')
    // remaining = convertedTarget(120) − spent(90) = 30; spend is NOT converted.
    expect(converted.categories[0].spent).toBe('90')
    expect(converted.categories[0].remaining).toBe('30.00')
    // An untargeted category just adopts the preferred currency.
    expect(converted.categories[1].target).toBeNull()
    expect(converted.categories[1].targetCurrency).toBe('USD')
  })

  test('a target already in the preferred currency passes through (no rate needed)', () => {
    const period = periodOf([nativeLine('Food', '120', 'USD', '90', '30', true)])
    const converted = convertBudgetPeriod(period, 'USD', null)
    // Same currency needs no rate; the value is normalized to a Decimal string.
    expect(converted.categories[0].target).toBe('120.00')
    expect(converted.categories[0].targetCurrency).toBe('USD')
    expect(converted.categories[0].remaining).toBe('30.00')
  })

  test('an unavailable rate keeps the NATIVE line untouched (never NaN)', () => {
    const period = periodOf([nativeLine('Food', '120000', 'ARS', '90', '119910', true)])
    const converted = convertBudgetPeriod(period, 'USD', null)
    // No rate → the native line passes through unchanged (no mixed-currency
    // recompute); the surface shows a calm pending note instead (ADR-155).
    expect(converted.categories[0].target).toBe('120000')
    expect(converted.categories[0].targetCurrency).toBe('ARS')
    expect(converted.categories[0].remaining).toBe('119910')
    expect(converted.categories[0].remaining).not.toContain('NaN')
  })

  test('converts saving rows from the period currency to the preferred', () => {
    const period: BudgetPeriod = {
      ...periodOf([]),
      currency: 'ARS',
      savings: [{ bucket: 'EmergencyFund', percent: 5, amount: '50000' }],
    }
    const converted = convertBudgetPeriod(period, 'USD', 1000)
    expect(converted.savings[0].amount).toBe('50.00')
  })
})

describe('convertBudgetIncome', () => {
  const income: BudgetIncome = {
    month: '2026-06',
    amount: '3000000',
    currency: 'ARS',
    source: 'manual',
    floor: { amount: '1000000', source: 'manual' },
  }

  test('converts the income + floor to the preferred currency at the rate', () => {
    const converted = convertBudgetIncome(income, 'USD', 1000)
    expect(converted.currency).toBe('USD')
    expect(converted.amount).toBe('3000.00')
    expect(converted.floor?.amount).toBe('1000.00')
  })

  test('income already in the preferred currency is returned unchanged', () => {
    const usdIncome: BudgetIncome = { ...income, amount: '3000', currency: 'USD' }
    expect(convertBudgetIncome(usdIncome, 'USD', 1000)).toBe(usdIncome)
  })

  test('an unavailable rate keeps the native income (never NaN)', () => {
    const converted = convertBudgetIncome(income, 'USD', null)
    expect(converted.amount).toBe('3000000')
    expect(converted.currency).toBe('ARS')
  })

  test('a null income amount converts only the floor', () => {
    const noAmount: BudgetIncome = { ...income, amount: null }
    const converted = convertBudgetIncome(noAmount, 'USD', 1000)
    expect(converted.amount).toBeNull()
    expect(converted.currency).toBe('USD')
    expect(converted.floor?.amount).toBe('1000.00')
  })
})
