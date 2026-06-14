/**
 * Unit tests for the monthly-insights API client + DTO adapter (ADR-061/062,
 * test plan ADR-063).
 *
 * Asserts the contract adaptation in isolation, with `fetch` mocked (no real
 * backend, ADR-038): the `{ data }` envelope is unwrapped, the camelCase facts
 * are mapped through, every Decimal string (deltaPct / totals / amount /
 * elapsedFraction / USD / rate) is parsed to a number, the optional facts pass
 * through as `null` when absent (with `savings` always present), and a non-2xx
 * response throws a status-carrying {@link InsightsApiError} so TanStack Query
 * treats it as a failure and Home can show its calm state (ADR-037).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  InsightsApiError,
  adaptInsights,
  fetchInsights,
  type MonthlyInsightsDto,
} from './insightsClient'

/** A complete backend insights DTO (camelCase, Decimal strings, ISO date). */
const fullDto: MonthlyInsightsDto = {
  month: '2026-06',
  topCategoryMover: { category: 'Food', deltaPct: '22.00' },
  recurring: { count: 3, total: '45000.50' },
  savings: { amount: '600000.00', isProjected: true, elapsedFraction: '0.45' },
  latestUsdInvoice: {
    usd: '500.00',
    rate: '1450.00',
    rateType: 'MEP',
    occurredOn: '2026-06-10',
  },
}

describe('adaptInsights', () => {
  test('unwraps every fact and parses the Decimal strings to numbers', () => {
    const insights = adaptInsights(fullDto)

    expect(insights.month).toBe('2026-06')
    expect(insights.topCategoryMover).toEqual({ category: 'Food', deltaPct: 22 })
    expect(insights.recurring).toEqual({ count: 3, total: 45_000.5 })
    expect(insights.savings).toEqual({
      amount: 600_000,
      isProjected: true,
      elapsedFraction: 0.45,
    })
    expect(insights.latestUsdInvoice).toEqual({
      usd: 500,
      rate: 1450,
      rateType: 'MEP',
      occurredOn: '2026-06-10',
    })
  })

  test('passes optional facts through as null while savings stays present', () => {
    const sparse: MonthlyInsightsDto = {
      month: '2026-02',
      topCategoryMover: null,
      recurring: null,
      savings: { amount: '0', isProjected: false, elapsedFraction: '1' },
      latestUsdInvoice: null,
    }

    const insights = adaptInsights(sparse)

    expect(insights.topCategoryMover).toBeNull()
    expect(insights.recurring).toBeNull()
    expect(insights.latestUsdInvoice).toBeNull()
    // Savings is never optional — a past month with nothing saved is 0, actual.
    expect(insights.savings).toEqual({
      amount: 0,
      isProjected: false,
      elapsedFraction: 1,
    })
  })

  test('coerces a non-finite Decimal string to 0 rather than NaN', () => {
    const insights = adaptInsights({
      ...fullDto,
      savings: { amount: 'not-a-number', isProjected: false, elapsedFraction: '0' },
    })
    expect(insights.savings.amount).toBe(0)
  })
})

describe('fetchInsights HTTP layer', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('requests the month, unwraps { data }, and returns the adapted facts', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: fullDto }), { status: 200 }),
    )

    const insights = await fetchInsights('2026-06')

    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/insights?month=2026-06')
    expect(insights.topCategoryMover?.deltaPct).toBe(22)
    expect(insights.savings.amount).toBe(600_000)
    expect(insights.latestUsdInvoice?.usd).toBe(500)
  })

  test('a non-2xx response throws an InsightsApiError carrying the status', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('boom', { status: 500 }),
    )
    await expect(fetchInsights('2026-06')).rejects.toBeInstanceOf(
      InsightsApiError,
    )

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('bad request', { status: 422 }),
    )
    await expect(fetchInsights('2026-13')).rejects.toMatchObject({
      status: 422,
    })
  })
})
