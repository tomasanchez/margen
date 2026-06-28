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
import { AccountsPage } from './features/accounts/AccountsPage'
import { TransfersPage } from './features/transfers/TransfersPage'
import { ImportStatement } from './features/statements/ImportStatement'
import { MonotributoRoute } from './features/monotributo/MonotributoRoute'
import { SettingsPage } from './features/settings/SettingsPage'
import { LoginPage } from './features/auth/LoginPage'
import { validateTransactionsSearch } from './features/transactions/filtering'
import { TransactionsRoute } from './features/transactions/TransactionsRoute'
import type { RouterContext } from './router/context'

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
  // The route owns the router coupling (ADR-116): `TransactionsRoute` calls
  // `useTransactionFilters` (filters DERIVED from the validated search params;
  // controls navigate in `replace` mode) and passes the bundle to the
  // router-agnostic TransactionsPage as props. It lives in its own module so
  // this file keeps exporting only `router` (react-refresh components-only rule).
  component: TransactionsRoute,
})

const accountsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/accounts',
  component: AccountsPage,
})

const transfersRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/transfers',
  component: TransfersPage,
})

const importStatementRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/import-statement',
  component: ImportStatement,
})

const monotributoRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/monotributo',
  // Settings-gated: the route renders the page only when the optional module is
  // enabled, otherwise redirects to Home (ADR-126). See {@link MonotributoRoute}.
  component: MonotributoRoute,
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
    accountsRoute,
    transfersRoute,
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
