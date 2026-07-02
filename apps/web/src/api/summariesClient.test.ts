/**
 * Unit tests for the summaries API client + DTO adapter (ADR-042, ADR-043).
 *
 * Asserts the contract adaptation in isolation, with `fetch` mocked (no real
 * backend): the `{ data }` envelope is unwrapped, Decimal-string money/share/
 * deltaPct are parsed to numbers, the `YYYY-MM` month becomes a short label, a
 * positive `deltaPct` becomes a rounded `+N%` badge while null/zero/negative
 * yields no badge, the requested month carries `current: true`, and a non-2xx
 * response throws a status-carrying error so TanStack Query treats it as a
 * failure.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  SummaryApiError,
  adaptSummary,
  fetchSummary,
  shortMonthLabel,
  type SummaryDto,
} from './summariesClient'

/** A complete backend summary DTO (camelCase, Decimal strings, YYYY-MM months). */
const summaryDto: SummaryDto = {
  month: '2026-06',
  trend: [
    { month: '2026-01', expenses: '2450000', current: false },
    { month: '2026-02', expenses: '2300000.50', current: false },
    { month: '2026-03', expenses: '2620000', current: false },
    { month: '2026-04', expenses: '2410000', current: false },
    { month: '2026-05', expenses: '2580000', current: false },
    { month: '2026-06', expenses: '2850000', current: true },
  ],
  categories: [
    { category: 'Food', amount: '300.00', share: '50', deltaPct: '200' },
    {
      category: 'Uncategorized',
      amount: '100.00',
      share: '16.67',
      deltaPct: null,
    },
    { category: 'Rent', amount: '80.00', share: '13.33', deltaPct: '-10' },
    { category: 'Health', amount: '60.00', share: '10', deltaPct: '0' },
    { category: 'Transport', amount: '40.00', share: '6.67', deltaPct: '22.4' },
  ],
}

describe('shortMonthLabel', () => {
  test('derives the short month label from YYYY-MM', () => {
    expect(shortMonthLabel('2026-06')).toBe('Jun')
    expect(shortMonthLabel('2026-01')).toBe('Jan')
    expect(shortMonthLabel('2025-12')).toBe('Dec')
  })

  test('falls back to the raw input for an out-of-range month', () => {
    expect(shortMonthLabel('2026-13')).toBe('2026-13')
  })
})

describe('adaptSummary', () => {
  test('adapts trend: Decimal expenses to numbers and YYYY-MM to short labels', () => {
    const { trend } = adaptSummary(summaryDto)

    expect(trend).toHaveLength(6)
    expect(trend[0]).toEqual({ month: 'Jan', value: 2_450_000 })
    expect(trend[1].value).toBe(2_300_000.5)
    // The requested month carries the current flag.
    expect(trend[5]).toEqual({ month: 'Jun', value: 2_850_000, current: true })
    // Non-current months omit the flag entirely.
    expect('current' in trend[0]).toBe(false)
  })

  test('adapts categories: Decimal amount/share to numbers, positive delta to +N%', () => {
    const { categories } = adaptSummary(summaryDto)

    expect(categories[0]).toEqual({
      category: 'Food',
      amount: 300,
      pct: 50,
      // The full signed delta is carried for the Reports category table (ADR-163),
      // alongside the positive-only `up` badge the Home card shows.
      deltaPct: 200,
      up: '+200%',
    })
    // A positive fractional delta is rounded for the badge; the raw delta is kept.
    expect(categories[4].up).toBe('+22%')
    expect(categories[4].deltaPct).toBe(22.4)
  })

  test('omits the up badge for null, zero, or negative deltaPct but keeps the raw delta', () => {
    const { categories } = adaptSummary(summaryDto)

    // null delta (no prior data) -> no badge, null delta carried through.
    expect('up' in categories[1]).toBe(false)
    expect(categories[1].deltaPct).toBeNull()
    // negative delta (spend fell) -> no badge, but the fall is carried for Reports.
    expect('up' in categories[2]).toBe(false)
    expect(categories[2].deltaPct).toBe(-10)
    // zero delta -> no badge.
    expect('up' in categories[3]).toBe(false)
    expect(categories[3].deltaPct).toBe(0)
  })
})

describe('fetchSummary HTTP layer', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('requests the month, unwraps { data }, and returns the adapted summary', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: summaryDto }), { status: 200 }),
    )

    const summary = await fetchSummary('2026-06')

    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/summaries?month=2026-06')
    expect(summary.trend[5].value).toBe(2_850_000)
    expect(summary.categories[0].amount).toBe(300)
  })

  test('a non-2xx response throws an error carrying the status', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('boom', { status: 500 }),
    )
    await expect(fetchSummary('2026-06')).rejects.toBeInstanceOf(SummaryApiError)

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('bad request', { status: 400 }),
    )
    await expect(fetchSummary('2026-06')).rejects.toMatchObject({ status: 400 })
  })
})
