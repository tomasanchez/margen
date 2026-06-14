/**
 * Unit tests for the app-settings API client (ADR-054, ADR-057).
 *
 * Asserts the contract boundary in isolation, with `fetch` mocked (no real
 * backend): `fetchSettings` GETs `/settings` and unwraps the `{ data }` envelope
 * (ADR-030) into the camelCase {@link Settings}; `updateSettings` PATCHes the
 * versioned URL with the partial body (JSON) and returns the updated settings
 * from the envelope; and any non-2xx response throws a {@link SettingsApiError}
 * carrying the HTTP status so TanStack Query treats it as a failure and the
 * Settings page can surface a 422 inline (ADR-037).
 *
 * Mirrors {@link summariesClient.test} / {@link monotributoClient.test}.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  SettingsApiError,
  fetchSettings,
  updateSettings,
  type Settings,
} from './settingsClient'

/** A complete backend settings row (camelCase, flat). */
const SETTINGS: Settings = {
  preferredDisplayCurrency: 'ARS',
  fxDefaultRateType: 'MEP',
  monotributoCurrentCategory: 'C',
  monotributoActivityType: 'services',
}

describe('fetchSettings', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('GETs /settings, unwraps { data }, and returns the camelCase Settings', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: SETTINGS }), { status: 200 }),
    )

    const settings = await fetchSettings()

    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/settings')
    // A bare GET (no method override).
    expect(init?.method).toBeUndefined()
    expect(settings).toEqual(SETTINGS)
  })

  test('a non-2xx response throws a SettingsApiError carrying the status', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('boom', { status: 500 }),
    )
    await expect(fetchSettings()).rejects.toBeInstanceOf(SettingsApiError)

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('unavailable', { status: 503 }),
    )
    await expect(fetchSettings()).rejects.toMatchObject({ status: 503 })
  })
})

describe('updateSettings', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('PATCHes /settings with the partial body and returns the updated settings', async () => {
    const updated: Settings = { ...SETTINGS, preferredDisplayCurrency: 'USD' }
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: updated }), { status: 200 }),
    )

    const result = await updateSettings({ preferredDisplayCurrency: 'USD' })

    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/api/v1/settings')
    expect(init?.method).toBe('PATCH')
    // Only the supplied subset is sent in the JSON body (a partial PATCH).
    expect(JSON.parse(String(init?.body))).toEqual({
      preferredDisplayCurrency: 'USD',
    })
    expect(result).toEqual(updated)
  })

  test('a 422 (bad value) throws a SettingsApiError carrying status 422', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('unknown category', { status: 422 }),
    )

    await expect(
      updateSettings({ monotributoCurrentCategory: 'Z' }),
    ).rejects.toBeInstanceOf(SettingsApiError)

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('unknown category', { status: 422 }),
    )
    await expect(
      updateSettings({ monotributoCurrentCategory: 'Z' }),
    ).rejects.toMatchObject({ status: 422 })
  })
})
