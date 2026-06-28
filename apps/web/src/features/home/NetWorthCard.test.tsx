/**
 * Unit tests for the Home net-worth card (ADR-122/123/127/133/134).
 *
 * The card renders fed a {@link NetWorth} read model directly — the `useNetWorth`
 * query + client adapter are covered separately (accountsClient.test). Here we
 * assert the presentation: the total in the display currency, the breakdown
 * GROUPED BY INSTITUTION (a header per institution + a type cue, its per-currency
 * accounts with the converted line when in another currency, and a per-institution
 * subtotal in the display currency, ADR-134), the ADR-133 DEGRADE case
 * (balanceConverted === balance → no second line, calm note shown), the account
 * drilldown link, the empty state, and the loading skeleton. The card renders
 * TanStack <Link>s, so it mounts behind a memory router. English-pinned (ADR-105).
 */

import { describe, expect, test } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

/** Click "Show details" to expand the collapsible institution breakdown. */
async function expandDetails() {
  const toggle = await screen.findByRole('button', { name: 'Show details' })
  await userEvent.click(toggle)
  return toggle
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

/**
 * One institution holding TWO per-currency accounts (ARS + USD), to prove the
 * accounts group under a single institution header and that the per-institution
 * subtotal sums their converted balances (ADR-134).
 */
const MULTI_ACCOUNT: NetWorth = {
  total: '1100000.00',
  currency: 'ARS',
  accounts: [
    {
      id: 'b-usd',
      institutionId: 'inst-1',
      institutionName: 'Galicia',
      type: 'bank',
      currency: 'USD',
      balance: '760.00',
      balanceConverted: '950000.00',
    },
    {
      id: 'b-ars',
      institutionId: 'inst-1',
      institutionName: 'Galicia',
      type: 'bank',
      currency: 'ARS',
      balance: '150000.00',
      balanceConverted: '150000.00',
    },
  ],
}

describe('NetWorthCard', () => {
  test('renders the total in the display currency and the per-account breakdown', async () => {
    renderCard({ netWorth: CONVERTED, loading: false })

    // Total in the display currency (ARS, es-AR grouping → 1.050.000).
    expect(await screen.findByText('ARS 1.050.000')).toBeInTheDocument()

    await expandDetails()

    // Each institution name + native balance is shown (USD 720 also appears in
    // the USD-holdings callout, hence getAllByText).
    expect(screen.getByText('Galicia')).toBeInTheDocument()
    expect(screen.getByText('Deel')).toBeInTheDocument()
    expect(screen.getAllByText('USD 720').length).toBeGreaterThanOrEqual(1)

    // The USD account shows its converted ARS value as a secondary line.
    expect(screen.getByText('≈ ARS 900.000')).toBeInTheDocument()
  })

  test('groups multiple accounts under one institution header with a subtotal', async () => {
    renderCard({ netWorth: MULTI_ACCOUNT, loading: false })

    await expandDetails()

    // The institution header appears exactly once even with two accounts.
    expect(await screen.findAllByText('Galicia')).toHaveLength(1)

    // Both per-currency native balances render under that institution (USD 760
    // also appears in the USD-holdings callout, hence getAllByText).
    expect(screen.getAllByText('USD 760').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('ARS 150.000')).toBeInTheDocument()

    // The per-institution subtotal sums the converted balances (950.000 + 150.000).
    expect(
      screen.getByLabelText('Galicia subtotal ARS 1.100.000'),
    ).toBeInTheDocument()
  })

  test('renders a per-institution subtotal for each institution group', async () => {
    renderCard({ netWorth: CONVERTED, loading: false })

    await expandDetails()

    // Each single-account institution's subtotal equals its converted balance.
    expect(
      await screen.findByLabelText('Galicia subtotal ARS 150.000'),
    ).toBeInTheDocument()
    expect(
      screen.getByLabelText('Deel subtotal ARS 900.000'),
    ).toBeInTheDocument()
  })

  test('each breakdown row links to its account drilldown', async () => {
    renderCard({ netWorth: CONVERTED, loading: false })
    await expandDetails()
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
    await expandDetails()

    // Native balance shown (the breakdown row + the USD-holdings callout both
    // read USD 720); no "≈" converted line — conversion was skipped, and with no
    // derivable rate the callout omits its ARS approximation too (ADR-133).
    expect((await screen.findAllByText('USD 720')).length).toBeGreaterThanOrEqual(
      1,
    )
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
    await expandDetails()
    // The total, the single ARS row, and the institution subtotal all read
    // "ARS 150.000" (grand total + the one account + its one-account subtotal).
    expect(await screen.findAllByText('ARS 150.000')).toHaveLength(3)
    expect(screen.queryByText(/≈/)).not.toBeInTheDocument()
    // Not a cross-currency degrade — no native-sum note for an all-ARS portfolio.
    expect(
      screen.queryByText(/Totalled in each account's own currency/i),
    ).not.toBeInTheDocument()
  })

  test('keeps the breakdown collapsed by default and toggles it open/closed', async () => {
    renderCard({ netWorth: CONVERTED, loading: false })

    // Collapsed by default: the toggle reads "Show details", is aria-collapsed,
    // and the institution breakdown is not yet in the DOM (unmountOnExit).
    const toggle = await screen.findByRole('button', { name: 'Show details' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Deel')).not.toBeInTheDocument()

    // Expand: aria-expanded flips, label changes, breakdown appears.
    await userEvent.click(toggle)
    const open = await screen.findByRole('button', { name: 'Hide details' })
    expect(open).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Deel')).toBeInTheDocument()
    const region = screen.getByRole('region', {
      name: 'Net worth breakdown by institution',
    })
    expect(open).toHaveAttribute('aria-controls', region.id)

    // Collapse again: label resets and the breakdown leaves the DOM once the
    // Collapse exit transition finishes (unmountOnExit).
    await userEvent.click(open)
    expect(
      await screen.findByRole('button', { name: 'Show details' }),
    ).toHaveAttribute('aria-expanded', 'false')
    await waitFor(() =>
      expect(screen.queryByText('Deel')).not.toBeInTheDocument(),
    )
  })

  test('shows the USD-holdings callout with the ARS approximation (display = ARS)', async () => {
    renderCard({ netWorth: CONVERTED, loading: false })

    // Real USD = sum of USD account native balances (just a2: 720).
    expect(await screen.findByText('USD holdings')).toBeInTheDocument()
    expect(screen.getByText('USD 720')).toBeInTheDocument()
    // ARS approximation = sum of converted USD balances (900.000), and the
    // implied rate = 900.000 / 720 = 1.250 ARS per USD.
    expect(
      screen.getByText('≈ ARS 900.000 (at AR$ 1.250 / US$)'),
    ).toBeInTheDocument()
  })

  test('hides the USD-holdings callout when there are no USD accounts', async () => {
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
    await screen.findByText('ARS 150.000')
    expect(screen.queryByText('USD holdings')).not.toBeInTheDocument()
  })

  test('omits the ARS approximation when no rate can be derived (degrade)', async () => {
    // A USD-only, degraded response (balanceConverted === balance): real USD is
    // shown, but with no cross-currency figure the ARS approximation is omitted.
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
    expect(await screen.findByText('USD holdings')).toBeInTheDocument()
    expect(screen.getAllByText('USD 720').length).toBeGreaterThanOrEqual(1)
    // No "(at … / US$)" approximation line when the rate is not derivable.
    expect(screen.queryByText(/US\$\)/)).not.toBeInTheDocument()
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
