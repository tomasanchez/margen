/**
 * Unit tests for the reports-overview DTO adapter (ADR-167/168/169).
 *
 * The backend serializes money as Decimal STRINGS and percentages as plain
 * number-strings, already denominated in the requested currency. The adapter
 * parses them to numbers at the single client boundary WITHOUT re-converting, and
 * preserves the meaningful nulls (avg MEP / a per-month rate / a category's
 * vs-previous delta) rather than coercing them to 0.
 */

import { describe, expect, test } from 'vitest'
import {
  adaptReportsOverview,
  type ReportsOverviewDto,
} from './reportsClient'

const dto: ReportsOverviewDto = {
  range: '6M',
  currency: 'USD',
  kpis: {
    current: {
      income: '4200.00',
      expenses: '1800.00',
      netSaved: '2400.00',
      savingsRate: '0.571',
    },
    previous: {
      income: '4000.00',
      expenses: '2000.00',
      netSaved: '2000.00',
      savingsRate: '0.5',
    },
  },
  cashFlow: [
    { month: '2026-01', income: '700.00', expenses: '310.00' },
    { month: '2026-02', income: '720.00', expenses: '300.00' },
  ],
  categoryTrends: [
    {
      category: 'Food',
      total: '420.00',
      share: '22',
      series: ['60.00', '65.00', '70.00', '72.00', '75.00', '78.00'],
      deltaPct: '-0.05',
    },
    {
      category: 'Rent',
      total: '720.00',
      share: '38',
      series: ['720', '720', '720', '720', '720', '720'],
      deltaPct: null,
    },
  ],
  fxSummary: {
    avgMep: '1245.50',
    usdInvoiced: '4200.00',
    rateSeries: [
      { month: '2026-01', rate: null },
      { month: '2026-02', rate: '1240.00' },
      { month: '2026-03', rate: null },
    ],
  },
  unconverted: 3,
}

describe('adaptReportsOverview', () => {
  test('parses money + percentages to numbers, echoing range/currency', () => {
    const overview = adaptReportsOverview(dto)

    expect(overview.range).toBe('6M')
    expect(overview.currency).toBe('USD')
    expect(overview.kpis.current.income).toBe(4200)
    expect(overview.kpis.current.savingsRate).toBeCloseTo(0.571)
    expect(overview.kpis.previous.expenses).toBe(2000)
    expect(overview.unconverted).toBe(3)
  })

  test('adapts cash flow and category trends, preserving nulls', () => {
    const overview = adaptReportsOverview(dto)

    expect(overview.cashFlow).toHaveLength(2)
    expect(overview.cashFlow[0]).toEqual({
      month: '2026-01',
      income: 700,
      expenses: 310,
    })

    const [food, rent] = overview.categoryTrends
    expect(food.total).toBe(420)
    expect(food.share).toBe(22)
    expect(food.series).toEqual([60, 65, 70, 72, 75, 78])
    expect(food.deltaPct).toBeCloseTo(-0.05)
    // A category with no prior base keeps its null delta (no misleading number).
    expect(rent.deltaPct).toBeNull()
  })

  test('preserves nullable FX fields (avg MEP present, per-month rate null)', () => {
    const overview = adaptReportsOverview(dto)

    expect(overview.fxSummary.avgMep).toBeCloseTo(1245.5)
    expect(overview.fxSummary.usdInvoiced).toBe(4200)
    expect(overview.fxSummary.rateSeries[0].rate).toBeNull()
    expect(overview.fxSummary.rateSeries[1].rate).toBe(1240)
    expect(overview.fxSummary.rateSeries[2].rate).toBeNull()
  })

  test('defaults missing collections and a null avg MEP calmly', () => {
    const overview = adaptReportsOverview({
      ...dto,
      cashFlow: [],
      categoryTrends: [],
      fxSummary: { avgMep: null, usdInvoiced: '0', rateSeries: [] },
      unconverted: 0,
    })

    expect(overview.cashFlow).toEqual([])
    expect(overview.categoryTrends).toEqual([])
    expect(overview.fxSummary.avgMep).toBeNull()
    expect(overview.fxSummary.usdInvoiced).toBe(0)
  })
})
