/**
 * Unit tests for the Home net-worth card (ADR-122/123/127/133/134).
 *
 * The card renders fed a {@link NetWorth} read model directly — the `useNetWorth`
 * query + client adapter are covered separately (accountsClient.test). Here we
 * assert the presentation: the total in the display currency, the per-account
 * breakdown (institution name + currency + native balance, plus the converted
 * line when the account is in another currency, ADR-134), the ADR-133 DEGRADE
 * case (balanceConverted === balance → no second line, calm note shown), the
 * account drilldown link, the empty state, and the loading skeleton. The card now
 * renders TanStack <Link>s, so it mounts behind a memory router. English-pinned
 * (ADR-105).
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
import { NetWorthCard, type NetWorthCardProps } from './NetWorthCard'
import type { NetWorth } from '../../api/accountsClient'

/** Render the card behind a memory router so its drilldown <Link>s resolve. */
function renderCard(props: NetWorthCardProps) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute({
    component: () => <NetWorthCard {...props} />,
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

/** Mixed-currency net worth with a real USD→ARS conversion applied. */
const CONVERTED: NetWorth = {
  total: '1050000.00',
  currency: 'ARS',
  accounts: [
    {
      id: 'a1',
      institutionId: 'inst-1',
      institutionName: 'Galicia',
      type: 'bank',
      currency: 'ARS',
      balance: '150000.00',
      balanceConverted: '150000.00',
    },
    {
      id: 'a2',
      institutionId: 'inst-2',
      institutionName: 'Deel',
      type: 'wallet',
      currency: 'USD',
      balance: '720.00',
      balanceConverted: '900000.00',
    },
  ],
}

describe('NetWorthCard', () => {
  test('renders the total in the display currency and the per-account breakdown', async () => {
    renderCard({ netWorth: CONVERTED, loading: false })

    // Total in the display currency (ARS, es-AR grouping → 1.050.000).
    expect(await screen.findByText('ARS 1.050.000')).toBeInTheDocument()

    // Each institution name + native balance is shown.
    expect(screen.getByText('Galicia')).toBeInTheDocument()
    expect(screen.getByText('Deel')).toBeInTheDocument()
    expect(screen.getByText('USD 720')).toBeInTheDocument()

    // The USD account shows its converted ARS value as a secondary line.
    expect(screen.getByText('≈ ARS 900.000')).toBeInTheDocument()
  })

  test('each breakdown row links to its account drilldown', async () => {
    renderCard({ netWorth: CONVERTED, loading: false })
    const link = await screen.findByRole('link', {
      name: 'View Deel USD transactions',
    })
    expect(link).toHaveAttribute('href', '/transactions?account=a2&month=all')
  })

  test('degrade case (ADR-133): equal balances render no converted line + a calm note', async () => {
    const degraded: NetWorth = {
      total: '720.00',
      currency: 'ARS',
      accounts: [
        {
          id: 'a2',
          institutionId: 'inst-2',
          institutionName: 'Deel',
          type: 'wallet',
          currency: 'USD',
          balance: '720.00',
          balanceConverted: '720.00',
        },
      ],
    }
    renderCard({ netWorth: degraded, loading: false })

    // Native balance shown; no "≈" converted line (conversion was skipped).
    expect(await screen.findByText('USD 720')).toBeInTheDocument()
    expect(screen.queryByText(/≈/)).not.toBeInTheDocument()

    // The calm degrade note explains the native-summed total.
    expect(
      screen.getByText(/Totalled in each account's own currency/i),
    ).toBeInTheDocument()
  })

  test('does not render a converted line for an account already in display currency', async () => {
    const arsOnly: NetWorth = {
      total: '150000.00',
      currency: 'ARS',
      accounts: [
        {
          id: 'a1',
          institutionId: 'inst-1',
          institutionName: 'Galicia',
          type: 'bank',
          currency: 'ARS',
          balance: '150000.00',
          balanceConverted: '150000.00',
        },
      ],
    }
    renderCard({ netWorth: arsOnly, loading: false })
    // The total and the single ARS row both read "ARS 150.000".
    expect(await screen.findAllByText('ARS 150.000')).toHaveLength(2)
    expect(screen.queryByText(/≈/)).not.toBeInTheDocument()
    // Not a cross-currency degrade — no native-sum note for an all-ARS portfolio.
    expect(
      screen.queryByText(/Totalled in each account's own currency/i),
    ).not.toBeInTheDocument()
  })

  test('shows the empty state when there are no accounts', async () => {
    const empty: NetWorth = { total: '0.00', currency: 'ARS', accounts: [] }
    renderCard({ netWorth: empty, loading: false })
    expect(
      await screen.findByText('Add an account to see your net worth here.'),
    ).toBeInTheDocument()
  })

  test('shows a loading skeleton while pending', async () => {
    const { container } = renderCard({ netWorth: undefined, loading: true })
    await screen.findByText('Net worth')
    expect(container.querySelector('.MuiSkeleton-root')).toBeInTheDocument()
  })

  test('shows a calm error state when the query errored', async () => {
    renderCard({ netWorth: undefined, loading: false, isError: true })
    expect(
      await screen.findByText('Net worth unavailable'),
    ).toBeInTheDocument()
  })
})
