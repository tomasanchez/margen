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
  fetchSuggestedMepRate,
  fetchSuggestedOfficialRate,
  fetchSuggestedRates,
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
