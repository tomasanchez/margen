/**
 * Unit tests for the Home net-worth card (ADR-122/123/127/133/134).
 *
 * The card renders fed a {@link NetWorth} read model directly — the `useNetWorth`
 * query + client adapter are covered separately (accountsClient.test). The card
 * computes its headline CLIENT-SIDE from each account's NATIVE balance + the LIVE
 * SELECTED rate (ADR-133 amendment), so these tests MOCK `fetchSuggestedRates` to
 * fixed values (distinct MEP vs Official, or null for the degrade case) and assert
 * the presentation: the headline total in the display currency, the currency
 * decomposition line (`<native> + ~ <converted> (<otherNative> at <Source> ARS
 * <rate> / USD)`), the breakdown GROUPED BY INSTITUTION (a header per institution
 * + a type cue, its per-currency accounts with the converted line, and a
 * per-institution subtotal that sums to the headline at the SAME selected rate,
 * ADR-134), the rate-source picker (MEP default, switch to Official recomputes
 * everything, a null source is disabled, a selected-null degrades), the
 * rate-unavailable degrade, the account drilldown link, the empty state, and the
 * loading skeleton. The card renders TanStack <Link>s, so it mounts behind a
 * memory router. English-pinned (ADR-105).
 *
 * The mocked MEP is 1.250 ARS/USD so the existing converted/subtotal fixtures
 * (USD 720 → ARS 900.000, USD 760 → ARS 950.000) stay clean; the Official rate is
 * a distinct 1.000 so a source switch is observable (USD 720 → ARS 720.000).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
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
import { maskAmount } from '../../lib/format'
import { fetchSuggestedRates } from '../../api/fxClient'
import type { NetWorth } from '../../api/accountsClient'

vi.mock('../../api/fxClient', () => ({
  fetchSuggestedRates: vi.fn(),
}))

const mockRates = vi.mocked(fetchSuggestedRates)

/** The mocked live MEP rate (ARS per USD) used by most tests. */
const MEP = 1250
/** A distinct mocked Official rate so a source switch is observable. */
const OFFICIAL = 1000

beforeEach(() => {
  mockRates.mockResolvedValue({ mep: MEP, official: OFFICIAL })
})

afterEach(() => {
  vi.clearAllMocks()
})

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

/**
 * Mixed-currency net worth, display = ARS. Native ARS 150.000 + native USD 720.
 * At MEP 1.250 the USD converts to ARS 900.000, so total = 1.050.000. The
 * backend's stale `balanceConverted`/`total` are IGNORED for display (ADR-133).
 */
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
 * subtotal sums their values converted at the live MEP (ADR-134). At MEP 1.250
 * USD 760 → ARS 950.000, so the subtotal = 950.000 + 150.000 = 1.100.000.
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
  test('computes the headline at the live MEP and shows the ARS decomposition', async () => {
    renderCard({ netWorth: CONVERTED, loading: false })

    // total = native ARS 150.000 + (USD 720 * 1.250 = ARS 900.000) = 1.050.000.
    expect(await screen.findByText('ARS 1.050.000')).toBeInTheDocument()

    // Decomposition: native ARS + ~ converted (USD native at the MEP unit, which
    // names the selected source — MEP by default).
    expect(
      screen.getByText(
        'ARS 150.000 + ~ ARS 900.000 (USD 720 at MEP ARS 1.250 / USD)',
      ),
    ).toBeInTheDocument()
  })

  test('masks the headline total + the ARS/USD breakdown amounts when hidden', async () => {
    renderCard({ netWorth: CONVERTED, loading: false, hidden: true })

    // Wait for the card to resolve (the FX-source picker appears once converted).
    await screen.findByLabelText('Rate')

    // The headline total is masked — the real ARS 1.050.000 is gone, replaced by
    // a standalone mask carrying the accessible "hidden" label.
    expect(screen.queryByText('ARS 1.050.000')).not.toBeInTheDocument()
    expect(screen.getByLabelText('hidden')).toHaveTextContent(maskAmount())

    // The decomposition's balance amounts are masked, but its structure + the
    // public FX rate (not a balance) remain.
    expect(
      screen.queryByText(
        'ARS 150.000 + ~ ARS 900.000 (USD 720 at MEP ARS 1.250 / USD)',
      ),
    ).not.toBeInTheDocument()
    // The masked decomposition line keeps the rate + shape (masks inline).
    expect(
      screen.getByText(
        `${maskAmount()} + ~ ${maskAmount()} (${maskAmount()} at MEP ARS 1.250 / USD)`,
      ),
    ).toBeInTheDocument()
  })

  test('shows the real net-worth figures when not hidden', async () => {
    renderCard({ netWorth: CONVERTED, loading: false, hidden: false })

    expect(await screen.findByText('ARS 1.050.000')).toBeInTheDocument()
    expect(screen.queryByLabelText('hidden')).not.toBeInTheDocument()
  })

  test('computes the headline symmetrically when display = USD', async () => {
    // Display USD: native USD 7.000 + native ARS 4.500.000. At MEP 1.500 the ARS
    // converts to USD 3.000, so total = USD 10.000.
    mockRates.mockResolvedValue({ mep: 1500, official: OFFICIAL })
    const usdDisplay: NetWorth = {
      total: '10000.00',
      currency: 'USD',
      accounts: [
        {
          id: 'u1',
          institutionId: 'inst-1',
          institutionName: 'Deel',
          type: 'wallet',
          currency: 'USD',
          balance: '7000.00',
          balanceConverted: '7000.00',
        },
        {
          id: 'u2',
          institutionId: 'inst-2',
          institutionName: 'Galicia',
          type: 'bank',
          currency: 'ARS',
          balance: '4500000.00',
          balanceConverted: '3000.00',
        },
      ],
    }
    renderCard({ netWorth: usdDisplay, loading: false })

    expect(await screen.findByText('USD 10.000')).toBeInTheDocument()
    expect(
      screen.getByText(
        'USD 7.000 + ~ USD 3.000 (ARS 4.500.000 at MEP ARS 1.500 / USD)',
      ),
    ).toBeInTheDocument()
  })

  test('renders the per-account breakdown with the converted line at the live MEP', async () => {
    renderCard({ netWorth: CONVERTED, loading: false })
    await screen.findByText('ARS 1.050.000')

    await expandDetails()

    expect(screen.getByText('Galicia')).toBeInTheDocument()
    expect(screen.getByText('Deel')).toBeInTheDocument()
    expect(screen.getByText('USD 720')).toBeInTheDocument()
    // The USD account shows its converted ARS value (720 * 1.250) as a secondary line.
    expect(screen.getByText('≈ ARS 900.000')).toBeInTheDocument()
  })

  test('omits the institution type chip and the per-account currency chip', async () => {
    renderCard({ netWorth: CONVERTED, loading: false })
    await screen.findByText('ARS 1.050.000')

    await expandDetails()

    // Institution headers still render their NAME, but no type cue (Bank / Wallet).
    expect(screen.getByText('Galicia')).toBeInTheDocument()
    expect(screen.getByText('Deel')).toBeInTheDocument()
    expect(screen.queryByText('Bank')).not.toBeInTheDocument()
    expect(screen.queryByText('Wallet')).not.toBeInTheDocument()

    // The amount carries the currency, so the redundant bare-currency chip is
    // gone: there is no standalone "ARS" / "USD" text (only "ARS 150.000" etc.).
    expect(screen.queryByText('ARS')).not.toBeInTheDocument()
    expect(screen.queryByText('USD')).not.toBeInTheDocument()
    // The formatted amounts (which DO carry the currency) still render — the ARS
    // amount appears both as the Galicia row and its subtotal.
    expect(screen.getAllByText('ARS 150.000').length).toBeGreaterThan(0)
    expect(screen.getByText('USD 720')).toBeInTheDocument()
  })

  test('groups multiple accounts under one institution header with a subtotal', async () => {
    renderCard({ netWorth: MULTI_ACCOUNT, loading: false })
    await screen.findByText('ARS 1.100.000')

    await expandDetails()

    // The institution header appears exactly once even with two accounts.
    expect(await screen.findAllByText('Galicia')).toHaveLength(1)

    expect(screen.getByText('USD 760')).toBeInTheDocument()
    expect(screen.getByText('ARS 150.000')).toBeInTheDocument()

    // The per-institution subtotal sums the values converted at the MEP
    // (950.000 + 150.000), matching the headline total.
    expect(
      screen.getByLabelText('Galicia subtotal ARS 1.100.000'),
    ).toBeInTheDocument()
  })

  test('renders a per-institution subtotal for each institution group', async () => {
    renderCard({ netWorth: CONVERTED, loading: false })
    await screen.findByText('ARS 1.050.000')

    await expandDetails()

    // Single-account institutions: ARS native subtotal and the USD account
    // converted at the live MEP (720 * 1.250). They sum to the headline.
    expect(
      await screen.findByLabelText('Galicia subtotal ARS 150.000'),
    ).toBeInTheDocument()
    expect(
      screen.getByLabelText('Deel subtotal ARS 900.000'),
    ).toBeInTheDocument()
  })

  test('each breakdown row links to its account drilldown', async () => {
    renderCard({ netWorth: CONVERTED, loading: false })
    await screen.findByText('ARS 1.050.000')
    await expandDetails()
    const link = await screen.findByRole('link', {
      name: 'View Deel USD transactions',
    })
    expect(link).toHaveAttribute('href', '/transactions?account=a2&month=all')
  })

  test('degrades to native when the selected source rate is unavailable (null)', async () => {
    mockRates.mockResolvedValue({ mep: null, official: null })
    renderCard({ netWorth: CONVERTED, loading: false })

    // Headline = the display-native portion only (no fabricated rate). The
    // other-currency native is shown without conversion, plus a calm note.
    expect(await screen.findByText('ARS 150.000')).toBeInTheDocument()
    expect(screen.getByText('ARS 150.000 + USD 720')).toBeInTheDocument()
    expect(
      screen.getByText(/Live rate unavailable/i),
    ).toBeInTheDocument()
    // No converted (~) part and no "at … / USD" rate spelled out.
    expect(screen.queryByText(/~/)).not.toBeInTheDocument()
    expect(screen.queryByText(/USD$/)).not.toBeInTheDocument()

    // The breakdown shows native balances only — no converted (≈) line.
    await expandDetails()
    expect(screen.getByText('USD 720')).toBeInTheDocument()
    expect(screen.queryByText(/≈/)).not.toBeInTheDocument()
  })

  test('defaults the source to MEP and exposes the labeled picker', async () => {
    renderCard({ netWorth: CONVERTED, loading: false })
    await screen.findByText('ARS 1.050.000')

    // A labeled, keyboard-operable source picker (ADR-019), defaulting to MEP.
    const picker = screen.getByRole('combobox', { name: 'Rate' })
    expect(picker).toHaveTextContent('MEP')
  })

  test('switching the source to Official recomputes the total, decomposition and subtotal', async () => {
    renderCard({ netWorth: MULTI_ACCOUNT, loading: false })
    // Default MEP: USD 760 * 1.250 = ARS 950.000, subtotal 1.100.000.
    await screen.findByText('ARS 1.100.000')

    // Switch the source to Official (1.000): USD 760 → ARS 760.000, so the
    // subtotal/total become 760.000 + 150.000 = 910.000.
    await userEvent.click(screen.getByRole('combobox', { name: 'Rate' }))
    await userEvent.click(
      await screen.findByRole('option', { name: 'Official' }),
    )

    expect(await screen.findByText('ARS 910.000')).toBeInTheDocument()
    // The decomposition unit now names Official + its value.
    expect(
      screen.getByText(
        'ARS 150.000 + ~ ARS 760.000 (USD 760 at Official ARS 1.000 / USD)',
      ),
    ).toBeInTheDocument()

    // The per-institution subtotal recomputes at the official rate too.
    await expandDetails()
    expect(
      await screen.findByLabelText('Galicia subtotal ARS 910.000'),
    ).toBeInTheDocument()
  })

  test('disables a source option whose live rate is null', async () => {
    mockRates.mockResolvedValue({ mep: MEP, official: null })
    renderCard({ netWorth: CONVERTED, loading: false })
    await screen.findByText('ARS 1.050.000')

    await userEvent.click(screen.getByRole('combobox', { name: 'Rate' }))
    // Official failed to fetch → its option is present but disabled.
    expect(
      await screen.findByRole('option', { name: 'Official' }),
    ).toHaveAttribute('aria-disabled', 'true')
  })

  test('lets the user switch to Official when MEP is null to recover conversion', async () => {
    // MEP failed but Official is available — the selected (MEP) source degrades
    // to native, yet the user can switch to Official to see converted values.
    mockRates.mockResolvedValue({ mep: null, official: OFFICIAL })
    renderCard({ netWorth: CONVERTED, loading: false })

    // Degraded under the default MEP selection.
    expect(await screen.findByText('ARS 150.000')).toBeInTheDocument()
    expect(screen.getByText(/Live rate unavailable/i)).toBeInTheDocument()

    // Switch to Official (1.000): USD 720 → ARS 720.000, total 870.000.
    await userEvent.click(screen.getByRole('combobox', { name: 'Rate' }))
    await userEvent.click(
      await screen.findByRole('option', { name: 'Official' }),
    )

    expect(await screen.findByText('ARS 870.000')).toBeInTheDocument()
    expect(screen.queryByText(/Live rate unavailable/i)).not.toBeInTheDocument()
    expect(
      screen.getByText(
        'ARS 150.000 + ~ ARS 720.000 (USD 720 at Official ARS 1.000 / USD)',
      ),
    ).toBeInTheDocument()
  })

  test('shows the headline alone when there is no other-currency account', async () => {
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

    // Headline only: no decomposition line, no MEP note, no converted (~) part.
    expect(await screen.findByText('ARS 150.000')).toBeInTheDocument()
    expect(screen.queryByText(/~/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Live MEP rate unavailable/i)).not.toBeInTheDocument()

    await expandDetails()
    // Total, the single ARS row, and the institution subtotal all read 150.000.
    expect(screen.getAllByText('ARS 150.000')).toHaveLength(3)
    expect(screen.queryByText(/≈/)).not.toBeInTheDocument()
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

  test('shows the empty state when there are no accounts', async () => {
    const empty: NetWorth = { total: '0.00', currency: 'ARS', accounts: [] }
    renderCard({ netWorth: empty, loading: false })
    expect(
      await screen.findByText('Add an account to see your net worth here.'),
    ).toBeInTheDocument()
  })

  test('shows a loading skeleton while the net-worth query is pending', async () => {
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
