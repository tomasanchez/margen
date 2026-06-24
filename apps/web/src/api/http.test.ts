/**
 * Unit tests for authedFetch — the single authenticated fetch wrapper (ADR-092,
 * ADR-096, ADR-098).
 *
 * Every user-facing API route requires `Authorization: Bearer <access token>`.
 * authedFetch reads the live token from the (mocked) Supabase session and
 * attaches it. With `getSession()` and global `fetch` both stubbed, these assert
 * the header contract in isolation:
 *   - a present session → the outgoing request carries `Authorization: Bearer
 *     <token>`;
 *   - no session (signed out) → no Authorization header (request goes
 *     unauthenticated; the backend's 401 flows through each client's error path);
 *   - caller-supplied headers and the URL/method/body are preserved.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { makeSession, makeSupabaseAuthMock } from '../test/authFixtures'

vi.mock('../lib/supabase', () => ({
  supabase: { auth: undefined as unknown },
}))

import { supabase } from '../lib/supabase'
import { authedFetch } from './http'

/** Point the mocked supabase singleton at a getSession returning `session`. */
function withSession(session: import('@supabase/supabase-js').Session | null) {
  ;(supabase as { auth: unknown }).auth =
    makeSupabaseAuthMock({ initialSession: session }).auth
}

/** The Headers passed to the most recent fetch call. */
function lastRequestHeaders(): Headers {
  const init = vi.mocked(fetch).mock.calls.at(-1)?.[1]
  return new Headers(init?.headers)
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('authedFetch', () => {
  test('attaches Authorization: Bearer <token> when a session exists', async () => {
    withSession(makeSession({ access_token: 'live-token-123' }))

    await authedFetch('/api/v1/transactions')

    expect(lastRequestHeaders().get('Authorization')).toBe('Bearer live-token-123')
  })

  test('omits the Authorization header when signed out', async () => {
    withSession(null)

    await authedFetch('/api/v1/transactions')

    expect(lastRequestHeaders().has('Authorization')).toBe(false)
  })

  test('preserves the URL, method, body, and caller-supplied headers', async () => {
    withSession(makeSession({ access_token: 'live-token-123' }))

    await authedFetch('/api/v1/transactions', {
      method: 'POST',
      body: JSON.stringify({ amount: 10 }),
      headers: { 'Content-Type': 'application/json' },
    })

    const [url, init] = vi.mocked(fetch).mock.calls.at(-1)!
    expect(String(url)).toBe('/api/v1/transactions')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe(JSON.stringify({ amount: 10 }))
    const headers = new Headers(init?.headers)
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('Authorization')).toBe('Bearer live-token-123')
  })
})
