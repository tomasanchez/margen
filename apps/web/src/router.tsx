import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
  Outlet,
} from '@tanstack/react-router'
import { AppShell } from './components/AppShell'
import { AddTransactionProvider } from './features/transactions/AddTransactionProvider'
import { HomePage } from './features/home/HomePage'
import { TransactionsPage } from './features/transactions/TransactionsPage'
import { ImportStatement } from './features/statements/ImportStatement'
import { MonotributoPage } from './features/monotributo/MonotributoPage'
import { SettingsPage } from './features/settings/SettingsPage'
import { LoginPage } from './features/auth/LoginPage'
import { CATEGORIES } from './mock/seed'
import type { Category } from './mock/types'
import type { RouterContext } from './router/context'

/**
 * Search params accepted by the `/transactions` route (ADR-062).
 *
 * `category` is an optional drilldown seed: a Home "Where it went" row links to
 * `/transactions?category=<name>` and the screen opens pre-filtered to it. The
 * value is validated against the known {@link Category} union so an absent or
 * unknown param is a no-op (`undefined`) rather than seeding a bogus filter.
 */
export interface TransactionsSearch {
  category?: Category
}

/** A Set of the known categories for O(1) validation of the search param. */
const KNOWN_CATEGORIES = new Set<string>(CATEGORIES)

/** Validate (and narrow) the `/transactions` search params (ADR-062). */
function validateTransactionsSearch(
  search: Record<string, unknown>,
): TransactionsSearch {
  const raw = search.category
  return typeof raw === 'string' && KNOWN_CATEGORIES.has(raw)
    ? { category: raw as Category }
    : {}
}

/**
 * Search params accepted by the public `/login` route (ADR-096).
 *
 * `redirect` carries the path the user was trying to reach before the guard
 * bounced them here, so a successful sign-in returns them to their intended
 * destination. Only same-origin app paths are accepted (must start with `/`
 * and not `//`) so the value can never be coerced into an open redirect.
 */
export interface LoginSearch {
  redirect?: string
}

/** Validate the `/login` `redirect` param to a safe in-app path (or undefined). */
function validateLoginSearch(search: Record<string, unknown>): LoginSearch {
  const raw = search.redirect
  return typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//')
    ? { redirect: raw }
    : {}
}

/**
 * Code-based routing for Margen (ADR-014, ADR-096).
 *
 * The root route is typed with the auth-bearing {@link RouterContext} so every
 * `beforeLoad` can read `context.auth`. It renders only an `<Outlet/>`; the
 * shell + Add-transaction seam live on a pathless `_app` layout route that ALSO
 * carries the auth guard — so all protected screens are gated in one place and
 * the public `/login` route renders chrome-free, outside the shell.
 */
const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
})

/** Public sign-in route (ADR-096) — no guard, no app shell. */
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: validateLoginSearch,
  component: () => {
    const { redirect: redirectTo } = loginRoute.useSearch()
    return <LoginPage redirectTo={redirectTo ?? '/'} />
  },
})

/**
 * The authenticated app layout (ADR-096). A pathless route that guards every
 * child: an unauthenticated visitor is redirected to `/login` with the intended
 * path preserved in the `redirect` search param. Authenticated users get the
 * shell + Add-transaction seam wrapping the routed `<Outlet/>`.
 */
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
  component: () => (
    <AddTransactionProvider>
      <AppShell />
    </AddTransactionProvider>
  ),
})

const homeRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/',
  component: HomePage,
})

const transactionsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/transactions',
  validateSearch: validateTransactionsSearch,
  // Read the validated `category` search param here and seed the screen's
  // category filter from it (ADR-062); this keeps TransactionsPage
  // router-agnostic (rendrable standalone in tests).
  component: () => {
    const { category } = transactionsRoute.useSearch()
    return <TransactionsPage initialCategory={category} />
  },
})

const importStatementRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/import-statement',
  component: ImportStatement,
})

const monotributoRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/monotributo',
  component: MonotributoPage,
})

const settingsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/settings',
  component: SettingsPage,
})

const routeTree = rootRoute.addChildren([
  loginRoute,
  appLayoutRoute.addChildren([
    homeRoute,
    transactionsRoute,
    importStatementRoute,
    monotributoRoute,
    settingsRoute,
  ]),
])

export const router = createRouter({
  routeTree,
  // Preload route modules on intent (hover/touch) for snappy navigation.
  defaultPreload: 'intent',
  // The live auth value is injected per-render from main.tsx; this is just the
  // initial placeholder so the type is satisfied before the provider mounts.
  context: undefined as unknown as RouterContext,
})

/** Register the router instance for type-safe navigation across the app. */
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
