import {
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { AppShell } from './components/AppShell'
import { AddTransactionProvider } from './features/transactions/AddTransactionProvider'
import { HomePage } from './features/home/HomePage'
import { TransactionsPage } from './features/transactions/TransactionsPage'
import { MonotributoPage } from './features/monotributo/MonotributoPage'
import { SettingsPage } from './features/settings/SettingsPage'
import { CATEGORIES } from './mock/seed'
import type { Category } from './mock/types'

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
 * Code-based routing for Margen (ADR-014).
 *
 * A single root route renders the responsive shell. The shell's CTA/FAB need the
 * Add-transaction seam, so `AddTransactionProvider` wraps `AppShell` at the root
 * — the provider is the integration point for the (later) Add/Edit form. Child
 * routes mount the placeholder Home and Transactions pages into the shell's
 * <Outlet/>. We keep it minimal (no file-based plugin) for these few screens.
 */
const rootRoute = createRootRoute({
  component: () => (
    <AddTransactionProvider>
      <AppShell />
    </AddTransactionProvider>
  ),
})

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomePage,
})

const transactionsRoute = createRoute({
  getParentRoute: () => rootRoute,
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

const monotributoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/monotributo',
  component: MonotributoPage,
})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
})

const routeTree = rootRoute.addChildren([
  homeRoute,
  transactionsRoute,
  monotributoRoute,
  settingsRoute,
])

export const router = createRouter({
  routeTree,
  // Preload route modules on intent (hover/touch) for snappy navigation.
  defaultPreload: 'intent',
})

/** Register the router instance for type-safe navigation across the app. */
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
