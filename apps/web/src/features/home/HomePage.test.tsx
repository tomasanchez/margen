/**
 * Home dashboard ↔ month navigator integration test (ADR-040).
 *
 * Renders Home together with the top-bar MonthSwitcher inside a shared
 * MonthProvider (pinned to a deterministic month) and asserts that:
 * - the dashboard opens on the selected month (status label + that month's rows);
 * - stepping the navigator (‹ / ›) re-scopes the metrics + recent activity to a
 *   different real month, filtered by `occurredOn` year+month;
 * - a month with no transactions shows the calm empty state, not a crash.
 *
 * It also asserts the real spending trend + "Where it went" cards (ADR-043):
 * per-month {@link Summary} snapshots are seeded into the cache so no network is
 * hit; the cards render the seeded month's real values, and stepping the
 * navigator swaps to the other month's summary (month-reactive query key).
 *
 * The transactions list is seeded directly into the TanStack Query cache (rows
 * spread across two months by `occurredOn`) so no network is hit; the remaining
 * mock panels (Insights / Monotributo) resolve from the in-memory mock and are
 * not asserted here.
 */

import { expect, test } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { ColorModeProvider } from '../../theme/colorMode'
import { MonthProvider } from '../../components/MonthProvider'
import { MonthSwitcher } from '../../components/MonthSwitcher'
import { useViewingMonth } from '../../components/monthContext'
import { type ViewingMonth } from '../../components/months'
import { HomePage } from './HomePage'
import { homeQueryKeys } from './queries'
import { AddTransactionProvider } from '../transactions/AddTransactionProvider'
import { transactionsKeys } from '../transactions/queries'
import type { Summary } from '../../api/summariesClient'
import type { MonotributoSnapshot, Transaction } from '../../mock/types'

/**
 * A minimal real-shaped Monotributo snapshot the Home card's `useMonotributo`
 * query (`select`-adapted to a MonotributoState) resolves from, seeded into the
 * cache so no `/monotributo` fetch is hit. Mirrors the ADR-046 standing shape.
 */
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

/** Minimal transaction builder for the integration rows. */
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

/** June 2026 has two named rows; May 2026 has one; January 2026 has none. */
const ROWS: Transaction[] = [
  tx('j1', '2026-06-12', 'June invoice Atlas', 'income', 1000),
  tx('j2', '2026-06-08', 'June Coto groceries', 'expense', 400),
  tx('m1', '2026-05-20', 'May invoice Beta', 'income', 500),
]

/** Real summary snapshots (already adapted), keyed by the month's YYYY-MM. */
const SUMMARIES: Record<string, Summary> = {
  '2026-06': {
    trend: [
      { month: 'Jan', value: 100 },
      { month: 'Feb', value: 200 },
      { month: 'Mar', value: 300 },
      { month: 'Apr', value: 400 },
      { month: 'May', value: 500 },
      { month: 'Jun', value: 999, current: true },
    ],
    categories: [
      { category: 'Food', amount: 600, pct: 60, up: '+200%' },
      { category: 'Rent', amount: 400, pct: 40 },
    ],
  },
  '2026-05': {
    trend: [
      { month: 'Dec', value: 100 },
      { month: 'Jan', value: 100 },
      { month: 'Feb', value: 200 },
      { month: 'Mar', value: 300 },
      { month: 'Apr', value: 400 },
      { month: 'May', value: 555, current: true },
    ],
    categories: [{ category: 'Transport', amount: 250, pct: 100 }],
  },
}

/** Bridge the desktop stepper to the shared MonthProvider for the test. */
function NavBridge() {
  const { viewingMonth, setViewingMonth } = useViewingMonth()
  return (
    <MonthSwitcher
      variant="stepper"
      value={viewingMonth}
      onChange={setViewingMonth}
    />
  )
}

function renderHome(initialMonth: ViewingMonth) {
  const queryClient = new QueryClient({
    // `staleTime: Infinity` keeps the seeded caches fresh so no background
    // refetch runs (there is no `fetch` in jsdom; a refetch would error the
    // transactions query and swap in the ErrorState).
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  // Seed the shared transactions list so useTransactions resolves with no fetch,
  // and the Monotributo snapshot the StatusHero / MetricCards block on (the other
  // mock panels resolve from the in-memory mock and only affect their own
  // skeletons, which these assertions don't touch).
  queryClient.setQueryData(transactionsKeys.list(), ROWS)
  queryClient.setQueryData(homeQueryKeys.monotributo(), MONOTRIBUTO_SNAPSHOT)
  // Seed the per-month real summaries so the trend + breakdown cards resolve
  // without a fetch; stepping the navigator switches to the other month's key.
  for (const [month, summary] of Object.entries(SUMMARIES)) {
    queryClient.setQueryData(homeQueryKeys.summary(month), summary)
  }

  const rootRoute = createRootRoute({
    component: () => (
      <AddTransactionProvider>
        <MonthProvider initialMonth={initialMonth}>
          <NavBridge />
          <HomePage />
        </MonthProvider>
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

/** The Recent activity section, located by its heading. */
function recentActivitySection() {
  return screen.getByText('Recent activity').closest('section') as HTMLElement
}

test('opens on the selected month and lists that month activity', async () => {
  renderHome({ year: 2026, month: 5 }) // June 2026

  // Status label reflects the selected month.
  expect(await screen.findByText(/· June 2026/)).toBeInTheDocument()

  // Recent activity shows June rows, not the May row.
  const recent = recentActivitySection()
  await within(recent).findByText('June invoice Atlas')
  expect(within(recent).getByText('June Coto groceries')).toBeInTheDocument()
  expect(within(recent).queryByText('May invoice Beta')).not.toBeInTheDocument()
  // The row subline shows `category · bank` so same-category rows (e.g. two
  // "Fee" expenses on different banks) are distinguishable on Home.
  expect(within(recent).getAllByText('Other · Transfer').length).toBeGreaterThan(0)
})

test('stepping to the previous month re-scopes metrics and activity', async () => {
  const user = userEvent.setup()
  renderHome({ year: 2026, month: 5 }) // June 2026

  await screen.findByText(/· June 2026/)

  await user.click(screen.getByRole('button', { name: 'Previous month' }))

  // Now scoped to May 2026.
  expect(await screen.findByText(/· May 2026/)).toBeInTheDocument()

  const recent = recentActivitySection()
  await within(recent).findByText('May invoice Beta')
  expect(within(recent).queryByText('June invoice Atlas')).not.toBeInTheDocument()
})

/** The Spending trend card, located by its heading. */
function spendingTrendSection() {
  return screen.getByText('Spending trend').closest('section') as HTMLElement
}

/** The "Where it went" card, located by its heading. */
function categorySection() {
  return screen.getByText('Where it went').closest('section') as HTMLElement
}

test('renders the real summary cards for the selected month and reacts to navigation', async () => {
  const user = userEvent.setup()
  renderHome({ year: 2026, month: 5 }) // June 2026

  // Wait for the page's first paint via the status label.
  await screen.findByText(/· June 2026/)

  // June's trend + breakdown render the seeded real values. The trend's
  // accessible summary lists each month's expenses, incl. June's ARS 999.
  const trend = spendingTrendSection()
  expect(within(trend).getByText(/Jun: ARS\s*999/)).toBeInTheDocument()

  const categories = categorySection()
  expect(within(categories).getByText('Food')).toBeInTheDocument()
  // The +N% badge from the positive deltaPct (Food rose 200%).
  expect(within(categories).getByText('+200%')).toBeInTheDocument()
  expect(within(categories).getByText('Rent')).toBeInTheDocument()
  // May's categories are not shown while on June.
  expect(within(categories).queryByText('Transport')).not.toBeInTheDocument()

  // Step to May 2026 — the cards swap to May's summary (month-reactive key).
  await user.click(screen.getByRole('button', { name: 'Previous month' }))
  await screen.findByText(/· May 2026/)

  const mayCategories = categorySection()
  await within(mayCategories).findByText('Transport')
  expect(within(mayCategories).queryByText('Food')).not.toBeInTheDocument()
  // May's current trend bar is ARS 555.
  expect(within(spendingTrendSection()).getByText(/May: ARS\s*555/)).toBeInTheDocument()
})

/** The Monotributo card, located by its "Category C" header. */
function monotributoCardSection() {
  return screen
    .getByText('Monotributo · Category C')
    .closest('section') as HTMLElement
}

test('the Monotributo card shows the real standing and the invoice drill-in link', async () => {
  renderHome({ year: 2026, month: 5 }) // June 2026 (one invoice: j1)

  await screen.findByText(/· June 2026/)

  const card = monotributoCardSection()
  const scoped = within(card)

  // The card reads the real standing adapted from the seeded snapshot:
  // category in the header, used / annual-limit figures, and the % used.
  expect(scoped.getByText('Monotributo · Category C')).toBeInTheDocument()
  expect(scoped.getByText('ARS 12.713.696')).toBeInTheDocument()
  expect(
    scoped.getByText('used of ARS 21.113.697 annual limit'),
  ).toBeInTheDocument()
  expect(scoped.getByText('60% used')).toBeInTheDocument()
  // `remaining` surfaces as the margin figure.
  expect(scoped.getByText('ARS 8.400.001 margin')).toBeInTheDocument()
  // The status pill carries the watch band (icon + text, never color alone).
  expect(scoped.getByRole('status', { name: /watch/i })).toBeInTheDocument()

  // The drill-in link to the Transactions screen renders pre-filtered to
  // invoices over the last 12 months (ADR-062/ADR-116: the window is carried
  // explicitly); the seed has no invoice-kind rows in June, so the count reads
  // zero (the singular/plural copy is covered at the MonotributoCard level).
  expect(
    scoped.getByRole('link', { name: 'See the 0 invoices behind this →' }),
  ).toHaveAttribute('href', '/transactions?type=invoice&month=last12')
})

test('a month with no transactions shows the calm empty state', async () => {
  const user = userEvent.setup()
  renderHome({ year: 2026, month: 1 }) // February 2026 — no rows

  expect(await screen.findByText(/· February 2026/)).toBeInTheDocument()

  const recent = recentActivitySection()
  await within(recent).findByText(/No activity yet/)
  expect(within(recent).queryByText('June invoice Atlas')).not.toBeInTheDocument()

  // Navigating to a month with rows brings activity back (still no crash).
  await user.click(screen.getByRole('button', { name: 'Next month' })) // March
  await user.click(screen.getByRole('button', { name: 'Next month' })) // April
  await user.click(screen.getByRole('button', { name: 'Next month' })) // May
  await within(recentActivitySection()).findByText('May invoice Beta')
})
