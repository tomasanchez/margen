/**
 * Unit tests for the Home Insights card (Issue #6, ADR-060/061/062).
 *
 * The card composes the structured {@link MonthlyInsights} facts into calm,
 * ordered sentences (mover → recurring → savings → fx); only non-null facts
 * produce a row, and a truly empty month falls back to the calm empty state
 * (ADR-037). Money is formatted through the display-currency context
 * (`useDisplayMoney`, ADR-056), so the card is wrapped in
 * {@link DisplayCurrencyProvider} with the settings client + FX adapter mocked
 * (ADR-038 / ADR-044) — no real network. The default (ARS) path needs no rate
 * fetch; the USD variant exercises the conversion end-to-end.
 *
 * The facts are fed as props (the card's unit boundary); the `useInsights`
 * query + `fetchInsights` adapter are covered separately
 * (insightsClient.test.ts / queries).
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Insights } from './Insights'
import { DisplayCurrencyProvider } from '../settings/displayCurrency'
import type { MonthlyInsights } from '../../api/insightsClient'
import type { Settings } from '../../api/settingsClient'

// Mock the settings client (drives the preferred display currency) and the FX
// adapter (drives the single live conversion rate). The DisplayCurrencyProvider
// reads both through its real queries over these mocks (ADR-038 / ADR-044).
const { fetchSettingsMock, mepMock, officialMock } = vi.hoisted(() => ({
  fetchSettingsMock: vi.fn(),
  mepMock: vi.fn(),
  officialMock: vi.fn(),
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
}))

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    preferredDisplayCurrency: 'ARS',
    fxDefaultRateType: 'MEP',
    preferredRateSource: 'bolsa',
    monotributoCurrentCategory: 'C',
    monotributoActivityType: 'services',
    monotributoEnabled: true,
    ...overrides,
  }
}

/** A complete facts object — every optional fact present (current month). */
const FULL: MonthlyInsights = {
  month: '2026-06',
  topCategoryMover: { category: 'Food', deltaPct: 22 },
  recurring: { count: 3, total: 45_000 },
  savings: { amount: 600_000, isProjected: true, elapsedFraction: 0.45 },
  latestUsdInvoice: {
    usd: 500,
    rate: 1450,
    rateType: 'MEP',
    occurredOn: '2026-06-10',
  },
  upcomingCardDue: null,
}

function renderInsights(insights: MonthlyInsights | undefined) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <DisplayCurrencyProvider>
        <Insights insights={insights} />
      </DisplayCurrencyProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  // ARS default for most tests: no conversion, the provider never fetches a rate.
  fetchSettingsMock.mockResolvedValue(makeSettings())
  mepMock.mockResolvedValue(1000)
  officialMock.mockResolvedValue(900)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('calm sentences (ARS)', () => {
  test('renders the biggest-mover sentence with the +N% delta', async () => {
    renderInsights(FULL)
    expect(
      await screen.findByText('Food is up +22% vs last month'),
    ).toBeInTheDocument()
    // The eyebrow label carries the meaning (never color alone, ADR-019).
    expect(screen.getByText('Spending')).toBeInTheDocument()
  })

  test('renders the recurring sentence with the count and ARS total', () => {
    renderInsights(FULL)
    expect(
      screen.getByText('3 recurring expenses · ≈ ARS 45.000'),
    ).toBeInTheDocument()
    expect(screen.getByText('Recurring')).toBeInTheDocument()
  })

  test('uses the singular noun for exactly one recurring expense', () => {
    renderInsights({ ...FULL, recurring: { count: 1, total: 12_000 } })
    expect(
      screen.getByText('1 recurring expense · ≈ ARS 12.000'),
    ).toBeInTheDocument()
  })

  test('renders the projected-savings sentence for a current (projected) month', () => {
    renderInsights(FULL)
    expect(
      screen.getByText('At this pace, projected savings ≈ ARS 600.000'),
    ).toBeInTheDocument()
    expect(screen.getByText('Projection')).toBeInTheDocument()
  })

  test('renders the actual-savings sentence for a past month', () => {
    renderInsights({
      ...FULL,
      savings: { amount: 320_000, isProjected: false, elapsedFraction: 1 },
    })
    expect(screen.getByText('Saved ARS 320.000 this month')).toBeInTheDocument()
    // A past month uses the "Savings" eyebrow, not "Projection".
    expect(screen.getByText('Savings')).toBeInTheDocument()
    expect(screen.queryByText('Projection')).not.toBeInTheDocument()
  })

  test('renders the latest USD invoice with the literal USD, rate source, and date', () => {
    renderInsights(FULL)
    expect(
      screen.getByText('Latest invoice · USD 500 at MEP 1.450 · 2026-06-10'),
    ).toBeInTheDocument()
    expect(screen.getByText('FX')).toBeInTheDocument()
  })
})

describe('sparse and empty months', () => {
  test('omits rows for null facts but always keeps savings', async () => {
    renderInsights({
      month: '2026-06',
      topCategoryMover: null,
      recurring: null,
      savings: { amount: 100_000, isProjected: true, elapsedFraction: 0.5 },
      latestUsdInvoice: null,
      upcomingCardDue: null,
    })

    expect(
      await screen.findByText('At this pace, projected savings ≈ ARS 100.000'),
    ).toBeInTheDocument()
    // No mover / recurring / fx eyebrows when those facts are absent.
    expect(screen.queryByText('Spending')).not.toBeInTheDocument()
    expect(screen.queryByText('Recurring')).not.toBeInTheDocument()
    expect(screen.queryByText('FX')).not.toBeInTheDocument()
  })

  test('shows the calm empty state when no facts apply (all null, zero savings)', () => {
    renderInsights({
      month: '2026-02',
      topCategoryMover: null,
      recurring: null,
      savings: { amount: 0, isProjected: false, elapsedFraction: 0 },
      latestUsdInvoice: null,
      upcomingCardDue: null,
    })

    // A zero-savings month with no other facts carries no signal, so the savings
    // row is omitted and the card falls through to the calm empty state (ADR-037)
    // rather than a noisy "Saved ARS 0" line. (Previously the always-pushed
    // savings row made the empty state unreachable; the empty copy was dead.)
    expect(
      screen.getByText(
        'No insights yet — add a few transactions to see patterns here.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText('Saved ARS 0 this month')).not.toBeInTheDocument()
  })

  test('still shows a zero-savings row when another fact gives the month signal', () => {
    // Zero savings is omitted, but a present mover keeps the card populated — the
    // empty state is only for a truly signal-free month, not any zero-savings one.
    renderInsights({
      month: '2026-02',
      topCategoryMover: { category: 'Food', deltaPct: 10 },
      recurring: null,
      savings: { amount: 0, isProjected: false, elapsedFraction: 0 },
      latestUsdInvoice: null,
      upcomingCardDue: null,
    })

    expect(screen.getByText('Food is up +10% vs last month')).toBeInTheDocument()
    // Savings still omitted (zero), but the card is not empty.
    expect(screen.queryByText('Saved ARS 0 this month')).not.toBeInTheDocument()
    expect(
      screen.queryByText(
        'No insights yet — add a few transactions to see patterns here.',
      ),
    ).not.toBeInTheDocument()
  })

  test('renders the loading skeleton (no sentences) when insights is undefined', () => {
    renderInsights(undefined)
    expect(screen.queryByText(/vs last month/)).not.toBeInTheDocument()
    expect(screen.queryByText(/projected savings/)).not.toBeInTheDocument()
  })
})

describe('upcoming card payment due (ADR-192)', () => {
  // The row's today-vs-upcoming emphasis compares against the client clock
  // (todayIsoDate), so pin the system time for deterministic copy.
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 6, 12, 0, 0)) // 2026-07-06, local noon
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('emphasizes "today" with the native ARS + USD amounts for a due-today entry', () => {
    renderInsights({
      ...FULL,
      upcomingCardDue: [{ dueDate: '2026-07-06', ars: 12_450, usd: 230 }],
    })

    // Native amounts side by side (ARS first), never summed or converted.
    expect(
      screen.getByText(
        'Card payment due today — ARS 12.450 / USD 230 — check your balance',
      ),
    ).toBeInTheDocument()
    // The eyebrow label carries the meaning (never color alone, ADR-019).
    expect(screen.getByText('Card payment')).toBeInTheDocument()
  })

  test('states the localized date for a future entry', () => {
    renderInsights({
      ...FULL,
      upcomingCardDue: [{ dueDate: '2026-07-09', ars: 0, usd: 230 }],
    })

    expect(
      screen.getByText('Card payment of USD 230 due Jul 9, 2026'),
    ).toBeInTheDocument()
  })

  test('shows only the ARS part for an ARS-only entry', () => {
    renderInsights({
      ...FULL,
      upcomingCardDue: [{ dueDate: '2026-07-06', ars: 12_450, usd: 0 }],
    })

    expect(
      screen.getByText(
        'Card payment due today — ARS 12.450 — check your balance',
      ),
    ).toBeInTheDocument()
  })

  test('shows only the USD part for a USD-only entry', () => {
    renderInsights({
      ...FULL,
      upcomingCardDue: [{ dueDate: '2026-07-06', ars: 0, usd: 230 }],
    })

    expect(
      screen.getByText('Card payment due today — USD 230 — check your balance'),
    ).toBeInTheDocument()
  })

  test('renders one row per due date, in the delivered order', () => {
    renderInsights({
      ...FULL,
      upcomingCardDue: [
        { dueDate: '2026-07-06', ars: 12_450, usd: 0 },
        { dueDate: '2026-07-09', ars: 0, usd: 230 },
      ],
    })

    expect(
      screen.getByText(
        'Card payment due today — ARS 12.450 — check your balance',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Card payment of USD 230 due Jul 9, 2026'),
    ).toBeInTheDocument()
  })

  test('renders no card-due row when the fact is null', () => {
    renderInsights({ ...FULL, upcomingCardDue: null })
    expect(screen.queryByText('Card payment')).not.toBeInTheDocument()
    expect(screen.queryByText(/Card payment/)).not.toBeInTheDocument()
  })
})

describe('display currency (USD)', () => {
  test('converts the recurring + savings ARS money to USD via the live rate', async () => {
    fetchSettingsMock.mockResolvedValue(
      makeSettings({ preferredDisplayCurrency: 'USD', fxDefaultRateType: 'MEP' }),
    )
    mepMock.mockResolvedValue(1000)

    renderInsights(FULL)

    // recurring 45.000 / 1000 = USD 45; savings 600.000 / 1000 = USD 600.
    await screen.findByText('3 recurring expenses · ≈ USD 45')
    expect(
      screen.getByText('At this pace, projected savings ≈ USD 600'),
    ).toBeInTheDocument()
    // The FX invoice keeps its literal original USD + ARS rate (not converted).
    expect(
      screen.getByText('Latest invoice · USD 500 at MEP 1.450 · 2026-06-10'),
    ).toBeInTheDocument()
  })
})
