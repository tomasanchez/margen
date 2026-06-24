/**
 * Route-guard tests (ADR-096, ADR-098, ADR-018).
 *
 * The pathless `_app` layout route guards every protected screen: an
 * unauthenticated visitor is redirected to `/login` with their intended
 * destination preserved in the `redirect` search param; an authenticated
 * visitor gets the protected page. These build a memory-history router that
 * mirrors src/router.tsx's structure (public `/login` + a guarded `_app`
 * layout) and drive the REAL guard via the typed router context — the same
 * `context.auth.session` check the production guard makes.
 *
 * Auth is fed through the router context exactly as AppRouter does in
 * production (`<RouterProvider context={{ auth }} />`); no Supabase client is
 * needed here because the guard reads only `context.auth.session`.
 */

import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router'
import type { AuthContextValue } from '../auth/authContext'
import type { RouterContext } from './context'
import { makeSession } from '../test/authFixtures'

/** A signed-out / signed-in auth context value for the router. */
function authValue(signedIn: boolean): AuthContextValue {
  return {
    session: signedIn ? makeSession() : null,
    user: signedIn ? makeSession().user : null,
    isLoading: false,
    signInWithPassword: async () => ({ error: null }),
    signInWithGoogle: async () => ({ error: null }),
    signOut: async () => {},
  }
}

/**
 * Build a router mirroring src/router.tsx: a public `/login` and a pathless
 * `_app` layout carrying the SAME guard (redirect to /login preserving the
 * intended path), wrapping a protected `/` home page.
 */
function buildGuardedRouter(auth: AuthContextValue, initialPath: string) {
  const rootRoute = createRootRouteWithContext<RouterContext>()({
    component: () => <Outlet />,
  })

  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    validateSearch: (search: Record<string, unknown>) =>
      typeof search.redirect === 'string'
        ? { redirect: search.redirect }
        : {},
    component: () => <div>login screen</div>,
  })

  const appLayoutRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: '_app',
    beforeLoad: ({ context, location }) => {
      if (!context.auth.session) {
        throw redirect({
          to: '/login',
          search: { redirect: location.href },
        })
      }
    },
    component: () => <Outlet />,
  })

  const homeRoute = createRoute({
    getParentRoute: () => appLayoutRoute,
    path: '/',
    component: () => <div>protected home</div>,
  })

  const settingsRoute = createRoute({
    getParentRoute: () => appLayoutRoute,
    path: '/settings',
    component: () => <div>protected settings</div>,
  })

  const routeTree = rootRoute.addChildren([
    loginRoute,
    appLayoutRoute.addChildren([homeRoute, settingsRoute]),
  ])

  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    context: { auth },
  })
}

function renderAt(auth: AuthContextValue, initialPath: string) {
  const router = buildGuardedRouter(auth, initialPath)
  render(<RouterProvider router={router} context={{ auth }} />)
  return router
}

describe('route guard', () => {
  test('redirects an unauthenticated visitor to /login, preserving the destination', async () => {
    const router = renderAt(authValue(false), '/settings')

    expect(await screen.findByText('login screen')).toBeInTheDocument()
    expect(screen.queryByText('protected settings')).not.toBeInTheDocument()

    // The intended destination is carried in the redirect param (no open
    // redirect: it is an in-app path).
    expect(router.state.location.pathname).toBe('/login')
    expect(router.state.location.search).toMatchObject({ redirect: '/settings' })
  })

  test('renders the protected page for an authenticated visitor', async () => {
    const router = renderAt(authValue(true), '/settings')

    expect(await screen.findByText('protected settings')).toBeInTheDocument()
    expect(screen.queryByText('login screen')).not.toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/settings')
  })

  test('lets an authenticated visitor reach the home route', async () => {
    renderAt(authValue(true), '/')

    expect(await screen.findByText('protected home')).toBeInTheDocument()
  })
})
