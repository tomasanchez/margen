/**
 * `authedFetch` — the single authenticated fetch wrapper for the Margen API
 * (ADR-092, ADR-096).
 *
 * Every user-facing backend route now requires `Authorization: Bearer <supabase
 * access token>` (ADR-092); without it the API returns 401. Rather than wire the
 * token through each `*Client.ts`, this is the one place that reads the live
 * access token from the Supabase session and attaches it. The existing clients
 * swap `fetch(...)` → `authedFetch(...)` with no other change: the call shape
 * (URL first, an optional `RequestInit` second, with `method`/`body` preserved)
 * is identical, so their DTO/adapter/error behavior — and their unit tests —
 * stay intact. Only the request headers gain the bearer token.
 *
 * `getSession()` reads the cached, auto-refreshed session from the Supabase
 * client (localStorage); it does not hit the network on the happy path. When
 * there is no session (signed out, or in unit tests with no configured client),
 * the header is simply omitted — the request proceeds unauthenticated and the
 * backend's 401 flows through each client's existing `ensureOk` error path.
 */

import { supabase } from '../lib/supabase'

/** The HTTP status the API returns when the bearer token is missing/expired. */
export const UNAUTHORIZED_STATUS = 401

/**
 * Like `fetch`, but injects `Authorization: Bearer <token>` from the current
 * Supabase session. Caller-supplied headers win on conflict only if they set
 * `Authorization` explicitly (they never do); everything else is merged.
 */
export async function authedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  const headers = new Headers(init.headers)
  const token = session?.access_token
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  return fetch(input, { ...init, headers })
}
