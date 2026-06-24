/**
 * Auth context value + React context object (ADR-096).
 *
 * Kept in its own module (no JSX) so the context object and its type can be
 * imported by both the provider ({@link AuthProvider}) and any consumer
 * ({@link useAuth}) without pulling in the provider's component tree — and so a
 * fast-refresh-friendly file boundary is preserved (the provider file only
 * exports a component).
 *
 * The shape exposes the live Supabase {@link Session}/{@link User}, an
 * `isLoading` flag that is `true` only until the initial session check resolves
 * (so the app never flashes the login screen for an already-authenticated user
 * — ADR-037), and the three sign-in/out actions the UI calls.
 */

import { createContext } from 'react'
import type { Session, User } from '@supabase/supabase-js'

/** The result of a sign-in attempt: `error` is `null` on success (ADR-037). */
export interface AuthActionResult {
  /** A human-readable message when the action failed, else `null`. */
  error: string | null
}

/** The value exposed by {@link useAuth} and supplied to the router context. */
export interface AuthContextValue {
  /** The live Supabase session, or `null` when signed out. */
  session: Session | null
  /** Convenience accessor for `session.user`, or `null` when signed out. */
  user: User | null
  /** `true` until the initial `getSession()` check resolves (ADR-037). */
  isLoading: boolean
  /** Sign in with an email + password; resolves with a calm error message or null. */
  signInWithPassword: (
    email: string,
    password: string,
  ) => Promise<AuthActionResult>
  /** Begin the Google OAuth redirect flow; resolves with a calm error or null. */
  signInWithGoogle: () => Promise<AuthActionResult>
  /** Clear the session locally + on Supabase. */
  signOut: () => Promise<void>
}

/**
 * The auth context. Default is a signed-out, still-loading value whose actions
 * reject loudly — they should never run outside an {@link AuthProvider}.
 */
export const AuthContext = createContext<AuthContextValue>({
  session: null,
  user: null,
  isLoading: true,
  signInWithPassword: () => {
    throw new Error('useAuth must be used within an AuthProvider')
  },
  signInWithGoogle: () => {
    throw new Error('useAuth must be used within an AuthProvider')
  },
  signOut: () => {
    throw new Error('useAuth must be used within an AuthProvider')
  },
})
