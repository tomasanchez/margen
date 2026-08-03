/**
 * Unit tests for the Budgets page (ADR-125, ADR-156, ADR-037, ADR-019, ADR-105).
 *
 * Drives the page against a MOCKED {@link budgetsClient} (the network boundary),
 * so the real TanStack Query hooks + the row edit flows run end to end:
 *
 *  - every expense category renders with its target / spent / progress;
 *  - typing a target and blurring PUTs the upsert with `currency = budgetCurrency`
 *    (the INCOME's currency, ADR-156), then the row + plan band reflect the save;
 *  - clearing the input and blurring DELETEs the target;
 *  - an over-budget category shows the non-color "Over budget" cue;
 *  - stepping the month navigator refetches AND shows the new month's saved
 *    targets without carrying a stale draft (the reported month-switch bug);
 *  - the income currency selector sets the budget currency (no cross-conversion);
 *  - a committed target flashes "Saving…" → "Saved ✓";
 *  - a GET failure surfaces the calm error state.
 *
 * The page is rendered behind a memory router so its <Link>s resolve (rows drill
 * into <Link to="/transactions">; the unconverted note links to <Link
 * to="/settings">). The budget currency follows the INCOME's currency (ADR-156),
 * never the preferred display currency — so the USD-budget tests set the income's
 * currency to USD rather than a display-currency preference. English-pinned
 * (ADR-105); money asserted via the shared es-AR formatter.
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
import {
  DisplayCurrencyContext,
  DEFAULT_DISPLAY_CURRENCY_VALUE,
  type DisplayCurrencyValue,
} from '../settings/displayCurrencyContext'
import { BudgetsPage } from './BudgetsPage'
import { budgetsClient, type BudgetPeriod } from '../../api/budgetsClient'
import { committedClient } from '../../api/committedClient'

vi.mock('../../api/budgetsClient', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/budgetsClient')>()
  return {
    ...actual,
    budgetsClient: {
      fetchBudgets: vi.fn(),
      fetchHistory: vi.fn(),
      setTarget: vi.fn(),
      clearTarget: vi.fn(),
      fetchBudgetIncome: vi.fn(),
      setBudgetIncome: vi.fn(),
      fetchSuggestedBase: vi.fn(),
      applyProfile: vi.fn(),
      reprice: vi.fn(),
    },
  }
})

// Mock the committed-spend accent client (ADR-179) so the page's `useCommitted`
// hook never hits the network in jsdom; the accent itself is covered in
// MetricCards.test / committedClient.test.
vi.mock('../../api/committedClient', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/committedClient')>()
  return {
    ...actual,
    committedClient: { fetchCommitted: vi.fn() },
  }
})

const mockFetch = vi.mocked(budgetsClient.fetchBudgets)
const mockFetchHistory = vi.mocked(budgetsClient.fetchHistory)
const mockSet = vi.mocked(budgetsClient.setTarget)
const mockClear = vi.mocked(budgetsClient.clearTarget)
const mockFetchIncome = vi.mocked(budgetsClient.fetchBudgetIncome)
const mockSetIncome = vi.mocked(budgetsClient.setBudgetIncome)
const mockApplyProfile = vi.mocked(budgetsClient.applyProfile)

/** A period: Food under budget, Rent over budget, Transport with no target set. */
function period(month: string): BudgetPeriod {
  return {
    month,
    currency: 'ARS',
    savings: [],
    floor: null,
    suggestedStrategy: null,
    pressure: null,
    unconverted: 0,
    categories: [
      { category: 'Food', target: '120000.00', targetCurrency: 'ARS', spent: '90000.00', reimbursed: '0', remaining: '30000.00', isEssential: true },
      { category: 'Rent', target: '200000.00', targetCurrency: 'ARS', spent: '230000.00', reimbursed: '0', remaining: '-30000.00', isEssential: true },
      { category: 'Transport', target: null, targetCurrency: null, spent: '15000.00', reimbursed: '0', remaining: null, isEssential: false },
    ],
  }
}

/** A fully EMPTY period: same categories, but NONE has a target set (ADR-201). */
function emptyPeriod(month: string): BudgetPeriod {
  const p = period(month)
  return {
    ...p,
    categories: p.categories.map((c) => ({
      ...c,
      target: null,
      targetCurrency: null,
      remaining: null,
    })),
  }
}

/**
 * Route `fetchBudgets` per requested month so the CURRENT and PRIOR months can
 * differ (the auto-fill tests need an empty current + a targeted prior, ADR-201).
 * `byMonth` maps `YYYY-MM` → period; any month not listed falls back to `orElse`.
 */
function mockBudgetsByMonth(
  byMonth: Record<string, BudgetPeriod>,
  orElse: (month: string) => BudgetPeriod,
) {
  mockFetch.mockImplementation((month: string) =>
    Promise.resolve(byMonth[month] ?? orElse(month)),
  )
}

/**
 * Render the page behind a memory router so its <Link>s resolve — the category
 * rows drill into <Link to="/transactions"> (the spend inspector) and the
 * unconverted note links to <Link to="/settings"> (ADR-152). Both target routes
 * are registered as stubs so Link can build the href without navigating. The
 * page uses its local-state month fallback here (the URL month sync is tested via
 * `budgetsSearch`).
 */
function renderPage(displayCurrency?: Partial<DisplayCurrencyValue>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const value: DisplayCurrencyValue = {
    ...DEFAULT_DISPLAY_CURRENCY_VALUE,
    ...displayCurrency,
  }
  const rootRoute = createRootRoute({
    component: () => (
      <DisplayCurrencyContext.Provider value={value}>
        <ColorModeProvider>
          <BudgetsPage />
        </ColorModeProvider>
      </DisplayCurrencyContext.Provider>
    ),
  })
  const transactionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/transactions',
    component: () => null,
  })
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([transactionsRoute, settingsRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

/** Back-compat alias — renderPage now always wraps in a router. */
function renderPageWithRouter() {
  return renderPage()
}

describe('BudgetsPage', () => {
  beforeEach(() => {
    // Pin "today" to June 2026 so the page's current-month resolution matches the
    // '2026-06' fixtures + assertions regardless of the real run date.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date(2026, 5, 15, 12))
    mockFetch.mockResolvedValue(period('2026-06'))
    mockFetchHistory.mockResolvedValue([])
    mockSet.mockResolvedValue(undefined)
    mockClear.mockResolvedValue(undefined)
    mockSetIncome.mockResolvedValue(undefined)
    mockFetchIncome.mockResolvedValue({
      month: '2026-06',
      amount: null,
      currency: 'ARS',
      source: 'manual',
      floor: null,
    })
    // No committed accent by default (empty split): keeps the existing plan-band
    // assertions unaffected. Specific accent behavior is covered elsewhere.
    vi.mocked(committedClient.fetchCommitted).mockResolvedValue({
      month: '2026-06',
      currency: 'ARS',
      paid: { subscription: 0, installment: 0, tax: 0, total: 0 },
      pending: { subscription: 0, installment: 0, tax: 0, total: 0 },
      unconverted: 0,
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  test('renders each category with its target, spent and progress', async () => {
    renderPage()

    // The page heading names the route landmark (shown during loading too).
    expect(
      await screen.findByRole('heading', { name: 'Budgets', level: 1 }),
    ).toBeInTheDocument()

    // Every category is present (incl. the untargeted Transport) once loaded.
    expect(await screen.findByText('Food')).toBeInTheDocument()
    expect(screen.getByText('Rent')).toBeInTheDocument()
    expect(screen.getByText('Transport')).toBeInTheDocument()

    // A targeted row reads "spent / target" (the comp's column 3); Food spent
    // 90.000 of a 120.000 target. Transport (no target) keeps the "Spent X" line.
    expect(screen.getByText('ARS 90.000 / ARS 120.000')).toBeInTheDocument()
    expect(screen.getByText('Spent ARS 15.000')).toBeInTheDocument()

    // Food's target seeds its input (the saved value).
    const foodInput = screen.getByRole('textbox', { name: 'Food target' })
    expect(foodInput).toHaveValue('120000.00')

    // Food's meter announces its progress (90000 / 120000 = 75%).
    expect(
      screen.getByRole('meter', { name: 'Food: 75% of target spent' }),
    ).toBeInTheDocument()
  })

  test('shows the non-color over-budget cue for an over category', async () => {
    renderPage()
    await screen.findByText('Rent')
    // Rent is over budget: a text "Over budget" cue accompanies the meter (not
    // color alone, ADR-019).
    expect(screen.getAllByText('Over budget').length).toBeGreaterThan(0)
    expect(screen.getByText('ARS 30.000 over')).toBeInTheDocument()
  })

  test('surfaces the unconverted note with a link to the backfill when rows lack a snapshot (ADR-152)', async () => {
    mockFetch.mockResolvedValue({ ...period('2026-06'), unconverted: 4 })
    renderPageWithRouter()

    expect(
      await screen.findByText(
        "4 transactions aren't converted to USD yet, so spend may be understated.",
      ),
    ).toBeInTheDocument()
    // The calm note links to Settings (the one-time backfill, #80).
    const link = screen.getByRole('link', { name: 'Convert them' })
    expect(link).toHaveAttribute('href', '/settings')
  })

  test('hides the unconverted note when every row is converted', async () => {
    mockFetch.mockResolvedValue({ ...period('2026-06'), unconverted: 0 })
    renderPage()
    await screen.findByText('Food')
    expect(screen.queryByText(/aren't converted to USD/)).not.toBeInTheDocument()
  })

  test('typing a target and blurring PUTs the upsert in the budget currency', async () => {
    const user = userEvent.setup()
    renderPage()

    const transportInput = await screen.findByRole('textbox', {
      name: 'Transport target',
    })
    await user.click(transportInput)
    await user.type(transportInput, '50000')
    await user.tab() // blur commits

    await waitFor(() => {
      // currency = budgetCurrency (ARS, the income's currency, ADR-156).
      expect(mockSet).toHaveBeenCalledWith({
        category: 'Transport',
        month: '2026-06',
        amount: '50000',
        currency: 'ARS',
      })
    })
  })

  test('a committed target flashes Saving… then Saved ✓', async () => {
    const user = userEvent.setup()
    // Hold the PUT open so the "Saving…" state is observable, then resolve.
    let resolveSet: () => void = () => {}
    mockSet.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSet = resolve
        }),
    )
    renderPage()

    const transportInput = await screen.findByRole('textbox', {
      name: 'Transport target',
    })
    await user.click(transportInput)
    await user.type(transportInput, '50000')
    await user.tab()

    // While the write is in flight the row shows "Saving…".
    expect(await screen.findByText('Saving…')).toBeInTheDocument()

    resolveSet()

    // On success the transient "Saved ✓" confirmation appears.
    expect(await screen.findByText('Saved ✓')).toBeInTheDocument()
  })

  test('clearing an existing target and blurring DELETEs it', async () => {
    const user = userEvent.setup()
    renderPage()

    const foodInput = await screen.findByRole('textbox', { name: 'Food target' })
    await user.clear(foodInput)
    await user.tab()

    await waitFor(() => {
      expect(mockClear).toHaveBeenCalledWith('Food', '2026-06')
    })
    expect(mockSet).not.toHaveBeenCalled()
  })

  test('a no-op blur (no change) does not fire a write', async () => {
    const user = userEvent.setup()
    renderPage()

    const foodInput = await screen.findByRole('textbox', { name: 'Food target' })
    await user.click(foodInput)
    await user.tab()

    expect(mockSet).not.toHaveBeenCalled()
    expect(mockClear).not.toHaveBeenCalled()
  })

  test('stepping the month navigator shows the new month targets without a stale draft', async () => {
    const user = userEvent.setup()
    // The prior month (May) has a DIFFERENT Food target so we can prove the row
    // shows May's saved value — not June's leftover draft (the reported bug).
    const may = period('2026-05')
    may.categories[0].target = '77000.00'
    may.categories[0].remaining = '-13000.00'
    renderPage()
    await screen.findByText('Food')

    // June's Food target seeds the input.
    expect(screen.getByRole('textbox', { name: 'Food target' })).toHaveValue(
      '120000.00',
    )

    mockFetch.mockResolvedValue(may)
    // Step to the previous month via the stepper's Previous-month button.
    await user.click(screen.getByRole('button', { name: 'Previous month' }))

    // The period for May is fetched (the prior-month query also fetches April for
    // the reprice check, so match on presence, not the last call).
    await waitFor(() => {
      const months = mockFetch.mock.calls.map((c) => c[0])
      expect(months).toContain('2026-05')
    })

    // The Food row now reflects MAY's saved target (77000), not June's draft.
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Food target' })).toHaveValue(
        '77000.00',
      )
    })
    // No stale-draft write was committed by the month switch.
    expect(mockSet).not.toHaveBeenCalled()
    expect(mockClear).not.toHaveBeenCalled()
  })

  test('a GET failure surfaces the calm error state with retry', async () => {
    mockFetch.mockRejectedValue(new Error('down'))
    renderPage()
    expect(
      await screen.findByRole('heading', { name: "Can't load your budgets" }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument()
  })

  test('the plan band totals budgeted vs spent over budgeted categories', async () => {
    renderPage()
    await screen.findByText('Food')
    // Budgeted = 120000 + 200000 = 320000; spent (budgeted only) = 90000 +
    // 230000 = 320000; Transport's 15000 is excluded. Both read ARS 320.000.
    expect(screen.getByText('Budgeted')).toBeInTheDocument()
    expect(screen.getByText('Spent so far')).toBeInTheDocument()
    expect(screen.getAllByText('ARS 320.000').length).toBeGreaterThanOrEqual(2)
  })

  test('groups categories into Needs and Wants by isEssential', async () => {
    renderPage()
    await screen.findByText('Food')
    // The group cards name themselves; Needs holds Food + Rent (essential),
    // Wants holds Transport (non-essential).
    expect(
      screen.getByRole('heading', { name: 'Needs', level: 2 }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Wants', level: 2 }),
    ).toBeInTheDocument()
  })

  test('shows the left-to-assign readout once an income base is set', async () => {
    // Income 600000; allocated targets = 320000 → 280000 left to assign.
    mockFetchIncome.mockResolvedValue({
      month: '2026-06',
      amount: '600000.00',
      currency: 'ARS',
      source: 'manual',
      floor: null,
    })
    renderPage()
    await screen.findByText('Food')
    expect(await screen.findByText('Left to assign')).toBeInTheDocument()
    expect(screen.getByText('ARS 280.000')).toBeInTheDocument()
  })

  test('the budget currency follows the income currency, uncoverted (ADR-156)', async () => {
    // A USD income → USD budget: income + targets arrive in USD from the backend
    // (keyed by budgetCurrency), consumed as-is with NO conversion. USD 600.000
    // income minus USD-denominated targets (320.000) yields the readout.
    mockFetch.mockResolvedValue({
      ...period('2026-06'),
      currency: 'USD',
      categories: period('2026-06').categories.map((c) => ({
        ...c,
        targetCurrency: c.target != null ? 'USD' : null,
      })),
    })
    mockFetchIncome.mockResolvedValue({
      month: '2026-06',
      amount: '600000.00',
      currency: 'USD',
      source: 'manual',
      floor: null,
    })
    // Preferred display currency is ARS, but the budget follows the USD income.
    renderPage({ preferredCurrency: 'ARS', effectiveCurrency: 'ARS' })
    await screen.findByText('Food')
    // The budget is fetched in the income's currency (USD), not the preferred.
    expect(mockFetch).toHaveBeenCalledWith('2026-06', 'USD')
    // Income 600000 USD minus 320000 USD assigned = 280000 USD left.
    expect(await screen.findByText('Left to assign')).toBeInTheDocument()
    expect(screen.getByText('USD 280.000')).toBeInTheDocument()
    // The income field shows the USD amount unchanged (never cross-converted).
    const incomeField = screen.getByRole('textbox', {
      name: 'Net income for June 2026',
    })
    expect(incomeField).toHaveValue('600000.00')
  })

  test('the income currency selector sets the budget currency (ADR-156)', async () => {
    const user = userEvent.setup()
    mockFetchIncome.mockResolvedValue({
      month: '2026-06',
      amount: '600000.00',
      currency: 'ARS',
      source: 'manual',
      floor: null,
    })
    renderPage()
    await screen.findByText('Food')

    // Switch the income currency to USD — the page re-commits the income under
    // USD, which becomes the whole budget's currency (sent on PUT /budget-income).
    await user.click(screen.getByRole('button', { name: 'US dollars (USD)' }))

    await waitFor(() => {
      expect(mockSetIncome).toHaveBeenCalledWith({
        month: '2026-06',
        amount: '600000.00',
        currency: 'USD',
      })
    })
  })

  test('applying "Clear all" batches a DELETE per targeted category', async () => {
    const user = userEvent.setup()
    mockFetchIncome.mockResolvedValue({
      month: '2026-06',
      amount: '600000.00',
      currency: 'ARS',
      source: 'manual',
      floor: null,
    })
    renderPage()
    await screen.findByText('Food')

    await user.click(screen.getByRole('button', { name: 'Clear all' }))

    await waitFor(() => {
      // Food + Rent have targets; Transport does not → two deletes, no PUTs.
      expect(mockClear).toHaveBeenCalledWith('Food', '2026-06')
      expect(mockClear).toHaveBeenCalledWith('Rent', '2026-06')
    })
    expect(mockClear).toHaveBeenCalledTimes(2)
  })

  test('applying "50 / 30 / 20" writes targets and the Conservative profile', async () => {
    const user = userEvent.setup()
    mockApplyProfile.mockResolvedValue({
      period: period('2026-06'),
      floorBreached: false,
      gap: null,
    })
    mockFetchIncome.mockResolvedValue({
      month: '2026-06',
      amount: '1000000.00',
      currency: 'ARS',
      source: 'manual',
      floor: null,
    })
    renderPage()
    await screen.findByText('Food')

    await user.click(screen.getByRole('button', { name: '50 / 30 / 20' }))

    await waitFor(() => {
      // The 20% Savings leg is the Conservative preset (ADR-147/138).
      expect(mockApplyProfile).toHaveBeenCalledWith('2026-06', 'conservative')
    })
    // Needs categories (Food, Rent) get a share of the 50% pool.
    expect(mockSet).toHaveBeenCalled()
  })

  test('applying "Copy last month" carries the prior month\'s exact targets verbatim (ADR-201)', async () => {
    const user = userEvent.setup()
    // Current June already has targets (so auto-fill never fires); the prior May
    // budgeted Food + Rent with DISTINCT verbatim caps we expect carried as-is.
    const may = period('2026-05')
    may.categories[0].target = '111111.11'
    may.categories[1].target = '222222.22'
    mockBudgetsByMonth({ '2026-05': may }, () => period('2026-06'))
    // An income is required for the quick-start chips to be enabled.
    mockFetchIncome.mockResolvedValue({
      month: '2026-06',
      amount: '600000.00',
      currency: 'ARS',
      source: 'manual',
      floor: null,
    })
    renderPage()
    await screen.findByText('Food')

    await user.click(screen.getByRole('button', { name: 'Copy last month' }))

    await waitFor(() => {
      // Prior caps carried VERBATIM (same Decimal string, no inflation/averaging).
      expect(mockSet).toHaveBeenCalledWith({
        category: 'Food',
        month: '2026-06',
        amount: '111111.11',
        currency: 'ARS',
      })
      expect(mockSet).toHaveBeenCalledWith({
        category: 'Rent',
        month: '2026-06',
        amount: '222222.22',
        currency: 'ARS',
      })
    })
  })

  test('"Copy last month" is disabled when the prior month budgeted nothing', async () => {
    // Prior May is fully empty → nothing to copy → the chip is disabled.
    mockBudgetsByMonth({ '2026-05': emptyPeriod('2026-05') }, () =>
      period('2026-06'),
    )
    mockFetchIncome.mockResolvedValue({
      month: '2026-06',
      amount: '600000.00',
      currency: 'ARS',
      source: 'manual',
      floor: null,
    })
    renderPage()
    await screen.findByText('Food')
    expect(screen.getByRole('button', { name: 'Copy last month' })).toBeDisabled()
  })

  test('auto-fill seeds an empty CURRENT month from the prior targets exactly once, and shows the note (ADR-201)', async () => {
    // Current June is EMPTY; prior May has targets → auto-fill seeds May's caps.
    mockBudgetsByMonth(
      { '2026-06': emptyPeriod('2026-06'), '2026-05': period('2026-05') },
      (m) => period(m),
    )
    renderPage()

    await waitFor(() => {
      // Prior May's Food + Rent caps are seeded verbatim into June.
      expect(mockSet).toHaveBeenCalledWith({
        category: 'Food',
        month: '2026-06',
        amount: '120000.00',
        currency: 'ARS',
      })
      expect(mockSet).toHaveBeenCalledWith({
        category: 'Rent',
        month: '2026-06',
        amount: '200000.00',
        currency: 'ARS',
      })
    })
    // Exactly once per category — the seed never re-fires on the invalidation
    // refetch (Food seeded once, Rent seeded once → two writes total).
    expect(mockSet).toHaveBeenCalledTimes(2)
    // The calm inline note names the month it seeded from.
    expect(
      await screen.findByText("Seeded from May 2026's budget — edit or clear."),
    ).toBeInTheDocument()
  })

  test('auto-fill does NOT fire when the current month already has targets', async () => {
    // Both current + prior have targets → nothing to seed.
    mockBudgetsByMonth({}, (m) => period(m))
    mockFetchIncome.mockResolvedValue({
      month: '2026-06',
      amount: '600000.00',
      currency: 'ARS',
      source: 'manual',
      floor: null,
    })
    renderPage()
    await screen.findByText('Food')
    // Give any stray effect a chance to run, then assert no write happened.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Clear all' })).toBeEnabled()
    })
    expect(mockSet).not.toHaveBeenCalled()
    expect(
      screen.queryByText(/Seeded from .* budget/),
    ).not.toBeInTheDocument()
  })

  test('auto-fill does NOT fire when the prior month has no targets', async () => {
    // Current June empty, but prior May is also empty → nothing to copy.
    mockBudgetsByMonth(
      { '2026-06': emptyPeriod('2026-06'), '2026-05': emptyPeriod('2026-05') },
      (m) => emptyPeriod(m),
    )
    // Income set so the chip's disabled state reflects "no prior to copy" alone,
    // not the missing-income blanket disable.
    mockFetchIncome.mockResolvedValue({
      month: '2026-06',
      amount: '600000.00',
      currency: 'ARS',
      source: 'manual',
      floor: null,
    })
    renderPage()
    await screen.findByText('Food')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copy last month' })).toBeDisabled()
    })
    expect(mockSet).not.toHaveBeenCalled()
    expect(screen.queryByText(/Seeded from .* budget/)).not.toBeInTheDocument()
  })

  test('auto-fill does NOT fire on a PAST empty month the user is just browsing (ADR-201)', async () => {
    const user = userEvent.setup()
    // Start on June (empty→would seed) is NOT what we want here; instead keep June
    // populated so nothing seeds, then step BACK to an empty May with a targeted
    // April prior. A past empty month must never be silently populated.
    mockBudgetsByMonth(
      {
        '2026-06': period('2026-06'),
        '2026-05': emptyPeriod('2026-05'),
        '2026-04': period('2026-04'),
      },
      (m) => period(m),
    )
    renderPage()
    await screen.findByText('Food')

    await user.click(screen.getByRole('button', { name: 'Previous month' }))

    // May (past, empty) loads; the Copy-last chip is enabled (April has targets)
    // but the page must NOT auto-seed a past month.
    await waitFor(() => {
      const months = mockFetch.mock.calls.map((c) => c[0])
      expect(months).toContain('2026-05')
    })
    // No auto-seed write for the past month, and no seeded note.
    expect(mockSet).not.toHaveBeenCalled()
    expect(screen.queryByText(/Seeded from .* budget/)).not.toBeInTheDocument()
  })

  test('auto-fill waits for income to settle and seeds in the income currency, not the preferred fallback (ADR-156/201)', async () => {
    // Money-safety: the write currency is the INCOME's currency, which falls back
    // to the preferred (ARS) until income loads. Budgets + prior settle FIRST here
    // (income is held open), so a premature seed would persist the wrong (ARS)
    // denomination. The effect must defer until income is success, then write USD.
    let resolveIncome: (income: {
      month: string
      amount: string | null
      currency: 'ARS' | 'USD'
      source: 'manual'
      floor: null
    }) => void = () => {}
    mockFetchIncome.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveIncome = resolve
        }),
    )
    // Current June empty; prior May has targets → a seed is due once income lands.
    mockBudgetsByMonth(
      { '2026-06': emptyPeriod('2026-06'), '2026-05': period('2026-05') },
      (m) => period(m),
    )
    // Preferred display currency is ARS; the stored income is USD — they DIFFER,
    // so a fallback seed would be ARS while the correct seed is USD.
    renderPage({ preferredCurrency: 'ARS', effectiveCurrency: 'ARS' })

    // Budgets + prior have resolved, but income is still pending → the effect must
    // NOT have claimed the month or written anything yet.
    await screen.findByText('Food')
    await waitFor(() => {
      const months = mockFetch.mock.calls.map((c) => c[0])
      expect(months).toContain('2026-05')
    })
    expect(mockSet).not.toHaveBeenCalled()

    // Income lands as USD → NOW the seed fires, in USD (never the ARS fallback).
    resolveIncome({
      month: '2026-06',
      amount: '600000.00',
      currency: 'USD',
      source: 'manual',
      floor: null,
    })

    await waitFor(() => {
      expect(mockSet).toHaveBeenCalledWith({
        category: 'Food',
        month: '2026-06',
        amount: '120000.00',
        currency: 'USD',
      })
    })
    // Every seed write carries the income currency — none used the ARS fallback.
    for (const [body] of mockSet.mock.calls) {
      expect(body.currency).toBe('USD')
    }
  })
})
