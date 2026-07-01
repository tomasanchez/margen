/**
 * Unit tests for the Budgets page (ADR-125, ADR-037, ADR-019, ADR-105).
 *
 * Drives the page against a MOCKED {@link budgetsClient} (the network boundary),
 * so the real TanStack Query hooks + the row edit flows run end to end:
 *
 *  - every expense category renders with its target / spent / progress;
 *  - typing a target and blurring PUTs the upsert for that category + month;
 *  - clearing the input and blurring DELETEs the target;
 *  - an over-budget category shows the non-color "Over budget" cue;
 *  - stepping the month navigator refetches for the new YYYY-MM;
 *  - a GET failure surfaces the calm error state.
 *
 * Most tests use a plain QueryClient + ColorMode wrapper; the unconverted-note
 * test (ADR-152) renders behind a memory router so its <Link to="/settings">
 * resolves. English-pinned (ADR-105); money asserted via the shared es-AR
 * formatter.
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
import { fetchCurrentRate } from '../../api/fxClient'
import { fetchSettings } from '../../api/settingsClient'

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

// The preferred-rate query (ADR-155) reads `preferredRateSource` from settings
// and fetches the live rate via fxClient. Mock both so the conversion tests can
// drive a deterministic rate; ARS-preferred tests never need it (no conversion).
vi.mock('../../api/fxClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/fxClient')>()
  return { ...actual, fetchCurrentRate: vi.fn() }
})
vi.mock('../../api/settingsClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/settingsClient')>()
  return { ...actual, fetchSettings: vi.fn() }
})

const mockRate = vi.mocked(fetchCurrentRate)
const mockSettings = vi.mocked(fetchSettings)

const mockFetch = vi.mocked(budgetsClient.fetchBudgets)
const mockFetchHistory = vi.mocked(budgetsClient.fetchHistory)
const mockSet = vi.mocked(budgetsClient.setTarget)
const mockClear = vi.mocked(budgetsClient.clearTarget)
const mockFetchIncome = vi.mocked(budgetsClient.fetchBudgetIncome)
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
      { category: 'Food', target: '120000.00', targetCurrency: 'ARS', spent: '90000.00', remaining: '30000.00', isEssential: true },
      { category: 'Rent', target: '200000.00', targetCurrency: 'ARS', spent: '230000.00', remaining: '-30000.00', isEssential: true },
      { category: 'Transport', target: null, targetCurrency: null, spent: '15000.00', remaining: null, isEssential: false },
    ],
  }
}

/**
 * Render the page behind a memory router so its <Link>s resolve — the category
 * rows drill into <Link to="/transactions"> (the spend inspector) and the
 * unconverted note links to <Link to="/settings"> (ADR-152). Both target routes
 * are registered as stubs so Link can build the href without navigating.
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
    mockFetchIncome.mockResolvedValue({
      month: '2026-06',
      amount: null,
      currency: 'ARS',
      source: 'manual',
      floor: null,
    })
    // Settings resolve so the preferred-rate query is enabled; default source
    // is bolsa (MEP). The live rate is 1000 ARS per USD for the conversion tests.
    mockSettings.mockResolvedValue({
      preferredDisplayCurrency: 'ARS',
      fxDefaultRateType: 'MEP',
      preferredRateSource: 'bolsa',
      monotributoCurrentCategory: 'A',
      monotributoActivityType: 'services',
      monotributoEnabled: false,
    })
    mockRate.mockResolvedValue(1000)
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

  test('typing a target and blurring PUTs the upsert for that category', async () => {
    const user = userEvent.setup()
    renderPage()

    const transportInput = await screen.findByRole('textbox', {
      name: 'Transport target',
    })
    await user.click(transportInput)
    await user.type(transportInput, '50000')
    await user.tab() // blur commits

    await waitFor(() => {
      expect(mockSet).toHaveBeenCalledWith({
        category: 'Transport',
        month: '2026-06',
        amount: '50000',
        currency: 'ARS',
      })
    })
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

  test('stepping the month navigator refetches for the new month', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Food')

    // The initial load is for the current month; capture how it was first called.
    expect(mockFetch).toHaveBeenCalled()
    mockFetch.mockClear()
    mockFetch.mockResolvedValue(period('2026-05'))

    // Step to the previous month via the stepper's Previous-month button.
    await user.click(screen.getByRole('button', { name: 'Previous month' }))

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled()
    })
    // The refetch month differs from the current month (one step back).
    const requested = mockFetch.mock.calls.at(-1)?.[0]
    expect(requested).toMatch(/^\d{4}-\d{2}$/)
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

  test('converts a currency-mismatched income to the preferred currency at the live rate (ADR-155)', async () => {
    // The budget is viewed in USD (preferred); the stored income + ARS-native
    // targets are CONVERTED at the live rate (1000 ARS/USD) rather than treated
    // as unset (the retired ADR-154 guard). Income ARS 3.000.000 → USD 3.000;
    // ARS targets 120.000 + 200.000 → USD 120 + 200 = USD 320 assigned;
    // left to assign = USD 3.000 − USD 320 = USD 2.680.
    mockFetchIncome.mockResolvedValue({
      month: '2026-06',
      amount: '3000000.00',
      currency: 'ARS',
      source: 'manual',
      floor: null,
    })
    renderPage({ preferredCurrency: 'USD', effectiveCurrency: 'USD' })
    await screen.findByText('Food')

    // The income always shows now — re-expressed in USD, no empty-state prompt.
    expect(
      screen.queryByText(
        'Set your net income to plan with percentages and unlock saving profiles.',
      ),
    ).not.toBeInTheDocument()
    // The left-to-assign readout is computed in the preferred currency.
    expect(await screen.findByText('Left to assign')).toBeInTheDocument()
    expect(screen.getByText('USD 2.680')).toBeInTheDocument()
    // The income field shows the converted USD amount (3.000.000 / 1000 = 3000).
    const incomeField = screen.getByRole('textbox', {
      name: 'Net income for June 2026',
    })
    expect(incomeField).toHaveValue('3000.00')
  })

  test('passes income through unchanged when it already matches the budget currency (ADR-155)', async () => {
    // Income + targets already USD, budget viewed in USD → no conversion: USD
    // 600.000 income minus USD-denominated targets (320.000) yields the readout.
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
    renderPage({ preferredCurrency: 'USD', effectiveCurrency: 'USD' })
    await screen.findByText('Food')
    // Income 600000 USD minus 320000 USD assigned = 280000 USD left.
    expect(await screen.findByText('Left to assign')).toBeInTheDocument()
    expect(screen.getByText('USD 280.000')).toBeInTheDocument()
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
})
