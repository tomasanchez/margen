/**
 * Unit tests for the Home budget-progress card (ADR-125, ADR-127, ADR-037).
 *
 * Renders the presentational card directly with given props (no network):
 *
 *  - with budgets set, it headlines budgeted-vs-spent and links to /budgets;
 *  - with no targets set, it shows the neutral "set up budgets" prompt + link;
 *  - while loading it shows a skeleton (no crash on undefined period);
 *  - on error it shows the calm fallback.
 *
 * The card renders TanStack <Link>s, so it mounts behind a memory router (the
 * same approach the CategoryBreakdown / Accounts drilldown tests use).
 * English-pinned (ADR-105).
 */

import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { ColorModeProvider } from '../../theme/colorMode'
import { BudgetProgressCard, type BudgetProgressCardProps } from './BudgetProgressCard'
import type { BudgetPeriod } from '../../api/budgetsClient'

const PERIOD: BudgetPeriod = {
  month: '2026-06',
  currency: 'ARS',
  savings: [],
  floor: null,
  suggestedStrategy: null,
  pressure: null,
  categories: [
    { category: 'Food', target: '120000.00', spent: '90000.00', remaining: '30000.00' },
    { category: 'Rent', target: '200000.00', spent: '230000.00', remaining: '-30000.00' },
    { category: 'Transport', target: null, spent: '15000.00', remaining: null },
  ],
}

const EMPTY_PERIOD: BudgetPeriod = {
  month: '2026-06',
  currency: 'ARS',
  savings: [],
  floor: null,
  suggestedStrategy: null,
  pressure: null,
  categories: [
    { category: 'Food', target: null, spent: '90000.00', remaining: null },
  ],
}

function renderCard(props: Partial<BudgetProgressCardProps>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute({
    component: () => (
      <BudgetProgressCard
        period={props.period}
        income={props.income}
        showRepriceNudge={props.showRepriceNudge}
        loading={props.loading ?? false}
        isError={props.isError}
        onRetry={props.onRetry}
      />
    ),
  })
  const budgetsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/budgets',
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([budgetsRoute]),
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

describe('BudgetProgressCard', () => {
  test('headlines budgeted-vs-spent and links to Budgets', async () => {
    renderCard({ period: PERIOD })

    // Budgeted = 320000, spent (budgeted only) = 320000 → "ARS 320.000 of ARS 320.000".
    expect(
      await screen.findByText('ARS 320.000 of ARS 320.000'),
    ).toBeInTheDocument()

    // Over budget by 0? Here spent === budgeted, so remaining is 0 → "left" line.
    // Rent is over its own target, so it appears in the attention list.
    expect(screen.getByText('Closest to limit')).toBeInTheDocument()
    expect(screen.getByText('Rent')).toBeInTheDocument()

    const manage = screen.getByRole('link', { name: /Manage budgets/ })
    expect(manage).toHaveAttribute('href', '/budgets')
  })

  test('shows the set-up prompt when no targets are set', async () => {
    renderCard({ period: EMPTY_PERIOD })
    expect(
      await screen.findByText(/Set monthly targets per category/),
    ).toBeInTheDocument()
    const setUp = screen.getByRole('link', { name: 'Set up budgets' })
    expect(setUp).toHaveAttribute('href', '/budgets')
  })

  test('shows a skeleton while loading without crashing', async () => {
    const { container } = renderCard({ period: undefined, loading: true })
    expect(
      await screen.findByRole('heading', { name: 'Budget progress' }),
    ).toBeInTheDocument()
    expect(container.querySelector('.MuiSkeleton-root')).toBeTruthy()
  })

  test('shows the calm error fallback on error', async () => {
    renderCard({ period: undefined, isError: true })
    expect(
      await screen.findByRole('heading', { name: 'Budget data unavailable' }),
    ).toBeInTheDocument()
  })

  test('shows the compact net-income / saved line (ADR-139)', async () => {
    renderCard({
      period: {
        ...PERIOD,
        savings: [{ bucket: 'EmergencyFund', percent: 7, amount: '70000.00' }],
      },
      income: {
        month: '2026-06',
        amount: '1000000.00',
        currency: 'ARS',
        source: 'manual',
        floor: null,
      },
    })
    expect(
      await screen.findByText('Net income ARS 1.000.000 · saved ARS 70.000'),
    ).toBeInTheDocument()
  })

  test('surfaces the reprice nudge linking to Budgets (ADR-137)', async () => {
    renderCard({ period: PERIOD, showRepriceNudge: true })
    const nudge = await screen.findByRole('link', {
      name: /reprice your budget/i,
    })
    expect(nudge).toHaveAttribute('href', '/budgets')
  })
})
