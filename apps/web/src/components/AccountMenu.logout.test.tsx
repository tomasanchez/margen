/**
 * Logout interaction test for AccountMenu (ADR-096, ADR-098, ADR-018).
 *
 * "Sign out" ends the real Supabase session and returns the user to `/login`.
 * With the Supabase client mocked (ADR-098), this drives the REAL provider
 * `signOut` and asserts the user-visible outcome: clicking Sign out calls
 * `supabase.auth.signOut` and the router lands on `/login`.
 *
 * AccountMenu is rendered under the real AuthProvider (over a mocked, signed-in
 * client) and a memory-history router so `useNavigate` resolves; jsdom reports
 * no media match, so the desktop Menu surface is exercised.
 */

import { afterEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { ColorModeProvider } from '../theme/colorMode'
import { LanguageProvider } from '../i18n/LanguageProvider'
import { AuthProvider } from '../auth/AuthProvider'
import { AccountMenu } from './AccountMenu'
import {
  makeSession,
  makeSupabaseAuthMock,
  type SupabaseAuthMock,
} from '../test/authFixtures'

vi.mock('../lib/supabase', () => ({
  supabase: { auth: undefined as unknown },
}))

import { supabase } from '../lib/supabase'

function installAuth(mock: SupabaseAuthMock): void {
  ;(supabase as { auth: unknown }).auth = mock.auth
}

afterEach(() => {
  vi.clearAllMocks()
})

/** A memory router whose home renders AccountMenu and `/login` a marker. */
function renderAccountMenu() {
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <AccountMenu />,
  })
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: () => <div>login screen</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([homeRoute, loginRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })

  render(
    <ColorModeProvider>
      <LanguageProvider>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </LanguageProvider>
    </ColorModeProvider>,
  )
  return router
}

describe('AccountMenu logout', () => {
  test('Sign out ends the Supabase session and routes to /login', async () => {
    const mock = makeSupabaseAuthMock({ initialSession: makeSession() })
    installAuth(mock)
    const user = userEvent.setup()
    const router = renderAccountMenu()

    // Open the account surface, then choose Sign out.
    await user.click(await screen.findByRole('button', { name: 'Account menu' }))
    await user.click(await screen.findByRole('menuitem', { name: /Sign out/ }))

    await waitFor(() => expect(mock.auth.signOut).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
  })
})
