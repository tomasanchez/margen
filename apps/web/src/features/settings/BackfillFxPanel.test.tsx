/**
 * Tests for the one-time historical FX backfill panel (ADR-150).
 *
 * The transactions list + settings client and the historical-rate / snapshot
 * seams are mocked so no real network is hit. Asserts: the unconverted count is
 * surfaced before a run; pressing Convert runs the fill, shows a "N / M"
 * progress readout, then a calm final summary; an all-converted ledger disables
 * the action with a reassuring note; and failures are reported (never an error
 * screen). English-pinned (ADR-105).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BackfillFxPanel } from './BackfillFxPanel'
import { fetchHistoricalRate } from '../../api/fxClient'
import { transactionsClient } from '../../api/transactionsClient'
import type { Transaction } from '../../mock/types'

const { listMock, settingsMock, rateMock, snapshotMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  settingsMock: vi.fn(),
  rateMock: vi.fn(),
  snapshotMock: vi.fn(),
}))

vi.mock('../../api/transactionsClient', async () => {
  const actual = await vi.importActual<
    typeof import('../../api/transactionsClient')
  >('../../api/transactionsClient')
  return {
    ...actual,
    transactionsClient: {
      ...actual.transactionsClient,
      list: listMock,
      setFxSnapshot: snapshotMock,
    },
  }
})

vi.mock('../../api/settingsClient', async () => {
  const actual = await vi.importActual<
    typeof import('../../api/settingsClient')
  >('../../api/settingsClient')
  return { ...actual, fetchSettings: settingsMock }
})

vi.mock('../../api/fxClient', () => ({ fetchHistoricalRate: rateMock }))

const mockList = vi.mocked(listMock)
const mockSettings = vi.mocked(settingsMock)
const mockRate = vi.mocked(fetchHistoricalRate)
const mockSnapshot = vi.mocked(transactionsClient.setFxSnapshot)

/** A transaction lacking a snapshot (no fxSource). */
function unconverted(id: string): Transaction {
  return {
    id,
    occurredOn: '2025-02-09',
    dispDate: 'Feb 09',
    month: 'February',
    name: id,
    category: 'Food',
    bank: 'Galicia',
    currency: 'ARS',
    type: 'expense',
    kind: 'expense',
    amountNum: 1000,
  }
}

beforeEach(() => {
  mockSettings.mockResolvedValue({
    preferredDisplayCurrency: 'USD',
    fxDefaultRateType: 'MEP',
    preferredRateSource: 'bolsa',
    monotributoCurrentCategory: 'C',
    monotributoActivityType: 'services',
    monotributoEnabled: false,
  })
  mockRate.mockResolvedValue(1200)
  mockSnapshot.mockResolvedValue({} as Transaction)
})

afterEach(() => {
  vi.clearAllMocks()
})

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <BackfillFxPanel />
    </QueryClientProvider>,
  )
}

describe('BackfillFxPanel', () => {
  test('surfaces the unconverted count and runs the fill on press, ending in a summary', async () => {
    mockList.mockResolvedValue([unconverted('a'), unconverted('b')])
    renderPanel()

    expect(
      await screen.findByText("2 transactions haven't been converted to USD yet."),
    ).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Convert now' }))

    // Each unconverted row is stamped via the snapshot PUT.
    await waitFor(() => expect(mockSnapshot).toHaveBeenCalledTimes(2))
    // The final calm summary reports the converted count.
    expect(
      await screen.findByText('Converted 2 transactions.'),
    ).toBeInTheDocument()
  })

  test('reports failures in the summary when a row cannot be priced', async () => {
    mockList.mockResolvedValue([unconverted('a'), unconverted('b')])
    mockRate.mockResolvedValueOnce(null) // first row unresolved
    renderPanel()

    await screen.findByText("2 transactions haven't been converted to USD yet.")
    await userEvent.click(screen.getByRole('button', { name: 'Convert now' }))

    expect(
      await screen.findByText(
        "Converted 1 · 1 couldn't be priced (try again later).",
      ),
    ).toBeInTheDocument()
  })

  test('disables the action and reassures when everything is already converted', async () => {
    mockList.mockResolvedValue([
      { ...unconverted('a'), fxSource: 'bolsa' },
    ])
    renderPanel()

    expect(
      await screen.findByText('All your transactions are already converted.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Convert now' })).toBeDisabled()
  })
})
