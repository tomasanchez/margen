/**
 * Shared auth test fixtures + a mock Supabase auth client (ADR-098, ADR-096).
 *
 * The frontend auth suites mock `src/lib/supabase`'s `supabase` client rather
 * than hitting a live Supabase instance (ADR-098). This module builds the two
 * things every such suite needs:
 *
 *   1. `makeSession` — a minimal-but-shaped `Session`/`User` so the code under
 *      test (provider, guard, AccountMenu, authedFetch) can read the fields it
 *      actually touches (`access_token`, `user`, `user.email`/metadata) without
 *      hand-rolling the full Supabase type in every test.
 *   2. `makeSupabaseAuthMock` — a `vi.fn()`-backed `supabase.auth` stub exposing
 *      `getSession`, `onAuthStateChange`, `signInWithPassword`,
 *      `signInWithOAuth`, and `signOut`, plus an `emitAuthChange` helper to
 *      drive the subscribed listener (so a test can simulate SIGNED_IN /
 *      SIGNED_OUT events the way the real client would).
 *
 * Keeping this in one place mirrors the existing `renderWithProviders` helper
 * and keeps each suite focused on the behavior under test (ADR-018).
 */

import { vi } from 'vitest'
import type { Session, User } from '@supabase/supabase-js'

/** Build a minimal Supabase `User`, overridable for metadata/email cases. */
export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    app_metadata: {},
    user_metadata: {},
    aud: 'authenticated',
    created_at: '2026-01-01T00:00:00.000Z',
    email: 'sofia@example.com',
    ...overrides,
  } as User
}

/** Build a minimal Supabase `Session` carrying the given (or default) token. */
export function makeSession(
  overrides: Partial<Session> = {},
): Session {
  return {
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: makeUser(),
    ...overrides,
  } as Session
}

/** The signature of the listener TanStack/Supabase invokes on auth changes. */
type AuthChangeListener = (event: string, session: Session | null) => void

export interface SupabaseAuthMock {
  /** The mock `supabase.auth` object to assign onto the mocked module. */
  auth: {
    getSession: ReturnType<typeof vi.fn>
    onAuthStateChange: ReturnType<typeof vi.fn>
    signInWithPassword: ReturnType<typeof vi.fn>
    signInWithOAuth: ReturnType<typeof vi.fn>
    signOut: ReturnType<typeof vi.fn>
  }
  /** Drive the subscribed listener as the real client would on a session change. */
  emitAuthChange: (event: string, session: Session | null) => void
}

export interface SupabaseAuthMockOptions {
  /** The session `getSession()` resolves with (default: signed out → null). */
  initialSession?: Session | null
  /**
   * When provided, `getSession()` returns this never-resolving promise so a
   * test can assert the provider's pre-resolve bootstrap state, then resolve it.
   */
  getSessionPromise?: Promise<{ data: { session: Session | null } }>
}

/**
 * Build a `vi.fn()`-backed mock of the `supabase.auth` surface the app uses.
 *
 * `getSession` resolves with `initialSession` (or the supplied controllable
 * promise). `onAuthStateChange` records the listener and returns the
 * `{ data: { subscription: { unsubscribe } } }` shape the provider destructures;
 * `emitAuthChange` invokes that listener so tests can simulate live events.
 * The sign-in/out mocks resolve to success by default ({ error: null }).
 */
export function makeSupabaseAuthMock(
  options: SupabaseAuthMockOptions = {},
): SupabaseAuthMock {
  const { initialSession = null, getSessionPromise } = options

  let listener: AuthChangeListener | null = null
  const unsubscribe = vi.fn()

  const getSession = vi.fn(
    () =>
      getSessionPromise ??
      Promise.resolve({ data: { session: initialSession } }),
  )

  const onAuthStateChange = vi.fn((cb: AuthChangeListener) => {
    listener = cb
    return { data: { subscription: { unsubscribe } } }
  })

  const auth = {
    getSession,
    onAuthStateChange,
    signInWithPassword: vi.fn().mockResolvedValue({ error: null }),
    signInWithOAuth: vi.fn().mockResolvedValue({ error: null }),
    signOut: vi.fn().mockResolvedValue({ error: null }),
  }

  return {
    auth,
    emitAuthChange: (event, session) => {
      listener?.(event, session)
    },
  }
}
