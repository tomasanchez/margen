/**
 * Home display-currency tests (ADR-056/057, test plan ADR-058).
 *
 * The base Home integration tests (HomePage.test.tsx) render with the ARS-only
 * default and no DisplayCurrencyProvider. This focused file wraps the Home tree
 * in {@link DisplayCurrencyProvider} with the settings client + FX adapter mocked
 * (ADR-038 / ADR-044) so the USD display transform runs end-to-end through the
 * real provider:
 *   - settings=USD + a mocked live rate → the metric cards render USD-converted
 *     figures (ARS ÷ rate, USD prefix);
 *   - the rate unavailable (null) → the cards stay in ARS and the calm fallback
 *     note renders (ADR-037).
 *
 * The transactions + Monotributo + summaries caches are seeded directly so the
 * only network surface exercised is the provider's rate fetch (mocked).
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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { ColorModeProvider } from '../../theme/colorMode'
import { MonthProvider } from '../../components/MonthProvider'
import { type ViewingMonth } from '../../components/months'
import { HomePage } from './HomePage'
import { homeQueryKeys } from './queries'
import { DisplayCurrencyProvider } from '../settings/displayCurrency'
import { AddTransactionProvider } from '../transactions/AddTransactionProvider'
import { transactionsKeys } from '../transactions/queries'
import type { Summary } from '../../api/summariesClient'
import type { MonotributoSnapshot, Transaction } from '../../mock/types'
import type { Settings } from '../../api/settingsClient'

// Mock the settings client (drives the preferred display currency) and the FX
// adapter (drives the single live conversion rate). The DisplayCurrencyProvider
// reads both through its real queries over these mocks.
const { fetchSettingsMock, mepMock, officialMock, currentRateMock } =
  vi.hoisted(() => ({
    fetchSettingsMock: vi.fn(),
    mepMock: vi.fn(),
    officialMock: vi.fn(),
    currentRateMock: vi.fn(),
  }))

vi.mock('../../api/settingsClient', async () => {
  const actual = await vi.importActual<
    typeof import('../../api/settingsClient')
  >('../../api/settingsClient')
  return { ...actual, fetchSettings: fetchSettingsMock }
})

vi.mock('../../api/fxClient', () => ({
  fetchSuggestedMepRate: mepMock,
  fetchSuggestedOfficialRate: officialMock,
  // The budgets preferred-rate query (ADR-155) fetches the current rate; expose
  // it so the Home budget card can convert native targets/income when needed.
  fetchCurrentRate: currentRateMock,
}))

const MONOTRIBUTO_SNAPSHOT: MonotributoSnapshot = {
  current: {
    category: 'C',
    activityType: 'services',
    annualLimit: 21_113_697,
    used: 12_713_696,
    remaining: 8_400_001,
    percentUsed: 60,
    ratio: 0.6,
    status: 'watch',
    projectedCategory: 'D',
    projectionNote: 'Estimate, assumes steady pace',
    periodStart: '2025-06-01',
    periodEnd: '2026-06-01',
  },
  previous: null,
  scale: [],
  invoices: [],
}

function tx(
  id: string,
  occurredOn: string,
  name: string,
  type: 'income' | 'expense',
  amountNum: number,
): Transaction {
  return {
    id,
    occurredOn,
    dispDate: occurredOn.slice(5),
    month: 'June',
    name,
    category: 'Other',
    bank: 'Transfer',
    currency: 'ARS',
    type,
    kind: type === 'income' ? 'income' : 'expense',
    amountNum,
  }
}

/** June 2026: income 1.000.000 ARS, expenses 400.000 ARS → savings 600.000. */
const ROWS: Transaction[] = [
  tx('j1', '2026-06-12', 'June invoice Atlas', 'income', 1_000_000),
  tx('j2', '2026-06-08', 'June Coto groceries', 'expense', 400_000),
]

const SUMMARY: Summary = {
  trend: [{ month: 'Jun', value: 400_000, current: true }],
  categories: [{ category: 'Other', amount: 400_000, pct: 100 }],
}

function renderHome(initialMonth: ViewingMonth) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  queryClient.setQueryData(transactionsKeys.list(), ROWS)
  queryClient.setQueryData(homeQueryKeys.monotributo(), MONOTRIBUTO_SNAPSHOT)
  queryClient.setQueryData(homeQueryKeys.summary('2026-06'), SUMMARY)

  const rootRoute = createRootRoute({
    component: () => (
      <AddTransactionProvider>
        <DisplayCurrencyProvider>
          <MonthProvider initialMonth={initialMonth}>
            <HomePage />
          </MonthProvider>
        </DisplayCurrencyProvider>
      </AddTransactionProvider>
    ),
  })
  const router = createRouter({
    routeTree: rootRoute,
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

/** The metric card with the given eyebrow label. */
function metricCard(label: string) {
  return screen.getByText(label).closest('div') as HTMLElement
}

beforeEach(() => {
  mepMock.mockResolvedValue(100)
  officialMock.mockResolvedValue(90)
  // The budgets preferred-rate query resolves to the same MEP rate by default.
  currentRateMock.mockResolvedValue(100)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('USD preferred with a live rate', () => {
  test('the metric cards render USD-converted figures', async () => {
    fetchSettingsMock.mockResolvedValue({
      preferredDisplayCurrency: 'USD',
      fxDefaultRateType: 'MEP',
      preferredRateSource: 'bolsa',
      monotributoCurrentCategory: 'C',
      monotributoActivityType: 'services',
      monotributoEnabled: true,
    } satisfies Settings)

    renderHome({ year: 2026, month: 5 }) // June 2026

    // Income 1.000.000 / 100 = USD 10.000. Wait for the converted figure.
    await screen.findByText('USD 10.000')
    // Expenses 400.000 / 100 = USD 4.000.
    expect(within(metricCard('Expenses')).getByText('USD 4.000')).toBeInTheDocument()
    // Est. savings 600.000 / 100 = USD 6.000.
    expect(within(metricCard('Est. savings')).getByText('USD 6.000')).toBeInTheDocument()

    // No fallback note when a rate is available.
    expect(
      screen.queryByText(/couldn't fetch a USD rate/),
    ).not.toBeInTheDocument()
  })
})

describe('USD preferred but the rate is unavailable', () => {
  test('the cards stay in ARS and the calm fallback note renders', async () => {
    fetchSettingsMock.mockResolvedValue({
      preferredDisplayCurrency: 'USD',
      fxDefaultRateType: 'MEP',
      preferredRateSource: 'bolsa',
      monotributoCurrentCategory: 'C',
      monotributoActivityType: 'services',
      monotributoEnabled: true,
    } satisfies Settings)
    mepMock.mockResolvedValue(null)

    renderHome({ year: 2026, month: 5 }) // June 2026

    // The calm fallback note appears once the rate fetch settles with no rate.
    await screen.findByText(/couldn't fetch a USD rate/)

    // Figures fall back to ARS (no USD conversion).
    await waitFor(() =>
      expect(
        within(metricCard('Income')).getByText('ARS 1.000.000'),
      ).toBeInTheDocument(),
    )
    expect(
      within(metricCard('Expenses')).getByText('ARS 400.000'),
    ).toBeInTheDocument()
  })
})
