/**
 * <BudgetRow> reimbursed-caption checks (ADR-158/160).
 *
 * A budget line's `spent` is NET of linked reimbursements; `reimbursed` is the
 * gross payback reduction (in the display currency, before the floor). When it is
 * positive the row surfaces a subtle "− $X reimbursed" caption so the user knows
 * `spent` is net, not gross; when it is "0" no caption renders. Money is asserted
 * via the shared es-AR formatter and the row is rendered behind a memory router
 * so its drill-in <Link> resolves. English-pinned (ADR-105).
 */

import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClientProvider, QueryClient } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { ThemeProvider } from '@mui/material/styles'
import { darkTheme } from '../../theme'
import { BudgetRow } from './BudgetRow'
import type { BudgetCategory } from '../../api/budgetsClient'

/** A Food line under budget; `reimbursed` is parameterized per test. */
function line(reimbursed: string): BudgetCategory {
  return {
    category: 'Food',
    target: '120000.00',
    targetCurrency: 'ARS',
    spent: '90000.00',
    reimbursed,
    remaining: '30000.00',
    isEssential: true,
  }
}

/** Render <BudgetRow> behind the providers its <Link> + query hooks need. */
function renderRow(reimbursed: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <BudgetRow
        line={line(reimbursed)}
        currency="ARS"
        month="2026-06"
        onCommit={() => {}}
        onClear={() => {}}
      />
    ),
  })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider theme={darkTheme}>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <RouterProvider router={router as any} />
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

describe('<BudgetRow> reimbursed caption (ADR-158/160)', () => {
  test('shows the "− reimbursed" caption when reimbursed > 0', async () => {
    renderRow('12000.00')
    // The subtle reimbursed reduction surfaces so `spent` reads as net, not gross.
    expect(
      await screen.findByText('− ARS 12.000 reimbursed'),
    ).toBeInTheDocument()
    // The net spent figure is shown against the target (already net server-side).
    expect(screen.getByText(/90\.000/)).toBeInTheDocument()
  })

  test('shows no caption when reimbursed is "0"', async () => {
    renderRow('0')
    // Wait for the row to render (async router), then assert no caption.
    expect(await screen.findByText(/90\.000/)).toBeInTheDocument()
    expect(screen.queryByText(/reimbursed/)).not.toBeInTheDocument()
  })
})
