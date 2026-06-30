/**
 * Unit tests for the dolarapi.com FX adapter (ADR-044), with `fetch` mocked so
 * no real network is hit. Asserts the contract: the `venta` (sell) value is
 * returned as the suggested rate for each source (MEP + official), and any
 * failure (non-2xx, network error, invalid shape, missing/garbage value)
 * resolves to `null` — never throws — so the form can fall back to required
 * manual entry (no silent guess). `fetchSuggestedRates` fetches both in parallel
 * and null-guards each endpoint independently (one failure must not null the
 * other).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  clearHistoricalRateCache,
  fetchCurrentRate,
  fetchHistoricalRate,
  fetchSuggestedMepRate,
  fetchSuggestedOfficialRate,
  fetchSuggestedRates,
  historicalUrlFor,
} from './fxClient'

/** Build a 200 JSON Response with the given quote body. */
function quoteResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

/** Route the mocked fetch by URL so parallel calls get the right body. */
function routeFetch(byUrl: Record<string, () => Response | Promise<Response>>) {
  vi.mocked(fetch).mockImplementation((input) => {
    const url = String(input)
    for (const [needle, make] of Object.entries(byUrl)) {
      if (url.includes(needle)) return Promise.resolve(make())
    }
    return Promise.reject(new Error(`unexpected url: ${url}`))
  })
}

describe('fetchSuggestedMepRate', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('returns the venta (sell) value as the suggested rate', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      quoteResponse({
        compra: 1230,
        venta: 1245.5,
        nombre: 'Bolsa',
        casa: 'bolsa',
      }),
    )

    await expect(fetchSuggestedMepRate()).resolves.toBe(1245.5)
  })

  test('returns null on a non-2xx response (no throw)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('nope', { status: 503 }))
    await expect(fetchSuggestedMepRate()).resolves.toBeNull()
  })

  test('returns null when fetch rejects (network error)', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'))
    await expect(fetchSuggestedMepRate()).resolves.toBeNull()
  })

  test('returns null when the body is missing or has no usable venta', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(quoteResponse({ compra: 1230 }))
    await expect(fetchSuggestedMepRate()).resolves.toBeNull()

    vi.mocked(fetch).mockResolvedValueOnce(quoteResponse({ venta: 0 }))
    await expect(fetchSuggestedMepRate()).resolves.toBeNull()

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('not json', { status: 200 }),
    )
    await expect(fetchSuggestedMepRate()).resolves.toBeNull()
  })

  test('hits the dolarapi MEP/Bolsa endpoint', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(quoteResponse({ venta: 1245 }))
    await fetchSuggestedMepRate()
    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('dolarapi.com/v1/dolares/bolsa')
  })
})

describe('fetchSuggestedOfficialRate', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('returns the venta value and hits the official endpoint', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(quoteResponse({ venta: 1045 }))
    await expect(fetchSuggestedOfficialRate()).resolves.toBe(1045)
    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('dolarapi.com/v1/dolares/oficial')
  })

  test('returns null on failure (no throw)', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'))
    await expect(fetchSuggestedOfficialRate()).resolves.toBeNull()
  })
})

describe('fetchSuggestedRates (both in parallel)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('returns both rates when both endpoints succeed', async () => {
    routeFetch({
      'dolares/bolsa': () => quoteResponse({ venta: 1245 }),
      'dolares/oficial': () => quoteResponse({ venta: 1045 }),
    })
    await expect(fetchSuggestedRates()).resolves.toEqual({
      mep: 1245,
      official: 1045,
    })
  })

  test('one endpoint down does not null the other (MEP up, official down)', async () => {
    routeFetch({
      'dolares/bolsa': () => quoteResponse({ venta: 1245 }),
      'dolares/oficial': () => new Response('nope', { status: 503 }),
    })
    await expect(fetchSuggestedRates()).resolves.toEqual({
      mep: 1245,
      official: null,
    })
  })

  test('one endpoint down does not null the other (official up, MEP down)', async () => {
    routeFetch({
      'dolares/bolsa': () => Promise.reject(new Error('offline')),
      'dolares/oficial': () => quoteResponse({ venta: 1045 }),
    })
    await expect(fetchSuggestedRates()).resolves.toEqual({
      mep: null,
      official: 1045,
    })
  })

  test('both null when both endpoints fail', async () => {
    routeFetch({
      'dolares/bolsa': () => new Response('x', { status: 500 }),
      'dolares/oficial': () => new Response('x', { status: 500 }),
    })
    await expect(fetchSuggestedRates()).resolves.toEqual({
      mep: null,
      official: null,
    })
  })
})

describe('fetchCurrentRate (preferred source by casa)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('bolsa hits the MEP/Bolsa endpoint and returns its venta', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(quoteResponse({ venta: 1245 }))
    await expect(fetchCurrentRate('bolsa')).resolves.toBe(1245)
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain(
      'dolarapi.com/v1/dolares/bolsa',
    )
  })

  test('oficial hits the official endpoint and returns its venta', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(quoteResponse({ venta: 1045 }))
    await expect(fetchCurrentRate('oficial')).resolves.toBe(1045)
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain(
      'dolarapi.com/v1/dolares/oficial',
    )
  })

  test('returns null on failure (never throws)', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'))
    await expect(fetchCurrentRate('bolsa')).resolves.toBeNull()
  })
})

describe('historicalUrlFor', () => {
  test('builds the ArgentinaDatos /{casa}/{yyyy}/{mm}/{dd} path from an ISO date', () => {
    expect(historicalUrlFor('bolsa', '2025-02-09')).toBe(
      'https://api.argentinadatos.com/v1/cotizaciones/dolares/bolsa/2025/02/09',
    )
  })

  test('tolerates a full ISO timestamp (only the date portion is used)', () => {
    expect(historicalUrlFor('oficial', '2024-12-25T10:30:00Z')).toBe(
      'https://api.argentinadatos.com/v1/cotizaciones/dolares/oficial/2024/12/25',
    )
  })
})

describe('fetchHistoricalRate', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    clearHistoricalRateCache()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    clearHistoricalRateCache()
  })

  test('returns the per-date venta from ArgentinaDatos and hits the dated URL', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      quoteResponse({ compra: 1180, venta: 1200, fecha: '2025-02-09' }),
    )
    await expect(fetchHistoricalRate('bolsa', '2025-02-09')).resolves.toBe(1200)
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain(
      'api.argentinadatos.com/v1/cotizaciones/dolares/bolsa/2025/02/09',
    )
  })

  test('caches by (casa, date) so a repeat lookup makes no second request', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(quoteResponse({ venta: 1200 }))
    await fetchHistoricalRate('bolsa', '2025-02-09')
    // A second call for the same (casa, date) resolves from cache — no new fetch.
    await expect(fetchHistoricalRate('bolsa', '2025-02-09')).resolves.toBe(1200)
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })

  test('returns null when the date is unavailable — NO fallback to today\'s rate (ADR-154)', async () => {
    // The dated endpoint 404s. ArgentinaDatos carries quotes forward over
    // weekends/holidays, so a true 404 means "no data" — we must NOT stamp
    // today's rate on a backdated row. Only ONE fetch (the dated one) is made.
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('not found', { status: 404 }),
    )
    await expect(fetchHistoricalRate('bolsa', '2025-02-09')).resolves.toBeNull()
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain(
      'api.argentinadatos.com/v1/cotizaciones/dolares/bolsa/2025/02/09',
    )
  })

  test('does NOT cache an unavailable-date null (a retry can recover the dated quote)', async () => {
    // First pass: the dated quote 404s → null, and the null is NOT cached.
    vi.mocked(fetch).mockResolvedValueOnce(new Response('x', { status: 404 }))
    await expect(fetchHistoricalRate('bolsa', '2025-02-09')).resolves.toBeNull()

    // A later pass: the dated quote is now published and is used (not a cached
    // null) — proving the null was not cached against the date.
    vi.mocked(fetch).mockResolvedValueOnce(quoteResponse({ venta: 1210 }))
    await expect(fetchHistoricalRate('bolsa', '2025-02-09')).resolves.toBe(1210)
  })

  test('returns null when the dated quote fails (never throws)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('x', { status: 500 }))
    await expect(fetchHistoricalRate('bolsa', '2025-02-09')).resolves.toBeNull()
  })
})
