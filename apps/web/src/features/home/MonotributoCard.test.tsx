/**
 * Unit tests for the Home Monotributo card (ADR-019, ADR-046, ADR-050).
 *
 * The card renders standalone (a memory router supplies the drill-in <Link>),
 * fed a {@link MonotributoState} directly — the `useMonotributo` query +
 * `standingToState` adapter are covered separately (queries / derive). Here we
 * assert the presentation: the standing figures, the status-band mapping for the
 * Monotributo-only `close` / `over` bands, the singular/plural invoice link, and
 * the calm empty + loading fallbacks.
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
import { MonotributoCard, type MonotributoCardProps } from './MonotributoCard'
import type { MonotributoState } from '../../mock/types'

const BASE: MonotributoState = {
  category: 'C',
  used: 12_713_696,
  annualLimit: 21_113_697,
  usedRatio: 0.6,
  margin: 8_400_001,
  projectedCategory: 'D',
  projectedPaceLabel: 'Estimate, assumes steady pace',
  status: 'watch',
}

function renderCard(props: MonotributoCardProps) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute({ component: () => <MonotributoCard {...props} /> })
  const transactionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/transactions',
    // Mirror the app route's search validation so the drill-in <Link>'s
    // `search={{ type: 'invoice' }}` is preserved into the rendered href.
    validateSearch: (search: Record<string, unknown>) =>
      search.type === 'invoice' ? { type: 'invoice' as const } : {},
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

describe('standing figures', () => {
  test('shows category, used / limit, % used, margin and the projected category', async () => {
    renderCard({ monotributo: BASE, invoiceCount: 7 })

    expect(
      await screen.findByText('Monotributo · Category C'),
    ).toBeInTheDocument()
    expect(screen.getByText('ARS 12.713.696')).toBeInTheDocument()
    expect(
      screen.getByText('used of ARS 21.113.697 annual limit'),
    ).toBeInTheDocument()
    expect(screen.getByText('60% used')).toBeInTheDocument()
    expect(screen.getByText('ARS 8.400.001 margin')).toBeInTheDocument()
    // The projected category and the API's estimate note are passed through.
    expect(screen.getByText('D')).toBeInTheDocument()
    expect(screen.getByText('Estimate, assumes steady pace')).toBeInTheDocument()
  })

  test('the meter aria-label spells out the % used (not color alone)', async () => {
    renderCard({ monotributo: BASE, invoiceCount: 7 })
    expect(
      await screen.findByRole('progressbar', {
        name: 'Monotributo limit used: 60%',
      }),
    ).toBeInTheDocument()
  })
})

describe('status band mapping', () => {
  test('maps a close band to the Close status pill', async () => {
    renderCard({
      monotributo: { ...BASE, status: 'close', usedRatio: 0.95 },
      invoiceCount: 7,
    })
    // role=status carries the band; the pill text reads "Close".
    expect(
      await screen.findByRole('status', { name: /close to your limit/i }),
    ).toBeInTheDocument()
    expect(screen.getByText('Close')).toBeInTheDocument()
    expect(screen.getByText('95% used')).toBeInTheDocument()
  })

  test('maps an over band to the Over status pill', async () => {
    renderCard({
      monotributo: { ...BASE, status: 'over', usedRatio: 1.04 },
      invoiceCount: 7,
    })
    expect(
      await screen.findByRole('status', { name: /over your limit/i }),
    ).toBeInTheDocument()
    expect(screen.getByText('Over')).toBeInTheDocument()
    // The meter ratio clamps to 100% even when usage exceeds the ceiling.
    expect(screen.getByText('100% used')).toBeInTheDocument()
  })
})

describe('invoice drill-in link', () => {
  test('pluralizes for many invoices and drills into the invoice filter', async () => {
    renderCard({ monotributo: BASE, invoiceCount: 7 })
    // The link drills into Transactions pre-filtered to invoices (ADR-062
    // pattern): the typed `search={{ type: 'invoice' }}` lands in the href.
    expect(
      await screen.findByRole('link', { name: 'See the 7 invoices behind this →' }),
    ).toHaveAttribute('href', '/transactions?type=invoice')
  })

  test('uses the singular for exactly one invoice', async () => {
    renderCard({ monotributo: BASE, invoiceCount: 1 })
    expect(
      await screen.findByRole('link', { name: 'See the 1 invoice behind this →' }),
    ).toBeInTheDocument()
  })
})

describe('fallback states', () => {
  test('shows the calm set-up state when no category is configured', async () => {
    renderCard({ monotributo: undefined, invoiceCount: 0 })
    expect(
      await screen.findByText(/Set up your Monotributo category/),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Set up category' }),
    ).toBeInTheDocument()
  })

  test('renders the loading skeleton without crashing', () => {
    renderCard({ monotributo: undefined, invoiceCount: 0, loading: true })
    // No figures and no set-up CTA while loading.
    expect(screen.queryByText(/annual limit/)).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Set up category' }),
    ).not.toBeInTheDocument()
  })
})
