/**
 * Interaction tests for the Transactions screen (ADR-018).
 *
 * These render the real TransactionsPage against the in-memory mock async layer
 * and exercise the AC-critical behaviors through the UI: search/filter narrows
 * BOTH the visible rows and the header totals, the no-results empty state shows,
 * and deleting a row removes it. The pure filter math is already covered by
 * filtering.test.ts — here we assert the wiring (query -> filter -> totals/rows
 * -> mutation) holds end to end. Queries prefer roles/labels per ADR-019.
 *
 * NOTE: jsdom renders both the desktop and mobile surfaces, so role/label lookups
 * can match twice (one per surface); tests use getAllBy / within where that
 * matters. The mock store is a mutated singleton, so a beforeEach re-seeds it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '../../test/renderWithProviders'
import { __resetMockStore } from '../../mock/api'
import { TransactionsPage } from './TransactionsPage'

beforeEach(() => {
  __resetMockStore()
})

afterEach(() => {
  // Re-seed again so a mutating test never bleeds into a later file/run.
  __resetMockStore()
})

/** Wait for the latency-simulated list to resolve (a known seed row appears). */
async function waitForRows() {
  return screen.findAllByText('Coto supermarket')
}

/** Read the "<n> shown" count out of the header summary line. */
function shownCount(): number {
  const node = screen.getByText('shown', { exact: false })
  // The count is the preceding sibling span; the whole line text is e.g.
  // "19 shown · +ARS … in · −ARS … out · net …". Pull the leading integer.
  const text = node.closest('p')?.textContent ?? ''
  const match = text.match(/(\d+)\s*shown/)
  return match ? Number(match[1]) : Number.NaN
}

describe('TransactionsPage filtering', () => {
  test('a search query narrows the rows AND updates the header count', async () => {
    const user = userEvent.setup()
    renderWithProviders(<TransactionsPage />, { withAddProvider: true })

    await waitForRows()
    // All 19 seeded rows are shown initially.
    expect(shownCount()).toBe(19)

    // The search field exposes the searchbox role; jsdom renders both the
    // desktop bar and the mobile bar (shared filter state), so type into the
    // first — both stay in lockstep via useTransactionFilters.
    const search = screen.getAllByRole('searchbox')[0]
    await user.type(search, 'Apartment')

    // Only the three "Apartment rent" rent rows survive (Jun/May/Apr).
    await waitFor(() => expect(shownCount()).toBe(3))

    // The matching row is present and a non-matching seed row is gone.
    expect(screen.getAllByText('Apartment rent').length).toBeGreaterThan(0)
    expect(screen.queryByText('Coto supermarket')).not.toBeInTheDocument()
  })

  test('a type filter narrows rows and recomputes the totals', async () => {
    const user = userEvent.setup()
    renderWithProviders(<TransactionsPage />, { withAddProvider: true })

    await waitForRows()
    expect(shownCount()).toBe(19)

    // Activate the "Invoices" type segment in the desktop FilterBar. Invoices
    // are income with kind === 'invoice' (ids 1, 10, 14, 17 in the seed).
    const invoiceToggle = screen.getAllByRole('button', { name: 'Invoices' })[0]
    await user.click(invoiceToggle)

    await waitFor(() => expect(shownCount()).toBe(4))

    // An expense-only row drops out; an invoice row stays.
    expect(screen.queryByText('Coto supermarket')).not.toBeInTheDocument()
    expect(
      screen.getAllByText('Invoice · Beta Studio').length,
    ).toBeGreaterThan(0)

    // Totals recompute: with only inflow rows left, the "out" figure is ARS 0.
    const summary = screen.getByText('shown', { exact: false }).closest('p')
    expect(summary?.textContent).toMatch(/−ARS 0 out/)
  })

  test('a search with no matches shows the empty state and clears the rows', async () => {
    const user = userEvent.setup()
    renderWithProviders(<TransactionsPage />, { withAddProvider: true })

    await waitForRows()

    const search = screen.getAllByRole('searchbox')[0]
    await user.type(search, 'zzzznomatch')

    expect(
      await screen.findByText('No transactions match these filters.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Coto supermarket')).not.toBeInTheDocument()
    // The "clear your filters" affordance is offered when filters are active.
    expect(
      screen.getByRole('button', { name: /clearing your filters/ }),
    ).toBeInTheDocument()
  })
})

describe('TransactionsPage delete', () => {
  test('deleting a row removes it and decrements the shown count', async () => {
    const user = userEvent.setup()
    renderWithProviders(<TransactionsPage />, { withAddProvider: true })

    await waitForRows()
    expect(shownCount()).toBe(19)

    // Narrow to a single, unambiguous row first so the delete target is exact.
    const search = screen.getAllByRole('searchbox')[0]
    await user.type(search, 'Farmacity')
    await waitFor(() => expect(shownCount()).toBe(1))

    // Delete it (the row exposes an accessible "Delete <name>" action; the
    // desktop + mobile surfaces both render one, so click the first).
    const deleteButton = screen.getAllByRole('button', {
      name: 'Delete Farmacity',
    })[0]
    await user.click(deleteButton)

    // After the mutation + cache invalidation round-trip, the row is gone and
    // the filtered list is empty.
    await waitFor(() =>
      expect(screen.queryByText('Farmacity')).not.toBeInTheDocument(),
    )
    expect(
      screen.getByText('No transactions match these filters.'),
    ).toBeInTheDocument()
  })

  test('after clearing a delete-filter, the deleted row is absent from the full list', async () => {
    const user = userEvent.setup()
    renderWithProviders(<TransactionsPage />, { withAddProvider: true })

    await waitForRows()

    const search = screen.getAllByRole('searchbox')[0]
    await user.type(search, 'Uber')
    await waitFor(() => expect(shownCount()).toBe(1))

    const deleteButton = screen.getAllByRole('button', {
      name: 'Delete Uber',
    })[0]
    await user.click(deleteButton)

    await waitFor(() =>
      expect(screen.queryByText('Uber')).not.toBeInTheDocument(),
    )

    // Clear the search: the full list returns with 18 rows (one fewer).
    await user.clear(search)
    await waitFor(() => expect(shownCount()).toBe(18))
    expect(within(document.body).queryByText('Uber')).not.toBeInTheDocument()
  })
})
