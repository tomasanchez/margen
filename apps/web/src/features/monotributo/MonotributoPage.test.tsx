/**
 * Monotributo page tests (Issue #8 — ADR-046, ADR-049, ADR-052, ADR-050).
 *
 * Renders the page in isolation under a memory router (no shell needed) with the
 * Query + color-mode providers, mocking the HTTP client (`monotributoClient`) per
 * ADR-038 so no real `/monotributo` fetch is hit. The real `queries.ts` hooks run
 * over the mocked client, so the query, the `select`-derived shapes, and the
 * mutation + invalidation all exercise their real code paths.
 *
 * Coverage:
 *   - real figures render (category / used / limit / % / status);
 *   - status band rendering for safe / watch / close / over;
 *   - the projection estimate note appears;
 *   - the invoice drilldown lists exactly the API invoices, cumulative included;
 *   - the "Compare to previous period" toggle: off → no comparison; on + prior →
 *     previous figures + deltas; on + no prior → calm empty state;
 *   - the category selector writes via `PATCH /settings` (ADR-054/057) and
 *     triggers a refetch (the snapshot re-fetches on success); a 422 surfaces a
 *     calm inline message;
 *   - calm loading and error states render.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
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
import { MonotributoPage } from './MonotributoPage'
import { MonotributoApiError } from '../../api/monotributoClient'
import { SettingsApiError } from '../../api/settingsClient'
import type {
  MonotributoSnapshot,
  MonotributoScaleRow,
  MonotributoStanding,
  StatusLevel,
} from '../../mock/types'

// Mock the HTTP clients so the page never touches a real backend (ADR-038). The
// query + mutation flow through the real queries.ts hooks over these mocks.
// Reads go through monotributoClient.fetchMonotributo; the category WRITE path
// moved to settingsClient.updateSettings (ADR-054/057).
const { fetchMock, updateMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  updateMock: vi.fn(),
}))

vi.mock('../../api/monotributoClient', async () => {
  // Keep the real adapters + error class + deriveComparison; only the network
  // entry point is mocked.
  const actual = await vi.importActual<
    typeof import('../../api/monotributoClient')
  >('../../api/monotributoClient')
  return {
    ...actual,
    fetchMonotributo: fetchMock,
  }
})

vi.mock('../../api/settingsClient', async () => {
  // Keep the real SettingsApiError class; mock only the write entry point.
  const actual = await vi.importActual<
    typeof import('../../api/settingsClient')
  >('../../api/settingsClient')
  return {
    ...actual,
    updateSettings: updateMock,
  }
})

/** The A–K scale, mirroring the backend's serialized rows. */
const SCALE: MonotributoScaleRow[] = [
  { letter: 'A', annualCeiling: 10_277_988, cuotaServicios: 42_387, cuotaBienes: 42_387 },
  { letter: 'B', annualCeiling: 15_058_448, cuotaServicios: 48_251, cuotaBienes: 48_251 },
  { letter: 'C', annualCeiling: 21_113_697, cuotaServicios: 56_502, cuotaBienes: 55_227 },
  { letter: 'D', annualCeiling: 26_212_853, cuotaServicios: 72_414, cuotaBienes: 70_661 },
  { letter: 'E', annualCeiling: 30_833_964, cuotaServicios: 102_538, cuotaBienes: 92_658 },
]

/** Seven included invoices, oldest-first, the final cumulative = used. */
const INVOICES = (() => {
  const raw = [
    { client: 'Beta Studio', amount: 4_106_196, fx: false },
    { client: 'Delta Corp', amount: 3_150_000, fx: false },
    { client: 'Atlas Co.', amount: 1_770_000, fx: true },
    { client: 'Gamma SA', amount: 980_000, fx: false },
    { client: 'Atlas Co.', amount: 605_000, fx: true },
    { client: 'Beta Studio', amount: 1_480_000, fx: false },
    { client: 'Atlas Co.', amount: 622_500, fx: true },
  ]
  let running = 0
  return raw.map((r, index) => {
    running += r.amount
    return {
      id: index + 1,
      dispDate: 'Jan 1',
      client: r.client,
      note: 'Income',
      amountNum: r.amount,
      cumulative: running,
      fx: r.fx,
    }
  })
})()

/** The current Category C / 60% / projected-D standing. */
const CURRENT: MonotributoStanding = {
  category: 'C',
  activityType: 'services',
  annualLimit: 21_113_697,
  used: 12_713_696,
  remaining: 8_400_000,
  percentUsed: 60,
  ratio: 0.6,
  status: 'watch',
  projectedCategory: 'D',
  projectionNote: 'Estimate, assumes steady pace',
  periodStart: '2025-06-13',
  periodEnd: '2026-06-13',
  recommendation: {
    avgMonthlyExpenses: 850_000,
    neededAnnualInvoicing: 10_200_000,
    category: 'B',
    monthlyFee: 48_251,
    annualFee: 579_012,
    effectiveTaxRatePct: 5.68,
    aboveScale: false,
  },
}

/** A prior trailing-12-month standing (Category B, lower usage, calmer band). */
const PREVIOUS: MonotributoStanding = {
  category: 'B',
  activityType: 'services',
  annualLimit: 15_058_448,
  used: 9_000_000,
  remaining: 6_058_448,
  percentUsed: 59.8,
  ratio: 0.598,
  status: 'safe',
  projectedCategory: 'C',
  projectionNote: 'Estimate, assumes steady pace',
  periodStart: '2024-06-13',
  periodEnd: '2025-06-13',
  recommendation: null,
}

function makeSnapshot(
  overrides: Partial<MonotributoSnapshot> = {},
): MonotributoSnapshot {
  return {
    current: CURRENT,
    previous: null,
    scale: SCALE,
    scaleEffectiveFrom: '2026-02-01',
    scaleNextReview: '2026-08-01',
    invoices: INVOICES,
    ...overrides,
  }
}

/**
 * Render the page over the mocked client. Pass a snapshot (or null/error mode)
 * for the initial fetch; the real query + mutation hooks run on top.
 */
function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })

  const rootRoute = createRootRoute({ component: MonotributoPage })
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

beforeEach(() => {
  fetchMock.mockResolvedValue(makeSnapshot())
  // settingsClient.updateSettings resolves the full settings row (ADR-054).
  updateMock.mockResolvedValue({
    preferredDisplayCurrency: 'ARS',
    fxDefaultRateType: 'MEP',
    preferredRateSource: 'bolsa',
    monotributoCurrentCategory: 'D',
    monotributoActivityType: 'services',
    monotributoEnabled: true,
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('real figures', () => {
  test('renders the category, used / limit, % used and the Watch status pill', async () => {
    renderPage()

    expect(
      await screen.findByRole('heading', { name: 'Monotributo' }),
    ).toBeInTheDocument()
    // Header pill: band word + % used (ADR-046).
    expect(await screen.findByText('Watch · 60% used')).toBeInTheDocument()

    // The meter spells out the % used in its accessible label.
    const meter = screen.getByRole('meter', {
      name: '60% of the Category C annual limit used',
    })
    expect(meter).toHaveAttribute('aria-valuenow', '60')

    // Used figure + margin figure (es-AR grouping, ARS prefix).
    expect(screen.getAllByText('ARS 12.713.696').length).toBeGreaterThan(0)
    expect(screen.getByText('ARS 8.400.000')).toBeInTheDocument()
  })

  test('shows the projection estimate, labeled as an estimate', async () => {
    renderPage()

    // The projection breakdown surfaces the linear-pace estimate rows.
    await screen.findByRole('heading', { name: 'The projection, broken down' })
    expect(
      await screen.findByText('Projected 12-mo total', { exact: false }),
    ).toBeInTheDocument()
    expect(screen.getByText('Monthly average')).toBeInTheDocument()

    // The hero labels the projection as an estimate (a dashed "Projected" badge +
    // the next-review note), never presenting it as a guarantee (ADR-046).
    expect(
      screen.getByText(/you'd recategorize at\s*the next review/),
    ).toBeInTheDocument()
  })
})

describe('status band rendering', () => {
  const bands: Array<{
    status: StatusLevel
    percentUsed: number
    ratio: number
    word: string
  }> = [
    { status: 'safe', percentUsed: 42, ratio: 0.42, word: 'Safe · 42% used' },
    { status: 'watch', percentUsed: 60, ratio: 0.6, word: 'Watch · 60% used' },
    { status: 'close', percentUsed: 95, ratio: 0.95, word: 'Close · 95% used' },
    { status: 'over', percentUsed: 100, ratio: 1, word: 'Over · 100% used' },
  ]

  test.each(bands)(
    'drives the $status band to the right pill copy',
    async ({ status, percentUsed, ratio, word }) => {
      fetchMock.mockResolvedValue(
        makeSnapshot({
          current: { ...CURRENT, status, percentUsed, ratio },
        }),
      )
      renderPage()

      expect(await screen.findByText(word)).toBeInTheDocument()
    },
  )
})

describe('invoice drilldown', () => {
  test('lists exactly the API invoices with the running cumulative', async () => {
    renderPage()

    const heading = await screen.findByRole('heading', {
      name: 'The 7 invoices behind this',
    })
    const card = heading.closest('section') as HTMLElement
    const scoped = within(card)

    // Each returned invoice client renders (the API already excludes expenses /
    // non-counting income, so only these seven appear).
    expect(scoped.getAllByText('Beta Studio').length).toBeGreaterThan(0)
    expect(scoped.getAllByText('Delta Corp').length).toBeGreaterThan(0)
    expect(scoped.getAllByText('Gamma SA').length).toBeGreaterThan(0)
    expect(scoped.getAllByText('Atlas Co.').length).toBeGreaterThan(0)

    // A non-counting / expense item the API would have excluded is NOT present.
    expect(scoped.queryByText('Coto groceries')).not.toBeInTheDocument()

    // The running cumulative is shown (the final cumulative equals `used`).
    expect(scoped.getAllByText('ARS 12.713.696').length).toBeGreaterThan(0)

    // Footer count + total + drill-in link to /transactions.
    expect(scoped.getByText('7 invoices · 2026')).toBeInTheDocument()
    const link = scoped.getByRole('link', { name: /Open in Transactions/ })
    expect(link).toHaveAttribute('href', '/transactions')
  })
})

describe('compare to previous period toggle (ADR-052)', () => {
  test('off by default: no comparison section', async () => {
    renderPage()
    // Wait until the page is ready (controls mounted).
    await screen.findByRole('switch', { name: 'Compare to previous period' })

    expect(
      screen.queryByRole('heading', {
        name: 'Compared to the previous period',
      }),
    ).not.toBeInTheDocument()
  })

  test('on with a prior period: shows previous figures + signed deltas', async () => {
    fetchMock.mockResolvedValue(makeSnapshot({ previous: PREVIOUS }))
    const user = userEvent.setup()
    renderPage()

    await user.click(
      await screen.findByRole('switch', {
        name: 'Compare to previous period',
      }),
    )

    const heading = await screen.findByRole('heading', {
      name: 'Compared to the previous period',
    })
    const card = heading.closest('section') as HTMLElement
    const scoped = within(card)

    // Previous invoiced figure surfaces with a "was …" line.
    expect(scoped.getByText('was ARS 9.000.000')).toBeInTheDocument()
    // The signed used delta (+3.713.696) is spelled out (sign carries direction).
    expect(scoped.getByText('+ARS 3.713.696')).toBeInTheDocument()
    // The category change is shown explicitly (B → C), not color alone.
    expect(scoped.getByText('B → C')).toBeInTheDocument()
  })

  test('on with no prior period: calm empty state', async () => {
    // Default snapshot has previous = null.
    const user = userEvent.setup()
    renderPage()

    await user.click(
      await screen.findByRole('switch', {
        name: 'Compare to previous period',
      }),
    )

    expect(
      await screen.findByText(/No prior period to compare yet/),
    ).toBeInTheDocument()
    // No delta cells when there is nothing to compare.
    expect(screen.queryByText(/^was /)).not.toBeInTheDocument()
  })
})

describe('category selector (ADR-049)', () => {
  test('changing the category writes via PATCH /settings and refetches', async () => {
    const user = userEvent.setup()
    renderPage()

    // Open the category Select and pick D.
    await user.click(
      await screen.findByRole('combobox', { name: 'Category' }),
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await user.click(
      await screen.findByRole('option', { name: 'Category D' }),
    )

    // The category write now goes through PATCH /settings (ADR-054/057): the
    // legacy { currentCategory } input is mapped to the settings payload.
    expect(updateMock).toHaveBeenCalledWith({
      monotributoCurrentCategory: 'D',
    })

    // On success the snapshot query is invalidated → a refetch fires.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })

  test('a 422 surfaces a calm inline message and keeps the page usable', async () => {
    updateMock.mockRejectedValue(
      new SettingsApiError(422, 'unknown category'),
    )
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Watch · 60% used')

    await user.click(screen.getByRole('combobox', { name: 'Category' }))
    await user.click(
      await screen.findByRole('option', { name: 'Category E' }),
    )

    // The calm inline message appears (no crash; the meter is still there).
    expect(
      await screen.findByText(/That category isn't recognized/),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('meter', {
        name: '60% of the Category C annual limit used',
      }),
    ).toBeInTheDocument()
  })
})

describe('best category for you (ADR-200)', () => {
  test('renders the recommendation block with the fitting category + rate', async () => {
    renderPage()

    const heading = await screen.findByRole('heading', {
      name: 'Best category for you',
    })
    const card = heading.closest('section') as HTMLElement
    const scoped = within(card)

    // The fitting category letter, its monthly fee, and the effective rate.
    expect(scoped.getByText('B')).toBeInTheDocument()
    expect(scoped.getByText('ARS 48.251')).toBeInTheDocument()
    expect(scoped.getByText('5.68%')).toBeInTheDocument()
  })

  test('above-scale points at the régimen general instead of a category', async () => {
    fetchMock.mockResolvedValue(
      makeSnapshot({
        current: {
          ...CURRENT,
          recommendation: {
            avgMonthlyExpenses: 40_000_000,
            neededAnnualInvoicing: 480_000_000,
            category: 'K',
            monthlyFee: 0,
            annualFee: 0,
            effectiveTaxRatePct: 0,
            aboveScale: true,
          },
        },
      }),
    )
    renderPage()

    const heading = await screen.findByRole('heading', {
      name: 'Best category for you',
    })
    const scoped = within(heading.closest('section') as HTMLElement)
    expect(scoped.getByText(/régimen general/)).toBeInTheDocument()
  })

  test('no expense history renders the calm nudge', async () => {
    fetchMock.mockResolvedValue(
      makeSnapshot({ current: { ...CURRENT, recommendation: null } }),
    )
    renderPage()

    expect(
      await screen.findByText(
        "Add a few expenses and we'll suggest the most cost-effective category.",
      ),
    ).toBeInTheDocument()
  })
})

describe('manual-threshold note (ADR-051/057)', () => {
  test('renders the AFIP scale 2026 note on the page', async () => {
    renderPage()

    expect(
      await screen.findByText(
        'Thresholds are manually maintained · AFIP scale 2026',
      ),
    ).toBeInTheDocument()
  })
})

describe('loading and error states (ADR-037)', () => {
  test('renders a calm loading scaffold while the snapshot is pending', async () => {
    // A never-resolving fetch keeps the query pending.
    fetchMock.mockReturnValue(new Promise(() => {}))
    renderPage()

    // The header h1 is always present; the meter is not yet (skeleton instead).
    expect(
      await screen.findByRole('heading', { name: 'Monotributo' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('meter')).not.toBeInTheDocument()
  })

  test('renders the calm unavailable error state when the fetch fails', async () => {
    fetchMock.mockRejectedValue(new MonotributoApiError(500, 'boom'))
    renderPage()

    expect(
      await screen.findByText('Monotributo data unavailable'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Retry' }),
    ).toBeInTheDocument()
  })
})
