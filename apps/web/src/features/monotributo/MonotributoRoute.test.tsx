/**
 * Monotributo route-guard tests (ADR-126, ADR-014, ADR-018).
 *
 * The route is settings-gated: when the optional Monotributo module is disabled
 * (`monotributoEnabled === false`) a direct visit redirects to Home (`/`); when
 * enabled the page renders; while settings are still loading the guard renders
 * nothing (no flash-then-redirect). These build a memory-history router with a
 * `/monotributo` guard + a `/` landing and drive the REAL `useMonotributoEnabled`
 * read over a seeded settings cache (mirroring how Home/nav read the flag).
 *
 * `MonotributoPage` is mocked to a sentinel so the gate is tested in isolation —
 * the page's own data wiring is covered in MonotributoPage.test.tsx.
 */

import { afterEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { ColorModeProvider } from '../../theme/colorMode'
import { MonotributoRoute } from './MonotributoRoute'
import { settingsQueryKeys } from '../settings/queries'
import type { Settings } from '../../api/settingsClient'

// The page itself is irrelevant to the gate — render a cheap sentinel so we can
// assert "the page rendered" without its data wiring.
vi.mock('./MonotributoPage', () => ({
  MonotributoPage: () => <div>monotributo page</div>,
}))

/** A complete settings row with the module flag set as given. */
function settings(monotributoEnabled: boolean): Settings {
  return {
    preferredDisplayCurrency: 'ARS',
    fxDefaultRateType: 'MEP',
    preferredRateSource: 'bolsa',
    monotributoCurrentCategory: 'C',
    monotributoActivityType: 'services',
    monotributoEnabled,
  }
}

/**
 * Render the guard under a memory router with `/monotributo` and `/`. When
 * `seed` is provided it is written into the settings cache so the flag resolves
 * synchronously; when omitted, settings stay pending (the loading case).
 */
function renderGuard(seed?: Settings) {
  const queryClient = new QueryClient({
    // No fetch in jsdom: keep the seeded cache fresh and never refetch. With no
    // seed the query stays pending (staleTime infinite, retry off).
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  if (seed) queryClient.setQueryData(settingsQueryKeys.detail(), seed)

  const rootRoute = createRootRoute()
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <div>home landing</div>,
  })
  const monotributoRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/monotributo',
    component: MonotributoRoute,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([homeRoute, monotributoRoute]),
    history: createMemoryHistory({ initialEntries: ['/monotributo'] }),
  })

  render(
    <QueryClientProvider client={queryClient}>
      <ColorModeProvider>
        <RouterProvider router={router} />
      </ColorModeProvider>
    </QueryClientProvider>,
  )
  return router
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('Monotributo route guard (ADR-126)', () => {
  test('renders the page when the module is enabled', async () => {
    renderGuard(settings(true))

    expect(await screen.findByText('monotributo page')).toBeInTheDocument()
    expect(screen.queryByText('home landing')).not.toBeInTheDocument()
  })

  test('redirects to Home when the module is disabled', async () => {
    const router = renderGuard(settings(false))

    expect(await screen.findByText('home landing')).toBeInTheDocument()
    expect(screen.queryByText('monotributo page')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/'),
    )
  })

  test('renders neither page nor redirect while settings are still loading', async () => {
    const router = renderGuard()

    // Flag unknown: the guard renders nothing and stays put (no flash, no
    // premature redirect) until settings resolve.
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/monotributo'),
    )
    expect(screen.queryByText('monotributo page')).not.toBeInTheDocument()
    expect(screen.queryByText('home landing')).not.toBeInTheDocument()
  })
})
