/**
 * Interaction tests for the Transactions screen (ADR-018, ADR-038).
 *
 * These render the real TransactionsPage against a MOCKED transactions client
 * (no real backend, ADR-038) returning the adapted {@link Transaction} shape, and
 * exercise the AC-critical behaviors through the UI: search/filter narrows BOTH
 * the visible rows and the header totals, the no-results empty state shows,
 * deleting a row removes it, and a query error renders the calm ErrorState with a
 * working Retry (ADR-037). The pure filter math is covered by filtering.test.ts —
 * here we assert the wiring (query -> filter -> totals/rows -> mutation) holds.
 *
 * jsdom renders both the desktop and mobile surfaces, so role/label lookups can
 * match twice; tests use getAllBy / within where that matters.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '../../test/renderWithProviders'
import type { Transaction } from '../../mock/types'
import { TRANSACTIONS_FIXTURE } from './__fixtures__/transactions'
import { TransactionsPage } from './TransactionsPage'

// Mock the HTTP-backed client so no real backend is required (ADR-038). The
// query hooks call through this module; the mutations mutate the in-test store.
const { listMock, removeMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  removeMock: vi.fn(),
}))

vi.mock('../../api/transactionsClient', () => ({
  transactionsClient: {
    list: listMock,
    create: vi.fn(),
    update: vi.fn(),
    remove: removeMock,
  },
}))

let store: Transaction[] = []

beforeEach(() => {
  store = TRANSACTIONS_FIXTURE.map((t) => ({ ...t }))
  listMock.mockImplementation(() => Promise.resolve(store.map((t) => ({ ...t }))))
  removeMock.mockImplementation((id: string) => {
    store = store.filter((t) => t.id !== id)
    return Promise.resolve()
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

/** Wait for the list to resolve (a known fixture row appears). */
async function waitForRows() {
  return screen.findAllByText('Coto supermarket')
}

/**
 * Switch the page's month picker to "All time" so the full multi-month fixture
 * is in view. The page defaults its month to the CURRENT month (ADR-040), so
 * tests that assert across all months widen the scope first; this keeps them
 * date-independent regardless of the run date.
 */
async function selectAllTime(user: ReturnType<typeof userEvent.setup>) {
  const trigger = screen.getAllByRole('button', { name: /^Month:/ })[0]
  await user.click(trigger)
  await user.click(await screen.findByRole('menuitem', { name: /All time/ }))
}

/** Read the "<n> shown" count out of the header summary line. */
function shownCount(): number {
  const node = screen.getByText('shown', { exact: false })
  const text = node.closest('p')?.textContent ?? ''
  const match = text.match(/(\d+)\s*shown/)
  return match ? Number(match[1]) : Number.NaN
}

describe('TransactionsPage filtering', () => {
  // The search box debounces its push to the URL (~300ms, ADR-116), so the
  // search-driven assertions wait a touch longer and the test gets extra
  // headroom over the default 5s — under heavy parallel load the debounce can
  // otherwise tip an already-slow test over the edge.
  test('a search query narrows the rows AND updates the header count', async () => {
    const user = userEvent.setup()
    renderWithProviders(<TransactionsPage />, { withAddProvider: true })

    await waitForRows()
    await selectAllTime(user)
    expect(shownCount()).toBe(19)

    const search = screen.getAllByRole('searchbox')[0]
    await user.type(search, 'Apartment')

    await waitFor(() => expect(shownCount()).toBe(3), { timeout: 2000 })

    expect(screen.getAllByText('Apartment rent').length).toBeGreaterThan(0)
    expect(screen.queryByText('Coto supermarket')).not.toBeInTheDocument()
  }, 10000)

  test('a type filter narrows rows and recomputes the totals', async () => {
    const user = userEvent.setup()
    renderWithProviders(<TransactionsPage />, { withAddProvider: true })

    await waitForRows()
    await selectAllTime(user)
    expect(shownCount()).toBe(19)

    const invoiceToggle = screen.getAllByRole('button', { name: 'Invoices' })[0]
    await user.click(invoiceToggle)

    await waitFor(() => expect(shownCount()).toBe(4))

    expect(screen.queryByText('Coto supermarket')).not.toBeInTheDocument()
    expect(
      screen.getAllByText('Invoice · Beta Studio').length,
    ).toBeGreaterThan(0)

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
      await screen.findByText('No transactions match these filters.', undefined, {
        timeout: 2000,
      }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Coto supermarket')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /clearing your filters/ }),
    ).toBeInTheDocument()
  }, 10000)
})

describe('TransactionsPage delete', () => {
  test('deleting a row removes it and decrements the shown count', async () => {
    const user = userEvent.setup()
    renderWithProviders(<TransactionsPage />, { withAddProvider: true })

    await waitForRows()
    await selectAllTime(user)
    expect(shownCount()).toBe(19)

    const search = screen.getAllByRole('searchbox')[0]
    await user.type(search, 'Farmacity')
    // The search push is debounced (~300ms, ADR-116) before the list narrows.
    await waitFor(() => expect(shownCount()).toBe(1), { timeout: 2000 })

    const deleteButton = screen.getAllByRole('button', {
      name: 'Delete Farmacity',
    })[0]
    await user.click(deleteButton)

    await waitFor(() =>
      expect(screen.queryByText('Farmacity')).not.toBeInTheDocument(),
    )
    expect(removeMock).toHaveBeenCalledTimes(1)
    expect(
      screen.getByText('No transactions match these filters.'),
    ).toBeInTheDocument()
  }, 10000)
})

describe('TransactionsPage error state', () => {
  test('a list error renders the calm panel and Retry refetches', async () => {
    const user = userEvent.setup()
    // First load fails; the Retry refetch succeeds with the fixture rows.
    listMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockImplementation(() => Promise.resolve(store.map((t) => ({ ...t }))))

    renderWithProviders(<TransactionsPage />, { withAddProvider: true })

    expect(
      await screen.findByText("Can't reach the server"),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Retry' }))

    // After refetch the list renders and the calm panel is gone.
    await waitForRows()
    expect(
      screen.queryByText("Can't reach the server"),
    ).not.toBeInTheDocument()
    expect(listMock).toHaveBeenCalledTimes(2)
  })
})
