/**
 * Interaction tests for AuthProvider + useAuth (ADR-096, ADR-098, ADR-018).
 *
 * The provider owns the live Supabase session. With the Supabase client mocked
 * (ADR-098 — no live instance), these assert the user-visible behaviors:
 *   - while the initial `getSession()` is in flight, the calm bootstrap
 *     ("Checking your session…") is shown instead of the app (ADR-037);
 *   - once it resolves, the children render and `useAuth()` exposes the session;
 *   - an `onAuthStateChange` SIGNED_IN event surfaces the new user through
 *     `useAuth()` and fires the `onAuthChange` host callback (which main.tsx
 *     wires to `router.invalidate()`);
 *   - `signOut` calls through to `supabase.auth.signOut`.
 *
 * The Supabase client module is mocked per file; each test installs a fresh
 * `supabase.auth` mock so the provider's getSession/subscription run against it.
 */

import { afterEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AuthProvider } from './AuthProvider'
import { useAuth } from './useAuth'
import {
  makeSession,
  makeSupabaseAuthMock,
  type SupabaseAuthMock,
} from '../test/authFixtures'

// The provider imports the singleton `supabase` client; mock the module so the
// real createClient (which needs env credentials + network) never runs.
vi.mock('../lib/supabase', () => ({
  supabase: { auth: undefined as unknown },
}))

import { supabase } from '../lib/supabase'

/** Install a fresh auth mock onto the mocked supabase singleton. */
function installAuth(mock: SupabaseAuthMock): void {
  ;(supabase as { auth: unknown }).auth = mock.auth
}

afterEach(() => {
  vi.clearAllMocks()
})

/** A probe child that surfaces the live auth state for assertions. */
function AuthProbe() {
  const { user } = useAuth()
  return <div>signed in as {user?.email ?? 'nobody'}</div>
}

describe('AuthProvider bootstrap', () => {
  test('shows the calm "checking session" state until getSession resolves, then renders children', async () => {
    // A controllable promise lets us assert the bootstrap state before resolving.
    let resolveSession!: (value: {
      data: { session: import('@supabase/supabase-js').Session | null }
    }) => void
    const getSessionPromise = new Promise<{
      data: { session: import('@supabase/supabase-js').Session | null }
    }>((resolve) => {
      resolveSession = resolve
    })
    installAuth(makeSupabaseAuthMock({ getSessionPromise }))

    render(
      <AuthProvider>
        <div>protected app</div>
      </AuthProvider>,
    )

    // Before the initial check resolves: bootstrap, never the children.
    expect(screen.getByText('Checking your session…')).toBeInTheDocument()
    expect(screen.queryByText('protected app')).not.toBeInTheDocument()

    // Resolve the initial session check → children render, bootstrap gone.
    resolveSession({ data: { session: null } })
    expect(await screen.findByText('protected app')).toBeInTheDocument()
    expect(
      screen.queryByText('Checking your session…'),
    ).not.toBeInTheDocument()
  })
})

describe('AuthProvider session exposure', () => {
  test('exposes a session present at bootstrap through useAuth', async () => {
    installAuth(makeSupabaseAuthMock({ initialSession: makeSession() }))

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    )

    expect(await screen.findByText(/signed in as sofia@example.com/)).toBeInTheDocument()
  })

  test('an onAuthStateChange SIGNED_IN event surfaces the new user and fires onAuthChange', async () => {
    const mock = makeSupabaseAuthMock({ initialSession: null })
    installAuth(mock)
    const onAuthChange = vi.fn()

    render(
      <AuthProvider onAuthChange={onAuthChange}>
        <AuthProbe />
      </AuthProvider>,
    )

    // Starts signed out.
    expect(await screen.findByText('signed in as nobody')).toBeInTheDocument()

    // Simulate the live SIGNED_IN event the real client would emit.
    const nextSession = makeSession()
    mock.emitAuthChange('SIGNED_IN', nextSession)

    expect(
      await screen.findByText(/signed in as sofia@example.com/),
    ).toBeInTheDocument()
    // The host callback (wired to router.invalidate in main.tsx) is notified.
    await waitFor(() =>
      expect(onAuthChange).toHaveBeenCalledWith(nextSession),
    )
  })
})

describe('AuthProvider actions', () => {
  test('signOut calls through to supabase.auth.signOut', async () => {
    const mock = makeSupabaseAuthMock({ initialSession: makeSession() })
    installAuth(mock)
    const user = userEvent.setup()

    function SignOutButton() {
      const { signOut } = useAuth()
      return <button onClick={() => void signOut()}>leave</button>
    }

    render(
      <AuthProvider>
        <SignOutButton />
      </AuthProvider>,
    )

    await user.click(await screen.findByRole('button', { name: 'leave' }))

    await waitFor(() => expect(mock.auth.signOut).toHaveBeenCalledTimes(1))
  })
})
