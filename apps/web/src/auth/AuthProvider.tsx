/**
 * AuthProvider — owns the Supabase session + exposes it to the app (ADR-096).
 *
 * Responsibilities:
 *   1. Initialize from `supabase.auth.getSession()` once on mount, flipping
 *      `isLoading` to `false` when the initial check resolves. Until then the
 *      provider renders a calm "checking session" state (ADR-037) so the app
 *      never flashes the login screen for an already-authenticated user.
 *   2. Subscribe to `supabase.auth.onAuthStateChange` so the session stays live
 *      across sign-in, sign-out, token refresh, and the OAuth redirect-back
 *      (the client has `detectSessionInUrl: true`, so the redirect is handled
 *      for us and surfaces here as a `SIGNED_IN` event).
 *   3. Expose `{ session, user, isLoading, signInWithPassword, signInWithGoogle,
 *      signOut }` via {@link AuthContext} (read with {@link useAuth}).
 *
 * The `onAuthChange` prop lets the host (main.tsx) react to session changes —
 * we wire it to `router.invalidate()` so `beforeLoad` guards re-evaluate the
 * moment the user signs in or out. Keeping it a prop (rather than importing the
 * router here) avoids a module cycle and keeps the provider testable.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { AuthContext, type AuthActionResult } from './authContext'
import { AuthBootstrap } from './AuthBootstrap'

/** Map any auth failure to a calm, human message (ADR-037); never leak internals. */
function toAuthError(error: { message?: string } | null): AuthActionResult {
  if (!error) return { error: null }
  return { error: error.message ?? 'Something went wrong. Please try again.' }
}

export interface AuthProviderProps {
  children: ReactNode
  /** Called whenever the session changes (after the initial check). */
  onAuthChange?: (session: Session | null) => void
}

export function AuthProvider({ children, onAuthChange }: AuthProviderProps) {
  const [session, setSession] = useState<Session | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  // Keep the latest callback in a ref so the subscription effect runs once and
  // never re-subscribes when the parent passes a new function identity. The ref
  // is updated in an effect (never during render) per react-hooks/refs.
  const onAuthChangeRef = useRef(onAuthChange)
  useEffect(() => {
    onAuthChangeRef.current = onAuthChange
  }, [onAuthChange])

  useEffect(() => {
    let active = true

    // 1. Seed from the persisted session (localStorage) before first paint of
    //    the real UI; flip isLoading off once it resolves.
    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return
      setSession(data.session)
      setIsLoading(false)
    })

    // 2. Stay live: sign-in / sign-out / refresh / OAuth redirect-back all flow
    //    through here. We notify the host so the router re-evaluates its guards.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return
      setSession(nextSession)
      setIsLoading(false)
      onAuthChangeRef.current?.(nextSession)
    })

    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [])

  const signInWithPassword = useCallback(
    async (email: string, password: string): Promise<AuthActionResult> => {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      })
      return toAuthError(error)
    },
    [],
  )

  const signInWithGoogle = useCallback(async (): Promise<AuthActionResult> => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        // Return to the app origin; detectSessionInUrl finishes the handshake.
        redirectTo: window.location.origin,
      },
    })
    return toAuthError(error)
  }, [])

  const signOut = useCallback(async (): Promise<void> => {
    await supabase.auth.signOut()
    // onAuthStateChange fires SIGNED_OUT, clearing state + invalidating routes.
  }, [])

  const value = useMemo(
    () => ({
      session,
      user: session?.user ?? null,
      isLoading,
      signInWithPassword,
      signInWithGoogle,
      signOut,
    }),
    [session, isLoading, signInWithPassword, signInWithGoogle, signOut],
  )

  return (
    <AuthContext.Provider value={value}>
      {isLoading ? <AuthBootstrap /> : children}
    </AuthContext.Provider>
  )
}

export default AuthProvider
