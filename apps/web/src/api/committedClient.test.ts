/**
 * Unit tests for the committed-spend accent API client + DTO adapter (ADR-179).
 *
 * Asserts the contract adaptation in isolation with `fetch` mocked: the
 * `{ data }` envelope is unwrapped, Decimal-string money is parsed to numbers at
 * the display edge (no re-conversion — figures are already in the requested
 * currency, ADR-168), the per-source paid/pending split is preserved, the request
 * carries `month`/`currency`, and a non-2xx throws a status-carrying error.
 * `authedFetch` reads no session here, so it falls through to plain fetch.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  CommittedApiError,
  adaptCommittedSplit,
  fetchCommitted,
  type CommittedDto,
} from './committedClient'

/** A complete backend committed DTO (camelCase, Decimal strings, YYYY-MM). */
const committedDto: CommittedDto = {
  month: '2026-07',
  currency: 'ARS',
  paid: {
    subscription: '12000.00',
    installment: '30000.00',
    tax: '85000.00',
    total: '127000.00',
  },
  pending: {
    subscription: '5000.00',
    installment: '0.00',
    tax: '0.00',
    total: '5000.00',
  },
  unconverted: 0,
}

describe('adaptCommittedSplit', () => {
  test('unwraps + parses each Decimal figure to a number, per source', () => {
    const split = adaptCommittedSplit(committedDto)

    expect(split.month).toBe('2026-07')
    expect(split.currency).toBe('ARS')
    expect(split.paid).toEqual({
      subscription: 12_000,
      installment: 30_000,
      tax: 85_000,
      total: 127_000,
    })
    expect(split.pending.total).toBe(5_000)
    expect(split.pending.installment).toBe(0)
    expect(split.unconverted).toBe(0)
  })

  test('does not re-convert — figures are already in the requested currency', () => {
    // A USD split's totals are taken verbatim; the adapter never divides by a
    // rate. The `unconverted` count surfaces dropped streams (ADR-152/168).
    const usdDto: CommittedDto = {
      ...committedDto,
      currency: 'USD',
      paid: { subscription: '9.99', installment: '24.00', tax: '0.00', total: '33.99' },
      pending: { subscription: '0.00', installment: '0.00', tax: '0.00', total: '0.00' },
      unconverted: 2,
    }
    const split = adaptCommittedSplit(usdDto)
    expect(split.currency).toBe('USD')
    expect(split.paid.total).toBe(33.99)
    expect(split.unconverted).toBe(2)
  })

  test('coerces a non-finite Decimal to 0 (never NaN at the display edge)', () => {
    const garbage: CommittedDto = {
      ...committedDto,
      paid: { subscription: 'x', installment: '', tax: '10.00', total: '10.00' },
    }
    const split = adaptCommittedSplit(garbage)
    expect(split.paid.subscription).toBe(0)
    expect(split.paid.installment).toBe(0)
    expect(split.paid.tax).toBe(10)
  })
})

describe('fetchCommitted', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.unstubAllGlobals())

  test('GETs /reports/committed with month + currency and adapts the split', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: committedDto }), { status: 200 }),
    )
    const result = await fetchCommitted('2026-07', 'ARS')
    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/reports/committed')
    expect(String(url)).toContain('month=2026-07')
    expect(String(url)).toContain('currency=ARS')
    expect(result.paid.total).toBe(127_000)
    expect(result.pending.total).toBe(5_000)
  })

  test('throws a status-carrying CommittedApiError on a non-2xx', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('bad month', { status: 422 }),
    )
    await expect(fetchCommitted('nope', 'USD')).rejects.toBeInstanceOf(
      CommittedApiError,
    )
    try {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response('bad month', { status: 422 }),
      )
      await fetchCommitted('nope', 'USD')
    } catch (error) {
      expect((error as CommittedApiError).status).toBe(422)
    }
  })
})
