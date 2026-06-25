/**
 * Language-switch interaction test for AccountMenu (ADR-104, ADR-101, ADR-105).
 *
 * The account menu hosts the app's sole runtime language selector (ADR-104),
 * wired to the real `LanguageProvider`/`useLanguage` (ADR-101). This drives the
 * REAL control: open the menu, change the Select to Español, and assert the
 * user-visible outcome — the menu's own labels flip to their Spanish strings
 * and the exposed `useLanguage().language` becomes `'es'`.
 *
 * The global setup pins i18next to English (ADR-105); this test mutates the
 * shared instance via `changeLanguage`, so an `afterEach` resets the language
 * to `en` and clears the persisted `margen.language` key to prevent locale
 * leakage into the rest of the en-pinned suite.
 *
 * jsdom reports no media match, so the desktop Menu surface is exercised (same
 * convention as AccountMenu.logout.test.tsx).
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
import i18n from 'i18next'
import { ColorModeProvider } from '../theme/colorMode'
import { LanguageProvider } from '../i18n/LanguageProvider'
import { useLanguage } from '../i18n/languageContext'
import { LANGUAGE_STORAGE_KEY } from '../i18n/resources'
import { AccountMenu } from './AccountMenu'

// AccountMenu reads the live Supabase user via useAuth; mock the client so the
// AuthProvider resolves an anonymous (signed-out) session without network.
vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () =>
        Promise.resolve({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({
        data: { subscription: { unsubscribe: () => {} } },
      }),
      signOut: () => Promise.resolve({ error: null }),
    },
  },
}))

import { AuthProvider } from '../auth/AuthProvider'

// Surfaces the live context language as text so the test can assert on the
// React state the selector drives (not just i18next's internal language).
function LanguageProbe() {
  const { language } = useLanguage()
  return <div data-testid="active-language">{language}</div>
}

/** Memory router so AccountMenu's `useNavigate` resolves (mirrors logout test). */
function renderAccountMenu() {
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <>
        <AccountMenu />
        <LanguageProbe />
      </>
    ),
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([homeRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })

  return render(
    <ColorModeProvider>
      <LanguageProvider>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </LanguageProvider>
    </ColorModeProvider>,
  )
}

afterEach(async () => {
  // Reset the shared i18next instance and the persisted choice so the rest of
  // the en-pinned suite (ADR-105) stays green regardless of test order.
  await i18n.changeLanguage('en')
  window.localStorage.removeItem(LANGUAGE_STORAGE_KEY)
})

describe('AccountMenu language selector', () => {
  test('defaults to English from the pinned test setup', async () => {
    renderAccountMenu()

    // AuthProvider renders a "checking session" state until getSession resolves;
    // wait for the menu (and probe) to mount before asserting the locale.
    expect(
      await screen.findByRole('button', { name: 'Account menu' }),
    ).toBeInTheDocument()
    expect(screen.getByTestId('active-language')).toHaveTextContent('en')
  })

  test('selecting Español switches the UI and context language to Spanish', async () => {
    const user = userEvent.setup()
    renderAccountMenu()

    // Open the desktop Menu surface.
    await user.click(
      await screen.findByRole('button', { name: 'Account menu' }),
    )

    // The selector is labelled by the English "Language" string while en is
    // active; pick the Español option from its listbox.
    await user.click(await screen.findByRole('combobox', { name: 'Language' }))
    await user.click(await screen.findByRole('option', { name: 'Español' }))

    // Context state flips to 'es' (the selector drives useLanguage().setLanguage).
    await waitFor(() =>
      expect(screen.getByTestId('active-language')).toHaveTextContent('es'),
    )

    // i18next's active language reflects the switch.
    expect(i18n.language).toBe('es')

    // The menu's own labels now resolve to their Spanish catalog strings: the
    // selector's aria-label is "Idioma" and the row label likewise localizes.
    await waitFor(() =>
      expect(
        screen.getByRole('combobox', { name: 'Idioma' }),
      ).toBeInTheDocument(),
    )
    expect(
      screen.getByRole('menuitem', { name: /Cerrar sesión/ }),
    ).toBeInTheDocument()

    // The choice is persisted to localStorage (ADR-101 parity with dark mode).
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('es')
  })
})
