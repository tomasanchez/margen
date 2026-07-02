/**
 * Unit tests for the reports API client + DTO adapter (ADR-163, ADR-164, ADR-165).
 *
 * Asserts the contract adaptation in isolation with `fetch` mocked: the net-worth
 * history `{ data }` envelope is unwrapped and Decimal-string subtotals are parsed
 * to numbers (no FX — the backend returns native amounts, ADR-164); a non-2xx
 * throws a status-carrying error; the export URL builders assemble the right query
 * params (`from`/`to`, `month`); and the CSV fetchers return a Blob via the authed
 * fetcher. `authedFetch` reads no session here, so it falls through to plain fetch.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  ReportsApiError,
  adaptNetWorthHistory,
  fetchNetWorthHistory,
  fetchSummaryCsv,
  fetchTransactionsCsv,
  summaryExportUrl,
  transactionsExportUrl,
  type NetWorthHistoryDto,
} from './reportsClient'

/** A complete backend history DTO (camelCase, Decimal strings, YYYY-MM, ADR-164). */
const historyDto: NetWorthHistoryDto = {
  months: [
    { month: '2026-01', arsTotal: '1000000.00', usdTotal: '100.00' },
    { month: '2026-02', arsTotal: '1250000.50', usdTotal: '150.00' },
    { month: '2026-03', arsTotal: '1500000.00', usdTotal: '0' },
  ],
}

describe('adaptNetWorthHistory', () => {
  test('parses each month Decimal subtotal to a number, preserving order', () => {
    const { months } = adaptNetWorthHistory(historyDto)

    expect(months).toHaveLength(3)
    expect(months[0]).toEqual({
      month: '2026-01',
      arsTotal: 1_000_000,
      usdTotal: 100,
    })
    expect(months[1].arsTotal).toBe(1_250_000.5)
    // No FX conversion happens here — natives are kept per currency (ADR-164).
    expect(months[2].usdTotal).toBe(0)
  })

  test('tolerates a missing months array', () => {
    expect(adaptNetWorthHistory({} as NetWorthHistoryDto).months).toEqual([])
  })
})

describe('export URL builders', () => {
  test('transactions URL omits params when no range is given', () => {
    expect(transactionsExportUrl()).toContain('/reports/export/transactions')
    expect(transactionsExportUrl()).not.toContain('?')
  })

  test('transactions URL carries from/to when supplied', () => {
    const url = transactionsExportUrl({ from: '2026-01-01', to: '2026-06-30' })
    expect(url).toContain('from=2026-01-01')
    expect(url).toContain('to=2026-06-30')
  })

  test('summary URL carries the month, or omits it when absent', () => {
    expect(summaryExportUrl('2026-06')).toContain('month=2026-06')
    expect(summaryExportUrl()).not.toContain('?')
  })
})

describe('HTTP layer', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('fetchNetWorthHistory requests months, unwraps { data }, and adapts', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: historyDto }), { status: 200 }),
    )

    const history = await fetchNetWorthHistory(12)

    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/reports/net-worth-history?months=12')
    expect(history.months[1].arsTotal).toBe(1_250_000.5)
  })

  test('a non-2xx history response throws an error carrying the status', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('boom', { status: 500 }))
    await expect(fetchNetWorthHistory()).rejects.toBeInstanceOf(ReportsApiError)

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('bad', { status: 422 }),
    )
    await expect(fetchNetWorthHistory()).rejects.toMatchObject({ status: 422 })
  })

  test('fetchTransactionsCsv returns the CSV blob from the right URL', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('id,name\n1,Rent', {
        status: 200,
        headers: { 'Content-Type': 'text/csv' },
      }),
    )

    const blob = await fetchTransactionsCsv({ from: '2026-01-01' })

    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/reports/export/transactions?from=2026-01-01')
    // The blob may come from undici's realm (not jsdom's Blob), so assert its
    // shape rather than the constructor identity.
    expect(await blob.text()).toBe('id,name\n1,Rent')
    expect(blob.type).toBe('text/csv')
  })

  test('fetchSummaryCsv returns the CSV blob for the month', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('category,amount_ars', {
        status: 200,
        headers: { 'Content-Type': 'text/csv' },
      }),
    )

    await fetchSummaryCsv('2026-06')

    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/reports/export/summary?month=2026-06')
  })

  test('a non-2xx CSV response throws a status-carrying error', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('nope', { status: 403 }))
    await expect(fetchTransactionsCsv()).rejects.toMatchObject({ status: 403 })
  })
})
