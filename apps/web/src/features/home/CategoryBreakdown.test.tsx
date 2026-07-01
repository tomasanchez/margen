/**
 * Category drilldown tests (Issue #6, ADR-062, test plan ADR-063).
 *
 * Two tiers:
 *  - Unit: a "Where it went" row renders as a router <Link> to
 *    `/transactions?category=<name>` with an explicit accessible name (so a
 *    category total is directly explainable and the link reads clearly to
 *    screen readers regardless of display currency, ADR-019/062).
 *  - Integration: navigating to `/transactions?category=Food` opens the
 *    Transactions screen pre-filtered to Food — only Food rows show and the
 *    Category filter chip reflects the seeded selection. A small memory router
 *    carries the real validated search → `initialCategory` wiring (mirroring
 *    `router.tsx`), and the transactions client is mocked (no network, ADR-038).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { ColorModeProvider } from '../../theme/colorMode'
import { CategoryBreakdown } from './CategoryBreakdown'
import { TransactionsPage } from '../transactions/TransactionsPage'
import { AddTransactionProvider } from '../transactions/AddTransactionProvider'
import { renderWithProviders } from '../../test/renderWithProviders'
import { validateTransactionsSearch } from '../transactions/filtering'
import { useTransactionFilters } from '../transactions/useTransactionFilters'
import type { Transaction } from '../../mock/types'
import type { CategorySpend } from '../../mock/types'
import { TRANSACTIONS_FIXTURE } from '../transactions/__fixtures__/transactions'

// Mock the HTTP-backed transactions client so the integration screen resolves
// from the fixture with no real backend (ADR-038).
const { listMock } = vi.hoisted(() => ({ listMock: vi.fn() }))
vi.mock('../../api/transactionsClient', () => ({
  transactionsClient: {
    list: listMock,
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}))

beforeEach(() => {
  // Pin "today" inside the fixture window (June 2026). The Transactions page
  // defaults its month to the current month (ADR-040), so an unpinned clock on a
  // month outside the fixture would leave the default (no-param) view empty.
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date(2026, 5, 15, 12))
  listMock.mockImplementation(() =>
    Promise.resolve(TRANSACTIONS_FIXTURE.map((t: Transaction) => ({ ...t }))),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

const CATEGORIES_FIXTURE: CategorySpend[] = [
  { category: 'Food', amount: 38_400, pct: 60, up: '+22%' },
  { category: 'Rent', amount: 720_000, pct: 40 },
]

/** Render the card alone behind a memory router so its drill-in links resolve. */
function renderBreakdown() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute({
    component: () => <CategoryBreakdown categories={CATEGORIES_FIXTURE} />,
  })
  const transactionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/transactions',
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([transactionsRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ColorModeProvider>
        <RouterProvider router={router} />
      </ColorModeProvider>
    </QueryClientProvider>,
  )
}

describe('CategoryBreakdown drill-in links', () => {
  test('a row links to /transactions with the category search param', async () => {
    renderBreakdown()

    const link = await screen.findByRole('link', {
      name: 'Food, ARS 38.400, up +22% — view transactions',
    })
    // Href carries the category + explicit month=all window (ADR-062/ADR-116:
    // the category drilldown opens at All-time) so the screen opens pre-filtered.
    expect(link).toHaveAttribute('href', '/transactions?category=Food&month=all')
  })

  test('a row with no rise omits the "up" clause from the accessible name', async () => {
    renderBreakdown()

    const link = await screen.findByRole('link', {
      name: 'Rent, ARS 720.000 — view transactions',
    })
    expect(link).toHaveAttribute(
      'href',
      '/transactions?category=Rent&month=all',
    )
  })
})

// --- Integration: the real validated search → URL-synced filters (ADR-116) ---

/** The /transactions route component, wired exactly as router.tsx (ADR-116). */
function TransactionsRouteForTest() {
  const { filters, controls } = useTransactionFilters()
  return (
    <AddTransactionProvider>
      <TransactionsPage filters={filters} controls={controls} />
    </AddTransactionProvider>
  )
}

/**
 * Mount the `/transactions` route at `entry`, wired EXACTLY as router.tsx: the
 * real `validateTransactionsSearch`, the URL-synced `useTransactionFilters`, and
 * the page consuming the resulting `{ filters, controls }`. This is the true
 * deep-link path now that the URL is the single source of truth.
 */
function renderTransactionsAt(entry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute({
    component: () => <Outlet />,
  })
  const transactionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/transactions',
    validateSearch: validateTransactionsSearch,
    component: TransactionsRouteForTest,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([transactionsRoute]),
    history: createMemoryHistory({ initialEntries: [entry] }),
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ColorModeProvider>
        <RouterProvider router={router} />
      </ColorModeProvider>
    </QueryClientProvider>,
  )
}

describe('navigating to /transactions?category=Food&month=all', () => {
  test('opens the screen pre-filtered to Food (only Food rows, chip active)', async () => {
    // The category drilldown link carries month=all (All-time window, ADR-062),
    // so all Food rows across months are visible.
    renderTransactionsAt('/transactions?category=Food&month=all')

    // The three Food rows surface; non-Food rows are filtered out.
    expect((await screen.findAllByText('Coto supermarket')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Carrefour').length).toBeGreaterThan(0)
    expect(screen.queryByText('Apartment rent')).not.toBeInTheDocument()
    expect(screen.queryByText('Uber')).not.toBeInTheDocument()

    // The Category filter chip reflects the single seeded selection.
    expect(
      screen.getByRole('button', { name: 'Category · 1' }),
    ).toBeInTheDocument()
  })

  test('an unknown category param is stripped by validateSearch (no-op)', () => {
    // The real router validator drops any category not in the known set, so an
    // unknown ?category= resolves to no filter param at all.
    expect(validateTransactionsSearch({ category: 'Bogus' })).toEqual({})
    expect(validateTransactionsSearch({ category: 'Food' })).toEqual({
      category: 'Food',
    })
  })

  test('no category param renders the screen unfiltered', async () => {
    // A stripped/absent param → no category filter; the (standalone) page shows
    // rows across categories and the Category chip stays the base.
    renderWithProviders(<TransactionsPage />, { withAddProvider: true })

    expect((await screen.findAllByText('Coto supermarket')).length).toBeGreaterThan(0)
    // Apartment rent is May-dated; widen to All time so it is in view regardless
    // of the run month.
    const monthTrigger = screen.getAllByRole('button', { name: /^Month:/ })[0]
    const user = (await import('@testing-library/user-event')).default.setup()
    await user.click(monthTrigger)
    await user.click(await screen.findByRole('menuitem', { name: /All time/ }))
    expect(screen.getAllByText('Apartment rent').length).toBeGreaterThan(0)
    expect(
      screen.getByRole('button', { name: 'Category' }),
    ).toBeInTheDocument()
  })
})
