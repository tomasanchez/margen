/**
 * Unit tests for the cash-flow forecast API client + DTO adapter (ADR-176/177).
 *
 * Asserts the contract adaptation in isolation with `fetch` mocked: the
 * `{ data }` envelope is unwrapped, Decimal-string money is parsed to numbers at
 * the display edge (no re-conversion — the figures are already in the requested
 * currency, ADR-168), the confidence tier + line currency are narrowed, an
 * installment line keeps its `remainingCount` while a subscription/tax keep null,
 * the request carries `horizon`/`currency`, and a non-2xx throws a status-carrying
 * error. `authedFetch` reads no session here, so it falls through to plain fetch.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  ForecastApiError,
  adaptForecastSeries,
  fetchForecast,
  type ForecastSeriesDto,
} from './forecastClient'

/** A complete backend forecast DTO (camelCase, Decimal strings, YYYY-MM). */
const forecastDto: ForecastSeriesDto = {
  horizon: 6,
  currency: 'ARS',
  months: [
    { month: '2026-08', committed: '120000.00', total: '120000.00', confidence: 'committed' },
    { month: '2026-09', committed: '90000.50', total: '90000.50', confidence: 'committed' },
  ],
  commitments: [
    {
      source: 'subscription',
      label: 'Netflix',
      amount: '5000.00',
      currency: 'ARS',
      months: ['2026-08', '2026-09'],
      remainingCount: null,
    },
    {
      source: 'tax',
      label: 'Monotributo',
      amount: '85000.00',
      currency: 'ARS',
      months: ['2026-08', '2026-09'],
      remainingCount: null,
    },
    {
      source: 'installment',
      label: 'Samsung TV cuota 8/12',
      amount: '30000.00',
      currency: 'ARS',
      months: ['2026-08'],
      remainingCount: 9,
    },
  ],
  unconverted: 0,
}

describe('adaptForecastSeries', () => {
  test('unwraps + parses each Decimal figure to a number, preserving order', () => {
    const series = adaptForecastSeries(forecastDto)

    expect(series.horizon).toBe(6)
    expect(series.currency).toBe('ARS')
    expect(series.months).toHaveLength(2)
    expect(series.months[0]).toEqual({
      month: '2026-08',
      committed: 120_000,
      total: 120_000,
      confidence: 'committed',
    })
    // No re-conversion — figures are already in the requested currency (ADR-168).
    expect(series.months[1].committed).toBe(90_000.5)
  })

  test('keeps an installment remainingCount, null for a subscription/tax', () => {
    const { commitments } = adaptForecastSeries(forecastDto)

    const installment = commitments.find((c) => c.source === 'installment')
    const subscription = commitments.find((c) => c.source === 'subscription')
    const tax = commitments.find((c) => c.source === 'tax')

    expect(installment?.remainingCount).toBe(9)
    expect(installment?.amount).toBe(30_000)
    expect(subscription?.remainingCount).toBeNull()
    expect(tax?.remainingCount).toBeNull()
  })

  test('narrows the confidence tier and the line currency', () => {
    const series = adaptForecastSeries({
      ...forecastDto,
      currency: 'USD',
      months: [
        { month: '2026-08', committed: '100', total: '100', confidence: 'weird' },
      ],
      commitments: [
        {
          source: 'tax',
          label: 'Monotributo',
          amount: '85000',
          currency: 'ARS',
          months: ['2026-08'],
          remainingCount: null,
        },
      ],
    })

    // An unknown tier falls back to 'committed'; the top-level currency narrows.
    expect(series.months[0].confidence).toBe('committed')
    expect(series.currency).toBe('USD')
    // The tax line stays ARS even on a USD request (ADR-177).
    expect(series.commitments[0].currency).toBe('ARS')
  })

  test('parses garbage money to 0 and tolerates missing arrays', () => {
    const series = adaptForecastSeries({
      horizon: 3,
      currency: 'ARS',
    } as ForecastSeriesDto)

    expect(series.months).toEqual([])
    expect(series.commitments).toEqual([])
    expect(series.unconverted).toBe(0)

    const bad = adaptForecastSeries({
      ...forecastDto,
      months: [
        { month: '2026-08', committed: 'nope', total: '', confidence: 'committed' },
      ],
    })
    expect(bad.months[0].committed).toBe(0)
    expect(bad.months[0].total).toBe(0)
  })
})

describe('HTTP layer', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('fetchForecast requests horizon+currency, unwraps { data }, and adapts', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: forecastDto }), { status: 200 }),
    )

    const series = await fetchForecast(6, 'ARS')

    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/reports/forecast?')
    expect(String(url)).toContain('horizon=6')
    expect(String(url)).toContain('currency=ARS')
    expect(series.months[0].committed).toBe(120_000)
    expect(
      series.commitments.find((c) => c.source === 'installment')?.remainingCount,
    ).toBe(9)
  })

  test('a non-2xx response throws an error carrying the status', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('boom', { status: 500 }))
    await expect(fetchForecast(6, 'ARS')).rejects.toBeInstanceOf(ForecastApiError)

    vi.mocked(fetch).mockResolvedValueOnce(new Response('bad', { status: 422 }))
    await expect(fetchForecast(99, 'USD')).rejects.toMatchObject({ status: 422 })
  })
})
