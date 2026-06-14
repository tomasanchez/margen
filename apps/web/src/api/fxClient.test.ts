/**
 * Unit tests for the dolarapi.com FX adapter (ADR-044), with `fetch` mocked so
 * no real network is hit. Asserts the contract: the `venta` (sell) value is
 * returned as the suggested rate, and any failure (non-2xx, network error,
 * invalid shape, missing/garbage value) resolves to `null` — never throws — so
 * the form can fall back to required manual entry (no silent guess).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { fetchSuggestedMepRate } from './fxClient'

describe('fetchSuggestedMepRate', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('returns the venta (sell) value as the suggested rate', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          compra: 1230,
          venta: 1245.5,
          nombre: 'Bolsa',
          casa: 'bolsa',
        }),
        { status: 200 },
      ),
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
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ compra: 1230 }), { status: 200 }),
    )
    await expect(fetchSuggestedMepRate()).resolves.toBeNull()

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ venta: 0 }), { status: 200 }),
    )
    await expect(fetchSuggestedMepRate()).resolves.toBeNull()

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('not json', { status: 200 }),
    )
    await expect(fetchSuggestedMepRate()).resolves.toBeNull()
  })

  test('hits the dolarapi MEP/Bolsa endpoint', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ venta: 1245 }), { status: 200 }),
    )
    await fetchSuggestedMepRate()
    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('dolarapi.com/v1/dolares/bolsa')
  })
})
