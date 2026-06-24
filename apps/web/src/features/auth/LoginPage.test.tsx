/**
 * Interaction tests for LoginPage (ADR-096, ADR-098, ADR-037, ADR-018).
 *
 * The page is the public sign-in surface: email/password form + a "Continue
 * with Google" button. With the Supabase client mocked (ADR-098), these assert
 * the user-visible behavior, driving the REAL provider actions end-to-end:
 *   - the email + password fields and the Google button render;
 *   - submitting valid creds calls `supabase.auth.signInWithPassword` with the
 *     entered values;
 *   - an auth failure renders a calm inline message (ADR-037) — no crash;
 *   - the Google button calls `supabase.auth.signInWithOAuth({ provider:
 *     'google', ... })`.
 *
 * LoginPage reads `useAuth()`, so it is wrapped in the real AuthProvider over a
 * mocked supabase client (the provider's `signIn*` delegate straight to the
 * mock). `useNavigate` is stubbed so the page renders without a router.
 */

import { afterEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ColorModeProvider } from '../../theme/colorMode'
import { AuthProvider } from '../../auth/AuthProvider'
import { LoginPage } from './LoginPage'
import {
  makeSupabaseAuthMock,
  type SupabaseAuthMock,
} from '../../test/authFixtures'

vi.mock('../../lib/supabase', () => ({
  supabase: { auth: undefined as unknown },
}))

// LoginPage's success-redirect effect calls useNavigate; stub it so no router
// is needed (the navigation target is covered by the route-guard suite).
vi.mock('@tanstack/react-router', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-router')>(
      '@tanstack/react-router',
    )
  return { ...actual, useNavigate: () => vi.fn() }
})

import { supabase } from '../../lib/supabase'

function installAuth(mock: SupabaseAuthMock): void {
  ;(supabase as { auth: unknown }).auth = mock.auth
}

afterEach(() => {
  vi.clearAllMocks()
})

/** Render LoginPage under the real AuthProvider (over the mocked client). */
function renderLogin() {
  return render(
    <ColorModeProvider>
      <AuthProvider>
        <LoginPage />
      </AuthProvider>
    </ColorModeProvider>,
  )
}

describe('LoginPage', () => {
  test('renders the email + password fields and the Google button', async () => {
    installAuth(makeSupabaseAuthMock())
    renderLogin()

    expect(await screen.findByLabelText(/Email/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Password/)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Continue with Google/ }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })

  test('submitting valid credentials calls signInWithPassword with the entered values', async () => {
    const mock = makeSupabaseAuthMock()
    installAuth(mock)
    const user = userEvent.setup()
    renderLogin()

    await user.type(await screen.findByLabelText(/Email/), 'sofia@example.com')
    await user.type(screen.getByLabelText(/Password/),'hunter2pass')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() =>
      expect(mock.auth.signInWithPassword).toHaveBeenCalledWith({
        email: 'sofia@example.com',
        password: 'hunter2pass',
      }),
    )
  })

  test('an auth error renders a calm inline message and does not crash', async () => {
    const mock = makeSupabaseAuthMock()
    mock.auth.signInWithPassword.mockResolvedValueOnce({
      error: { message: 'Invalid login credentials' },
    })
    installAuth(mock)
    const user = userEvent.setup()
    renderLogin()

    await user.type(await screen.findByLabelText(/Email/), 'sofia@example.com')
    await user.type(screen.getByLabelText(/Password/),'wrongpass')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    // The calm error surfaces in the live alert region; the form stays usable.
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Invalid login credentials')
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  })

  test('the Google button starts the OAuth flow via signInWithOAuth', async () => {
    const mock = makeSupabaseAuthMock()
    installAuth(mock)
    const user = userEvent.setup()
    renderLogin()

    await user.click(
      await screen.findByRole('button', { name: /Continue with Google/ }),
    )

    await waitFor(() =>
      expect(mock.auth.signInWithOAuth).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'google' }),
      ),
    )
  })
})
