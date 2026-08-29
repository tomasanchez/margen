/**
 * Unit tests for the "Money owed to me" (receivables) section on the Accounts
 * page (ADR-204/206/208, ADR-127/172).
 *
 * Drives the section against a MOCKED {@link receivablesClient} (the network
 * boundary) so the real TanStack Query hooks + the full CRUD / payment flows run
 * end to end:
 *
 *  - people are listed with their outstanding total (es-AR formatted); a NEGATIVE
 *    outstanding (overpaid, ADR-206) renders red + signed;
 *  - create / rename / delete a person (delete goes through a cascade confirm);
 *  - expanding a person loads + lists their items (amount + remaining, a negative
 *    remainder rendered red + signed);
 *  - add / edit / delete an item;
 *  - record a payment allocated across open items, INCLUDING the overpayment
 *    confirm-warning that retries with `allowOverpayment: true` (ADR-206);
 *  - an empty state and a calm error state (ADR-037) render.
 *
 * English-pinned (ADR-105); money asserted via the shared es-AR formatter so the
 * exact grouping / Unicode-minus never has to be hand-typed.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ColorModeProvider } from '../../theme/colorMode'
import { ReceivablesSection } from './ReceivablesSection'
import {
  ReceivableOverpaymentError,
  receivablesClient,
  type Person,
  type PersonDetail,
} from '../../api/receivablesClient'
import { formatSignedBalance } from '../../lib/format'

vi.mock('../../api/receivablesClient', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/receivablesClient')>()
  return {
    ...actual,
    receivablesClient: {
      listPeople: vi.fn(),
      getPerson: vi.fn(),
      createPerson: vi.fn(),
      renamePerson: vi.fn(),
      deletePerson: vi.fn(),
      addItem: vi.fn(),
      editItem: vi.fn(),
      deleteItem: vi.fn(),
      pardonItem: vi.fn(),
      unpardonItem: vi.fn(),
      recordPayment: vi.fn(),
      matchSuggestions: vi.fn(),
      confirmMatch: vi.fn(),
      downloadPersonPdf: vi.fn(),
    },
  }
})

const mockListPeople = vi.mocked(receivablesClient.listPeople)
const mockGetPerson = vi.mocked(receivablesClient.getPerson)
const mockCreatePerson = vi.mocked(receivablesClient.createPerson)
const mockRenamePerson = vi.mocked(receivablesClient.renamePerson)
const mockDeletePerson = vi.mocked(receivablesClient.deletePerson)
const mockAddItem = vi.mocked(receivablesClient.addItem)
const mockEditItem = vi.mocked(receivablesClient.editItem)
const mockDeleteItem = vi.mocked(receivablesClient.deleteItem)
const mockPardonItem = vi.mocked(receivablesClient.pardonItem)
const mockUnpardonItem = vi.mocked(receivablesClient.unpardonItem)
const mockRecordPayment = vi.mocked(receivablesClient.recordPayment)
const mockMatchSuggestions = vi.mocked(receivablesClient.matchSuggestions)

const PEOPLE: Person[] = [
  { id: 'p1', name: 'Ana', outstanding: '500000.00' },
  // Overpaid → negative outstanding (ADR-206), rendered red + signed.
  { id: 'p2', name: 'Bruno', outstanding: '-1500.00' },
]

const ANA_DETAIL: PersonDetail = {
  id: 'p1',
  name: 'Ana',
  outstanding: '500000.00',
  items: [
    {
      id: 'i1',
      occurredOn: '2026-08-01',
      amount: '300000.00',
      detail: 'Dinner',
      allocated: '0.00',
      remaining: '300000.00',
      pardoned: false,
    },
    {
      id: 'i2',
      occurredOn: '2026-08-10',
      amount: '200000.00',
      detail: null,
      allocated: '0.00',
      remaining: '200000.00',
      pardoned: false,
    },
  ],
}

// Ana with her first item (Dinner) FORGIVEN (ADR-210): it no longer counts
// toward outstanding, so only the second item's 200.000 remains.
const ANA_PARDONED: PersonDetail = {
  ...ANA_DETAIL,
  outstanding: '200000.00',
  items: [
    { ...ANA_DETAIL.items[0], pardoned: true },
    ANA_DETAIL.items[1],
  ],
}

const BRUNO_DETAIL: PersonDetail = {
  id: 'p2',
  name: 'Bruno',
  outstanding: '-1500.00',
  items: [
    {
      id: 'b1',
      occurredOn: '2026-07-15',
      amount: '1000.00',
      detail: 'Coffee',
      allocated: '2500.00',
      // Overpaid item → negative remainder.
      remaining: '-1500.00',
      pardoned: false,
    },
  ],
}

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ColorModeProvider>
        <ReceivablesSection />
      </ColorModeProvider>
    </QueryClientProvider>,
  )
  return utils
}

describe('ReceivablesSection', () => {
  beforeEach(() => {
    mockListPeople.mockResolvedValue(PEOPLE)
    mockGetPerson.mockImplementation((id: string) =>
      Promise.resolve(id === 'p2' ? BRUNO_DETAIL : ANA_DETAIL),
    )
    mockCreatePerson.mockResolvedValue({ ...ANA_DETAIL, id: 'p3', name: 'Carla' })
    mockRenamePerson.mockResolvedValue({ ...ANA_DETAIL, name: 'Ana María' })
    mockDeletePerson.mockResolvedValue(undefined)
    mockAddItem.mockResolvedValue(ANA_DETAIL.items[0])
    mockEditItem.mockResolvedValue(ANA_DETAIL.items[0])
    mockDeleteItem.mockResolvedValue(undefined)
    mockPardonItem.mockResolvedValue(ANA_PARDONED)
    mockUnpardonItem.mockResolvedValue(ANA_DETAIL)
    mockRecordPayment.mockResolvedValue({
      id: 'pay1',
      occurredOn: '2026-08-24',
      amount: '100000.00',
      source: 'manual',
      matchedIncomeTransactionId: null,
      allocations: [{ itemId: 'i1', amount: '100000.00' }],
    })
    // Task 9's match-suggestions query mounts when a person expands; default to
    // none so these CRUD/payment tests aren't perturbed (React Query rejects an
    // `undefined` return, so an unmocked resolve would error the query).
    mockMatchSuggestions.mockResolvedValue([])
  })
  afterEach(() => vi.clearAllMocks())

  test('lists people with their outstanding total, negatives red + signed', async () => {
    renderSection()
    expect(await screen.findByText('Ana')).toBeInTheDocument()
    // Positive outstanding, es-AR grouped, no sign.
    expect(screen.getByText('ARS 500.000')).toBeInTheDocument()
    // Bruno is overpaid → negative outstanding, signed with the Unicode minus.
    expect(
      screen.getByText(formatSignedBalance(-1500, 'ARS')),
    ).toBeInTheDocument()
  })

  test('shows the empty state when no one owes the owner', async () => {
    mockListPeople.mockResolvedValue([])
    renderSection()
    expect(await screen.findByText(/No one owes you yet/)).toBeInTheDocument()
  })

  test('shows a calm error state when the people list fails', async () => {
    mockListPeople.mockRejectedValue(new Error('boom'))
    renderSection()
    expect(
      await screen.findByText("Can't load money owed to you"),
    ).toBeInTheDocument()
  })

  test('creating a person POSTs the trimmed name', async () => {
    const user = userEvent.setup()
    renderSection()
    await screen.findByText('Ana')

    await user.click(screen.getByRole('button', { name: 'Add person' }))
    const dialog = within(await screen.findByRole('dialog'))
    await user.type(dialog.getByRole('textbox', { name: /Name/ }), 'Carla')
    await user.click(dialog.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockCreatePerson).toHaveBeenCalledWith('Carla'))
  })

  test('renaming a person PATCHes the new name', async () => {
    const user = userEvent.setup()
    renderSection()
    await screen.findByText('Ana')

    await user.click(screen.getByRole('button', { name: 'Rename Ana' }))
    const dialog = within(await screen.findByRole('dialog'))
    const name = dialog.getByRole('textbox', { name: /Name/ })
    expect(name).toHaveValue('Ana')
    await user.clear(name)
    await user.type(name, 'Ana María')
    await user.click(dialog.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(mockRenamePerson).toHaveBeenCalledWith('p1', 'Ana María'),
    )
  })

  test('deleting a person confirms the cascade then calls delete', async () => {
    const user = userEvent.setup()
    renderSection()
    await screen.findByText('Ana')

    await user.click(screen.getByRole('button', { name: 'Delete Ana' }))
    const dialog = within(await screen.findByRole('dialog'))
    // Copy notes the cascade (items + payments removed too).
    expect(dialog.getByText(/items and payments will be removed/i)).toBeInTheDocument()

    await user.click(dialog.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(mockDeletePerson).toHaveBeenCalledWith('p1'))
  })

  test('cancelling the delete-person confirm does nothing', async () => {
    const user = userEvent.setup()
    renderSection()
    await screen.findByText('Ana')

    await user.click(screen.getByRole('button', { name: 'Delete Ana' }))
    const dialog = within(await screen.findByRole('dialog'))
    await user.click(dialog.getByRole('button', { name: 'Cancel' }))

    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    )
    // No delete fired, and Ana is still listed.
    expect(mockDeletePerson).not.toHaveBeenCalled()
    expect(screen.getByText('Ana')).toBeInTheDocument()
  })

  test('expanding a person lists their items with amount + remaining', async () => {
    const user = userEvent.setup()
    renderSection()
    await screen.findByText('Ana')

    await user.click(screen.getByRole('button', { name: "Show Ana's items" }))
    // Items load from getPerson('p1').
    expect(await screen.findByText('Dinner')).toBeInTheDocument()
    await waitFor(() => expect(mockGetPerson).toHaveBeenCalledWith('p1'))
    // Remaining shown per item (positive here), es-AR grouped.
    expect(
      screen.getByText(`${formatSignedBalance(300000, 'ARS')} remaining`),
    ).toBeInTheDocument()
  })

  test('a negative item remainder (overpaid) renders red + signed', async () => {
    const user = userEvent.setup()
    renderSection()
    await screen.findByText('Bruno')

    await user.click(screen.getByRole('button', { name: "Show Bruno's items" }))
    expect(await screen.findByText('Coffee')).toBeInTheDocument()
    // The overpaid item's remainder is negative → signed with the Unicode minus.
    const remaining = screen.getByText(
      `${formatSignedBalance(-1500, 'ARS')} remaining`,
    )
    expect(remaining).toBeInTheDocument()
    // Non-color cue is the SIGN; assert the Unicode minus is present.
    expect(remaining.textContent).toContain('−')
  })

  test('adding an item POSTs it for the expanded person', async () => {
    const user = userEvent.setup()
    renderSection()
    await screen.findByText('Ana')
    await user.click(screen.getByRole('button', { name: "Show Ana's items" }))
    await screen.findByText('Dinner')

    await user.click(screen.getByRole('button', { name: 'Add item' }))
    const dialog = within(await screen.findByRole('dialog'))
    await user.type(dialog.getByLabelText(/Amount/), '75000')
    await user.click(dialog.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockAddItem).toHaveBeenCalledTimes(1))
    expect(mockAddItem).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ amount: '75000.00' }),
    )
  })

  test('editing an item PATCHes the change', async () => {
    const user = userEvent.setup()
    renderSection()
    await screen.findByText('Ana')
    await user.click(screen.getByRole('button', { name: "Show Ana's items" }))
    await screen.findByText('Dinner')

    await user.click(
      screen.getByRole('button', { name: 'Edit item from 2026-08-01' }),
    )
    const dialog = within(await screen.findByRole('dialog'))
    const amount = dialog.getByLabelText(/Amount/)
    expect(amount).toHaveValue('300000.00')
    await user.clear(amount)
    await user.type(amount, '250000')
    await user.click(dialog.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockEditItem).toHaveBeenCalledTimes(1))
    expect(mockEditItem).toHaveBeenCalledWith(
      'p1',
      'i1',
      expect.objectContaining({ amount: '250000.00' }),
    )
  })

  test('deleting an item confirms then calls delete', async () => {
    const user = userEvent.setup()
    renderSection()
    await screen.findByText('Ana')
    await user.click(screen.getByRole('button', { name: "Show Ana's items" }))
    await screen.findByText('Dinner')

    await user.click(
      screen.getByRole('button', { name: 'Delete item from 2026-08-01' }),
    )
    const dialog = within(await screen.findByRole('dialog'))
    await user.click(dialog.getByRole('button', { name: 'Delete' }))

    await waitFor(() =>
      expect(mockDeleteItem).toHaveBeenCalledWith('p1', 'i1'),
    )
  })

  test('pardoning an item confirms, calls pardon, then shows the Covered badge + Un-pardon action', async () => {
    const user = userEvent.setup()
    // First load: nothing pardoned. After the pardon the refetch returns the
    // item flagged covered (invalidation-driven, task 7).
    mockGetPerson.mockResolvedValueOnce(ANA_DETAIL).mockResolvedValue(ANA_PARDONED)

    renderSection()
    await screen.findByText('Ana')
    await user.click(screen.getByRole('button', { name: "Show Ana's items" }))
    await screen.findByText('Dinner')

    // Forgive the first item — a confirm distinct from delete (ADR-210).
    await user.click(
      screen.getByRole('button', { name: 'Forgive the item from 2026-08-01' }),
    )
    const dialog = within(await screen.findByRole('dialog'))
    // The confirm copy explains it shows as covered on the PDF (not deleted).
    expect(dialog.getByText(/covered by you/i)).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Forgive' }))

    await waitFor(() =>
      expect(mockPardonItem).toHaveBeenCalledWith('p1', 'i1'),
    )
    // Delete was never touched — pardon is a separate path.
    expect(mockDeleteItem).not.toHaveBeenCalled()

    // The refreshed row reads visibly distinct: the action swaps to Un-pardon
    // (findByRole waits for the confirm to close so the row is accessible again).
    expect(
      await screen.findByRole('button', {
        name: 'Restore the item from 2026-08-01 as owed',
      }),
    ).toBeInTheDocument()
    // …and the covered badge is shown; the pardon affordance for it is gone.
    expect(screen.getByText('Covered')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Forgive the item from 2026-08-01' }),
    ).not.toBeInTheDocument()
  })

  test('un-pardoning restores the item as owed directly (no confirm)', async () => {
    const user = userEvent.setup()
    // Ana loads with her first item already forgiven.
    mockGetPerson.mockResolvedValue(ANA_PARDONED)

    renderSection()
    await screen.findByText('Ana')
    await user.click(screen.getByRole('button', { name: "Show Ana's items" }))
    await screen.findByText('Dinner')
    // The covered badge is present up front.
    expect(screen.getByText('Covered')).toBeInTheDocument()

    await user.click(
      screen.getByRole('button', {
        name: 'Restore the item from 2026-08-01 as owed',
      }),
    )

    // Restore is non-destructive → it fires immediately, no confirm dialog.
    await waitFor(() =>
      expect(mockUnpardonItem).toHaveBeenCalledWith('p1', 'i1'),
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(mockDeleteItem).not.toHaveBeenCalled()
  })

  test('a pardoned item is excluded from the payment allocation list', async () => {
    const user = userEvent.setup()
    // i1 (2026-08-01) is forgiven; only i2 (2026-08-10) remains allocatable.
    mockGetPerson.mockResolvedValue(ANA_PARDONED)

    renderSection()
    await screen.findByText('Ana')
    await user.click(screen.getByRole('button', { name: "Show Ana's items" }))
    await screen.findByText('Dinner')

    await user.click(screen.getByRole('button', { name: 'Record payment' }))
    const dialog = within(await screen.findByRole('dialog'))

    // The open item is allocatable…
    expect(
      await dialog.findByLabelText(
        'Amount applied to the item from 2026-08-10',
      ),
    ).toBeInTheDocument()
    // …but the forgiven item is NOT a payment target (ADR-210).
    expect(
      dialog.queryByLabelText('Amount applied to the item from 2026-08-01'),
    ).not.toBeInTheDocument()
  })

  test('recording a payment allocates across open items', async () => {
    const user = userEvent.setup()
    renderSection()
    await screen.findByText('Ana')
    await user.click(screen.getByRole('button', { name: "Show Ana's items" }))
    await screen.findByText('Dinner')

    await user.click(screen.getByRole('button', { name: 'Record payment' }))
    const dialog = within(await screen.findByRole('dialog'))
    await user.type(
      await dialog.findByLabelText(/Amount applied to the item from 2026-08-01/),
      '100000',
    )
    await user.click(dialog.getByRole('button', { name: 'Record payment' }))

    await waitFor(() => expect(mockRecordPayment).toHaveBeenCalledTimes(1))
    expect(mockRecordPayment).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        amount: '100000.00',
        allocations: [{ itemId: 'i1', amount: '100000.00' }],
      }),
    )
    // No overpayment → the first call carries no allowOverpayment flag.
    expect(mockRecordPayment.mock.calls[0][1].allowOverpayment).toBeUndefined()
  })

  test('overpayment warns, then retries with allowOverpayment on confirm', async () => {
    const user = userEvent.setup()
    // First attempt 409s; the retry (allowOverpayment) succeeds.
    mockRecordPayment
      .mockRejectedValueOnce(
        new ReceivableOverpaymentError('300000.00', '600000.00'),
      )
      .mockResolvedValueOnce({
        id: 'pay2',
        occurredOn: '2026-08-24',
        amount: '600000.00',
        source: 'manual',
        matchedIncomeTransactionId: null,
        allocations: [{ itemId: 'i1', amount: '600000.00' }],
      })

    renderSection()
    await screen.findByText('Ana')
    await user.click(screen.getByRole('button', { name: "Show Ana's items" }))
    await screen.findByText('Dinner')

    await user.click(screen.getByRole('button', { name: 'Record payment' }))
    const dialog = within(await screen.findByRole('dialog'))
    await user.type(
      await dialog.findByLabelText(/Amount applied to the item from 2026-08-01/),
      '600000',
    )
    await user.click(dialog.getByRole('button', { name: 'Record payment' }))

    // The confirm-warning surfaces the overpayment (ADR-206).
    expect(await dialog.findByText('More than owed')).toBeInTheDocument()
    await waitFor(() => expect(mockRecordPayment).toHaveBeenCalledTimes(1))

    await user.click(dialog.getByRole('button', { name: 'Record anyway' }))

    await waitFor(() => expect(mockRecordPayment).toHaveBeenCalledTimes(2))
    // The retry passes the explicit override.
    expect(mockRecordPayment.mock.calls[1][1]).toEqual(
      expect.objectContaining({ allowOverpayment: true }),
    )
  })
})
