import {
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { AppShell } from './components/AppShell'
import { AddTransactionProvider } from './features/transactions/AddTransactionProvider'
import { HomePage } from './features/home/HomePage'
import { TransactionsPage } from './features/transactions/TransactionsPage'

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
  component: TransactionsPage,
})

const routeTree = rootRoute.addChildren([homeRoute, transactionsRoute])

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
