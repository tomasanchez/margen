/**
 * Unit tests for the Debts section on the Accounts page (ADR-187, ADR-127/172).
 *
 * Drives the section against a MOCKED {@link debtsClient} (the network boundary),
 * so the real TanStack Query hooks + the add/edit/delete flows run end to end:
 *
 *  - debts are listed with name + current balance + optional min/rate meta;
 *  - "Add debt" opens the form and POSTs name/currency/currentBalance (+ optionals);
 *  - editing a debt opens the seeded form and PATCHes an update;
 *  - deleting a debt goes through a calm confirm and calls remove;
 *  - every write invalidates BOTH the debts list AND the accounts/net-worth key
 *    family (the "other debts" leg depends on debts, ADR-187);
 *  - an empty state and a calm error state (ADR-037) render.
 *
 * English-pinned (ADR-105); money asserted via the shared es-AR formatter.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ColorModeProvider } from '../../theme/colorMode'
import { DebtsSection } from './DebtsSection'
import { debtsClient, type Debt } from '../../api/debtsClient'

vi.mock('../../api/debtsClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/debtsClient')>()
  return {
    ...actual,
    debtsClient: {
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    },
  }
})

const mockList = vi.mocked(debtsClient.list)
const mockCreate = vi.mocked(debtsClient.create)
const mockUpdate = vi.mocked(debtsClient.update)
const mockRemove = vi.mocked(debtsClient.remove)

const DEBTS: Debt[] = [
  {
    id: 'd1',
    name: 'Banco Nación loan',
    currency: 'ARS',
    currentBalance: '500000.00',
    monthlyMinimum: '25000.00',
    rate: '85.5',
  },
  {
    id: 'd2',
    name: 'Family loan',
    currency: 'USD',
    currentBalance: '1200.00',
    monthlyMinimum: null,
    rate: null,
  },
]

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ColorModeProvider>
        <DebtsSection />
      </ColorModeProvider>
    </QueryClientProvider>,
  )
  return { ...utils, invalidateSpy }
}

describe('DebtsSection', () => {
  beforeEach(() => {
    mockList.mockResolvedValue(DEBTS)
    mockCreate.mockResolvedValue(DEBTS[0])
    mockUpdate.mockResolvedValue(DEBTS[0])
    mockRemove.mockResolvedValue(undefined)
  })
  afterEach(() => vi.clearAllMocks())

  test('lists debts with name, balance, and the optional min/rate meta', async () => {
    renderSection()
    expect(await screen.findByText('Banco Nación loan')).toBeInTheDocument()
    expect(screen.getByText('ARS 500.000')).toBeInTheDocument()
    // Monthly minimum + rate meta shown only when set.
    expect(screen.getByText(/Min\. ARS 25\.000 \/ month/)).toBeInTheDocument()
    expect(screen.getByText(/85\.5% rate/)).toBeInTheDocument()
    // The USD debt (no optionals) shows a USD balance and no meta line.
    expect(screen.getByText('USD 1.200')).toBeInTheDocument()
  })

  test('shows the empty state when there are no debts', async () => {
    mockList.mockResolvedValue([])
    renderSection()
    expect(await screen.findByText(/No debts yet/)).toBeInTheDocument()
  })

  test('shows a calm error state when the list fails', async () => {
    mockList.mockRejectedValue(new Error('boom'))
    renderSection()
    expect(await screen.findByText("Can't load your debts")).toBeInTheDocument()
  })

  test('Add debt POSTs the body and invalidates debts + net worth', async () => {
    const user = userEvent.setup()
    const { invalidateSpy } = renderSection()
    await screen.findByText('Banco Nación loan')

    await user.click(screen.getByRole('button', { name: 'Add debt' }))
    const dialog = within(await screen.findByRole('dialog'))
    await user.type(dialog.getByRole('textbox', { name: /Name/ }), 'New loan')
    await user.type(
      dialog.getByRole('textbox', { name: /Current balance/ }),
      '300000',
    )
    await user.click(dialog.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'New loan',
        currency: 'ARS',
        currentBalance: '300000.00',
      }),
    )
    const invalidatedKeys = invalidateSpy.mock.calls.map(
      (call) => (call[0] as { queryKey: unknown[] }).queryKey[0],
    )
    expect(invalidatedKeys).toContain('debts')
    expect(invalidatedKeys).toContain('accounts')
  })

  test('blocks save until name + a non-negative balance are valid', async () => {
    const user = userEvent.setup()
    renderSection()
    await screen.findByText('Banco Nación loan')

    await user.click(screen.getByRole('button', { name: 'Add debt' }))
    const dialog = within(await screen.findByRole('dialog'))
    const save = dialog.getByRole('button', { name: 'Save' })
    // No name yet → disabled.
    expect(save).toBeDisabled()
    await user.type(dialog.getByRole('textbox', { name: /Name/ }), 'Loan')
    // A negative balance is rejected client-side (mirrors the backend, ADR-187).
    await user.type(
      dialog.getByRole('textbox', { name: /Current balance/ }),
      '-5',
    )
    expect(save).toBeDisabled()
  })

  test('editing a debt PATCHes an update and invalidates net worth', async () => {
    const user = userEvent.setup()
    const { invalidateSpy } = renderSection()
    await screen.findByText('Banco Nación loan')

    await user.click(screen.getByRole('button', { name: 'Edit Banco Nación loan' }))
    const dialog = within(await screen.findByRole('dialog'))
    // Seeded with the debt's current balance.
    const balance = dialog.getByRole('textbox', { name: /Current balance/ })
    expect(balance).toHaveValue('500000.00')
    await user.clear(balance)
    await user.type(balance, '450000')
    await user.click(dialog.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1))
    expect(mockUpdate).toHaveBeenCalledWith(
      'd1',
      expect.objectContaining({ currentBalance: '450000.00' }),
    )
    const invalidatedKeys = invalidateSpy.mock.calls.map(
      (call) => (call[0] as { queryKey: unknown[] }).queryKey[0],
    )
    expect(invalidatedKeys).toContain('accounts')
  })

  test('deleting a debt confirms then calls remove + invalidates net worth', async () => {
    const user = userEvent.setup()
    const { invalidateSpy } = renderSection()
    await screen.findByText('Banco Nación loan')

    await user.click(
      screen.getByRole('button', { name: 'Delete Banco Nación loan' }),
    )
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText(/removed from your net worth/i)).toBeInTheDocument()

    await user.click(dialog.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith('d1'))
    const invalidatedKeys = invalidateSpy.mock.calls.map(
      (call) => (call[0] as { queryKey: unknown[] }).queryKey[0],
    )
    expect(invalidatedKeys).toContain('debts')
    expect(invalidatedKeys).toContain('accounts')
  })
})
