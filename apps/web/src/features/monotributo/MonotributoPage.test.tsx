import { expect, test } from 'vitest'
import { render, screen, within } from '@testing-library/react'
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

/**
 * Focused Monotributo page test (ADR-018, ADR-019, ADR-023).
 *
 * Renders the page in isolation under a memory router (no shell needed) with the
 * Query + color-mode providers, then asserts the meter standing (used / margin /
 * "60% used" + accessible label), that the current (C) and projected (D)
 * categories are marked beyond color in the scale, and that the invoice
 * drilldown lists the seeded invoices.
 */

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute({ component: MonotributoPage })
  // A sibling /transactions stub so the "Open in Transactions" link type-checks.
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

test('renders the page heading and the Watch status pill with % used', async () => {
  renderPage()

  expect(
    await screen.findByRole('heading', { name: 'Monotributo' }),
  ).toBeInTheDocument()
  // Status pill carries the standing; label spells out the % used.
  expect(await screen.findByText('Watch · 60% used')).toBeInTheDocument()
})

test('the meter shows the used / margin figures, "60% used", and an accessible label', async () => {
  renderPage()

  // Wait for data to resolve (the mock API has simulated latency).
  await screen.findByText('Projected to reach the ceiling around', {
    exact: false,
  })

  // Accessible meter label (ADR-019: % used, not color alone).
  const meter = screen.getByRole('meter', {
    name: '60% of the Category C annual limit used',
  })
  expect(meter).toBeInTheDocument()
  expect(meter).toHaveAttribute('aria-valuenow', '60')

  // The "60% used" caption beneath the bar.
  expect(screen.getByText('60% used')).toBeInTheDocument()
  // Used figure (mono es-AR grouping) and the Safe margin figure.
  expect(screen.getAllByText('ARS 12.713.696').length).toBeGreaterThan(0)
  expect(screen.getByText('ARS 8.400.000')).toBeInTheDocument()
})

test('marks the current (C) and projected (D) categories in the full scale beyond color', async () => {
  renderPage()

  // Wait for the data to resolve (the skeleton reuses the section titles, so
  // anchor the wait on the "Current" tag, which only renders with data). The
  // current (C) / projected (D) scale rows carry "Current" / "Projected" tags —
  // a non-color cue (ADR-019). Scope to the scale section because "Projected"
  // also appears in the meter badge.
  const currentTag = await screen.findByText('Current')
  const scaleCard = currentTag.closest('section') as HTMLElement
  const scoped = within(scaleCard)
  expect(scoped.getByText('Current')).toBeInTheDocument()
  expect(scoped.getByText('Projected')).toBeInTheDocument()

  // The ladder marks the current/projected with "Now" / "Proj." text tags too.
  expect(screen.getByText('Now')).toBeInTheDocument()
  expect(screen.getByText('Proj.')).toBeInTheDocument()
})

test('lists the seeded invoices in the drilldown with a Transactions link', async () => {
  renderPage()

  const drilldownHeading = await screen.findByRole('heading', {
    name: 'The 7 invoices behind this',
  })
  const card = drilldownHeading.closest('section') as HTMLElement
  const scoped = within(card)

  // The seeded invoices appear (clients render once per surface; assert presence).
  expect(scoped.getAllByText('Beta Studio').length).toBeGreaterThan(0)
  expect(scoped.getAllByText('Delta Corp').length).toBeGreaterThan(0)
  expect(scoped.getAllByText('Gamma SA').length).toBeGreaterThan(0)
  expect(scoped.getAllByText('Cliente Atlas').length).toBeGreaterThan(0)

  // Footer total + a real drill-in link to /transactions.
  expect(scoped.getByText('7 invoices · 2026')).toBeInTheDocument()
  const link = scoped.getByRole('link', { name: /Open in Transactions/ })
  expect(link).toHaveAttribute('href', '/transactions')
})
