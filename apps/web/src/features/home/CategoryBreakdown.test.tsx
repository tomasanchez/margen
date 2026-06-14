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
import { CATEGORIES } from '../../mock/seed'
import type { Category, Transaction } from '../../mock/types'
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
  listMock.mockImplementation(() =>
    Promise.resolve(TRANSACTIONS_FIXTURE.map((t: Transaction) => ({ ...t }))),
  )
})

afterEach(() => {
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
    // Href carries the category query param so the screen opens pre-filtered.
    expect(link).toHaveAttribute('href', '/transactions?category=Food')
  })

  test('a row with no rise omits the "up" clause from the accessible name', async () => {
    renderBreakdown()

    const link = await screen.findByRole('link', {
      name: 'Rent, ARS 720.000 — view transactions',
    })
    expect(link).toHaveAttribute('href', '/transactions?category=Rent')
  })
})

// --- Integration: the real validated search → initialCategory wiring ---

const KNOWN_CATEGORIES = new Set<string>(CATEGORIES)

/** Mirror of router.tsx's validateTransactionsSearch (ADR-062). */
function validateTransactionsSearch(
  search: Record<string, unknown>,
): { category?: Category } {
  const raw = search.category
  return typeof raw === 'string' && KNOWN_CATEGORIES.has(raw)
    ? { category: raw as Category }
    : {}
}

/** Mount the real /transactions route at `entry`, wired exactly as router.tsx. */
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
    component: () => {
      const { category } = transactionsRoute.useSearch() as { category?: Category }
      return (
        <AddTransactionProvider>
          <TransactionsPage initialCategory={category} />
        </AddTransactionProvider>
      )
    },
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

describe('navigating to /transactions?category=Food', () => {
  test('opens the screen pre-filtered to Food (only Food rows, chip active)', async () => {
    renderTransactionsAt('/transactions?category=Food')

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
    // The route validator (mirror of router.tsx) drops any category not in the
    // known set, so an unknown ?category= resolves to no initial filter.
    expect(validateTransactionsSearch({ category: 'Bogus' })).toEqual({})
    expect(validateTransactionsSearch({ category: 'Food' })).toEqual({
      category: 'Food',
    })
  })

  test('no initial category renders the screen unfiltered', async () => {
    // initialCategory undefined (what a stripped/absent param yields) → the full
    // list shows rows across categories and the Category chip stays the base.
    renderWithProviders(<TransactionsPage initialCategory={undefined} />, {
      withAddProvider: true,
    })

    expect((await screen.findAllByText('Coto supermarket')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Apartment rent').length).toBeGreaterThan(0)
    expect(
      screen.getByRole('button', { name: 'Category' }),
    ).toBeInTheDocument()
  })
})
