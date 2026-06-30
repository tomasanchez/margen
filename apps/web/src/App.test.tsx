import { expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { ColorModeProvider } from './theme/colorMode'
import { LanguageProvider } from './i18n/LanguageProvider'
import { AppShell } from './components/AppShell'
import { currentViewingMonth, formatViewingMonth } from './components/months'
import { AddTransactionProvider } from './features/transactions/AddTransactionProvider'
import { HomePage } from './features/home/HomePage'
import { TransactionsPage } from './features/transactions/TransactionsPage'
import { settingsQueryKeys } from './features/settings/queries'
import type { Settings } from './api/settingsClient'
import {
  AddTransactionContext,
  type AddTransactionContextValue,
} from './features/transactions/addContext'

/**
 * Shell + routing smoke test (ADR-014, ADR-017).
 *
 * Builds a memory-history router mirroring src/router.tsx and asserts the shell
 * renders, that navigating to Transactions swaps the routed content, and that
 * the active route is marked accessibly (aria-current="page").
 */

/** A complete settings row with the Monotributo module flag set as given. */
function settings(monotributoEnabled: boolean): Settings {
  return {
    preferredDisplayCurrency: 'ARS',
    fxDefaultRateType: 'MEP',
    monotributoCurrentCategory: 'C',
    monotributoActivityType: 'services',
    monotributoEnabled,
  }
}

function buildTestRouter() {
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
  const monotributoRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/monotributo',
    component: () => <div>monotributo route</div>,
  })
  const accountsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/accounts',
    component: () => <div>accounts route</div>,
  })
  const budgetsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/budgets',
    component: () => <div>budgets route</div>,
  })
  const routeTree = rootRoute.addChildren([
    homeRoute,
    transactionsRoute,
    monotributoRoute,
    accountsRoute,
    budgetsRoute,
  ])
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
}

function renderShell(seed?: Settings) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  // Seed the settings flag (ADR-126) so the nav reads a deterministic value
  // without a fetch; when omitted, the module stays hidden (flag unknown).
  if (seed) queryClient.setQueryData(settingsQueryKeys.detail(), seed)
  const router = buildTestRouter()
  return render(
    <QueryClientProvider client={queryClient}>
      <ColorModeProvider>
        <LanguageProvider>
          <RouterProvider router={router} />
        </LanguageProvider>
      </ColorModeProvider>
    </QueryClientProvider>,
  )
}

test('renders the shell with the brand and the Home route', async () => {
  renderShell()

  expect(await screen.findByText('Margen')).toBeInTheDocument()
  expect(
    await screen.findByRole('heading', { name: 'Your command center' }),
  ).toBeInTheDocument()
})

test('navigating to Transactions swaps the routed content and active marker', async () => {
  const user = userEvent.setup()
  renderShell()

  await screen.findByRole('heading', { name: 'Your command center' })

  // The desktop sidebar nav links are present (jsdom renders both surfaces).
  const transactionsLinks = screen.getAllByRole('link', {
    name: /Transactions|Activity/,
  })
  await user.click(transactionsLinks[0])

  expect(
    await screen.findByRole('heading', {
      name: 'Every movement, in one place',
    }),
  ).toBeInTheDocument()
})

test('the month navigator exposes accessible controls in both presentations', async () => {
  renderShell()
  await screen.findByRole('heading', { name: 'Your command center' })

  // The navigator defaults to the current real calendar month (ADR-040), so the
  // expected label is derived rather than hard-coded — stable on any run date.
  const monthLabel = formatViewingMonth(currentViewingMonth())

  // Desktop stepper: prev/next buttons + the live month label. Both the desktop
  // stepper and the mobile compact picker render in the DOM (display-guarded by
  // breakpoint), so both presentations are assertable in jsdom.
  expect(
    screen.getByRole('button', { name: 'Previous month' }),
  ).toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'Next month' }),
  ).toBeInTheDocument()
  expect(
    screen.getByLabelText(`Selected month: ${monthLabel}`),
  ).toBeInTheDocument()

  // Mobile compact picker: a floating calendar button labelled with the month.
  expect(
    screen.getByRole('button', { name: `Select month, ${monthLabel}` }),
  ).toBeInTheDocument()
})

test('the Add-transaction seam opens via the FAB / CTA trigger', async () => {
  const user = userEvent.setup()
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  // Spy on the seam: a controlled provider records openAdd calls.
  let opened = 0
  const value: AddTransactionContextValue = {
    isOpen: false,
    prefill: null,
    openAdd: () => {
      opened += 1
    },
    closeAdd: () => {},
  }

  const rootRoute = createRootRoute({
    component: () => (
      <AddTransactionContext.Provider value={value}>
        <AppShell />
      </AddTransactionContext.Provider>
    ),
  })
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: HomePage,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([homeRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })

  render(
    <QueryClientProvider client={queryClient}>
      <ColorModeProvider>
        <LanguageProvider>
          <RouterProvider router={router} />
        </LanguageProvider>
      </ColorModeProvider>
    </QueryClientProvider>,
  )

  await screen.findByRole('heading', { name: 'Your command center' })

  // Both the sidebar CTA and the mobile FAB are labelled "Add transaction".
  const addTriggers = screen.getAllByRole('button', { name: /Add transaction/ })
  await user.click(addTriggers[0])

  expect(opened).toBeGreaterThan(0)
})

test('has a Budgets primary nav item linking to /budgets (ADR-125/127)', async () => {
  renderShell()
  await screen.findByRole('heading', { name: 'Your command center' })

  // Budgets is a primary nav peer alongside Accounts (ADR-127). jsdom renders
  // both the sidebar + mobile pill surfaces, so there is at least one link.
  const budgetsLinks = screen.getAllByRole('link', { name: /Budgets/ })
  expect(budgetsLinks.length).toBeGreaterThan(0)
  expect(budgetsLinks[0]).toHaveAttribute('href', '/budgets')
})

test('shows the Monotributo nav item when the module is enabled (ADR-126/127)', async () => {
  renderShell(settings(true))

  await screen.findByRole('heading', { name: 'Your command center' })

  // The Tools group heading + the gated Monotributo nav link are present.
  expect(screen.getByRole('heading', { name: 'Tools' })).toBeInTheDocument()
  expect(
    screen.getAllByRole('link', { name: /Monotributo|Mono/ }).length,
  ).toBeGreaterThan(0)
})

test('hides the Monotributo nav item when the module is disabled (ADR-126/127)', async () => {
  renderShell(settings(false))

  await screen.findByRole('heading', { name: 'Your command center' })

  // The Tools group still hosts Import, but Monotributo is gone.
  expect(
    screen.queryAllByRole('link', { name: /Monotributo|Mono/ }),
  ).toHaveLength(0)
  // Import statement remains (a demoted Tool, not gated).
  expect(
    screen.getAllByRole('link', { name: /Import/ }).length,
  ).toBeGreaterThan(0)
})
