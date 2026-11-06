/**
 * Unit tests for the manual payment form with installment items
 * (ADR-206/215/221, ADR-037).
 *
 * Driven against a MOCKED {@link receivablesClient}:
 *
 *  - typing the amount received PREFILLS the rows from the server's suggested
 *    allocation (debounced), and the payment sends each cuota's `installmentId`
 *    (flat items send none);
 *  - the recorded payment is exactly the amount received: saving is held while
 *    the rows don't add up to it, with explicit ways to balance — apply the rest
 *    to upcoming cuotas, put the rest on a chosen debt, or set the received
 *    amount to the lines' total;
 *  - paying cuotas early reads as an EARLY payment in the 409 confirm; paying one
 *    debt beyond what it owes names that debt and its remainder; "Record anyway"
 *    retries with `allowOverpayment: true`.
 *
 * English-pinned (ADR-105).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ColorModeProvider } from '../../theme/colorMode'
import {
  AllocationExceedsTargetError,
  ReceivableOverpaymentError,
  receivablesClient,
  type SuggestedAllocation,
  type SuggestedAllocationLine,
} from '../../api/receivablesClient'
import { RecordPaymentForm } from './RecordPaymentForm'
import { makeCuota, makeDetail, makeItem } from './__fixtures__/receivables'

vi.mock('../../api/receivablesClient', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/receivablesClient')>()
  return {
    ...actual,
    receivablesClient: {
      getPerson: vi.fn(),
      suggestedAllocation: vi.fn(),
      recordPayment: vi.fn(),
    },
  }
})

const mockGetPerson = vi.mocked(receivablesClient.getPerson)
const mockSuggested = vi.mocked(receivablesClient.suggestedAllocation)
const mockRecordPayment = vi.mocked(receivablesClient.recordPayment)

/** Ana: a 3-cuota plan (cuota 1 due, 2-3 upcoming) and a flat 50.000 item. */
const DETAIL = makeDetail({
  id: 'p1',
  name: 'Ana',
  outstanding: '150000.00',
  upcomingTotal: '200000.00',
  items: [
    makeItem({
      id: 'flat',
      occurredOn: '2026-08-10',
      amount: '50000.00',
      detail: 'Concert tickets',
    }),
    makeItem({
      id: 'plan',
      occurredOn: '2026-07-20',
      amount: '300000.00',
      detail: 'Flights',
      dueOutstanding: '100000.00',
      upcomingTotal: '200000.00',
      installments: [
        makeCuota({ id: 'c1', index: 1, dueOn: '2026-08-20', amount: '100000.00', status: 'due' }),
        makeCuota({ id: 'c2', index: 2, dueOn: '2026-09-20', amount: '100000.00', status: 'upcoming' }),
        makeCuota({ id: 'c3', index: 3, dueOn: '2026-10-20', amount: '100000.00', status: 'upcoming' }),
      ],
    }),
  ],
})

function suggestion(
  amount: string,
  lines: SuggestedAllocationLine[],
): SuggestedAllocation {
  const allocated = lines.reduce((sum, line) => sum + Number(line.amount), 0)
  return {
    asOf: '2026-08-25',
    amount,
    allocated: allocated.toFixed(2),
    unallocated: (Number(amount) - allocated).toFixed(2),
    allocations: lines,
  }
}

/** The server's capped suggestion: cuota 1 then the flat item (150.000 owed). */
const DUE_LINES: SuggestedAllocationLine[] = [
  { itemId: 'plan', installmentId: 'c1', amount: '100000.00' },
  { itemId: 'flat', installmentId: null, amount: '50000.00' },
]

function renderForm() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const onClose = vi.fn()
  render(
    <QueryClientProvider client={queryClient}>
      <ColorModeProvider>
        <RecordPaymentForm open personId="p1" personName="Ana" onClose={onClose} />
      </ColorModeProvider>
    </QueryClientProvider>,
  )
  return { onClose, dialog: within(screen.getByRole('dialog')) }
}

const CUOTA_1 = 'Amount applied to cuota 1/3 of the item from 2026-07-20'
const CUOTA_2 = 'Amount applied to cuota 2/3 of the item from 2026-07-20'
const FLAT = 'Amount applied to the item from 2026-08-10'

describe('RecordPaymentForm — installment items (ADR-221)', () => {
  beforeEach(() => {
    mockGetPerson.mockResolvedValue(DETAIL)
    mockRecordPayment.mockResolvedValue(DETAIL)
  })
  afterEach(() => vi.clearAllMocks())

  test('prefills from the suggested allocation and sends installmentId per cuota', async () => {
    mockSuggested.mockResolvedValue(
      suggestion('120000.00', [
        { itemId: 'plan', installmentId: 'c1', amount: '100000.00' },
        { itemId: 'flat', installmentId: null, amount: '20000.00' },
      ]),
    )
    const user = userEvent.setup()
    const { dialog, onClose } = renderForm()

    // Rows: the due cuota (labeled with its plan) and the flat item; upcoming
    // cuotas wait behind a toggle.
    expect(await dialog.findByText('Flights · Cuota 1/3')).toBeInTheDocument()
    expect(dialog.queryByLabelText(CUOTA_2)).not.toBeInTheDocument()
    expect(
      dialog.getByRole('button', { name: 'Show upcoming cuotas (2)' }),
    ).toBeInTheDocument()

    await user.type(dialog.getByLabelText(/Amount received/), '120000')

    // Debounced → one suggestion request for the settled amount → rows prefilled.
    await waitFor(() => expect(dialog.getByLabelText(CUOTA_1)).toHaveValue(100000))
    expect(dialog.getByLabelText(FLAT)).toHaveValue(20000)
    expect(mockSuggested).toHaveBeenCalledWith('p1', '120000.00')

    await user.click(dialog.getByRole('button', { name: 'Record payment' }))

    await waitFor(() => expect(mockRecordPayment).toHaveBeenCalledTimes(1))
    expect(mockRecordPayment).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        amount: '120000.00',
        allocations: [
          { itemId: 'plan', installmentId: 'c1', amount: '100000.00' },
          { itemId: 'flat', amount: '20000.00' },
        ],
      }),
    )
    expect(mockRecordPayment.mock.calls[0][1].allowOverpayment).toBeUndefined()
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  test('recording is held until the rows add up to the amount received', async () => {
    mockSuggested.mockResolvedValue(suggestion('150000.00', DUE_LINES))
    const user = userEvent.setup()
    const { dialog } = renderForm()

    await user.type(await dialog.findByLabelText(/Amount received/), '150000')
    await waitFor(() => expect(dialog.getByLabelText(FLAT)).toHaveValue(50000))
    const record = dialog.getByRole('button', { name: 'Record payment' })
    expect(record).toBeEnabled()

    // Lowering a row leaves part of the money unassigned → held, said in words.
    const flat = dialog.getByLabelText(FLAT)
    await user.clear(flat)
    await user.type(flat, '30000')
    expect(record).toBeDisabled()
    expect(
      dialog.getByText(
        "ARS 20.000 of the ARS 150.000 received isn't assigned to a debt yet. Assign it or change the amount received to record the payment.",
      ),
    ).toBeInTheDocument()

    // …or the owner says they actually received less: the rows stay as typed.
    await user.click(
      dialog.getByRole('button', { name: 'Set received to ARS 130.000' }),
    )
    expect(dialog.getByLabelText(/Amount received/)).toHaveValue(130000)
    expect(dialog.getByLabelText(FLAT)).toHaveValue(30000)
    await user.click(record)

    await waitFor(() => expect(mockRecordPayment).toHaveBeenCalledTimes(1))
    expect(mockRecordPayment).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        amount: '130000.00',
        allocations: [
          { itemId: 'plan', installmentId: 'c1', amount: '100000.00' },
          { itemId: 'flat', amount: '30000.00' },
        ],
      }),
    )
  })

  test('paying upcoming cuotas early reads as an early payment, then retries with allowOverpayment', async () => {
    // 250.000 received; only 150.000 is due, so the suggestion leaves 100.000.
    mockSuggested.mockResolvedValue(suggestion('250000.00', DUE_LINES))
    mockRecordPayment
      .mockRejectedValueOnce(
        new ReceivableOverpaymentError('150000.00', '250000.00'),
      )
      .mockResolvedValueOnce(DETAIL)
    const user = userEvent.setup()
    const { dialog } = renderForm()

    await user.type(await dialog.findByLabelText(/Amount received/), '250000')
    await waitFor(() => expect(dialog.getByLabelText(CUOTA_1)).toHaveValue(100000))
    expect(
      dialog.getByText(
        "ARS 100.000 of the ARS 250.000 received isn't assigned to a debt yet. Assign it or change the amount received to record the payment.",
      ),
    ).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: 'Record payment' })).toBeDisabled()

    // Pay the rest ahead: the earliest upcoming cuota takes it.
    await user.click(
      dialog.getByRole('button', { name: 'Apply the rest to upcoming cuotas' }),
    )
    expect(dialog.getByLabelText(CUOTA_2)).toHaveValue(100000)

    await user.click(dialog.getByRole('button', { name: 'Record payment' }))

    // The due-only outstanding (ADR-215) makes this a 409 — worded as early.
    expect(
      await dialog.findByText('Includes cuotas not yet due'),
    ).toBeInTheDocument()
    expect(
      dialog.getByText(/because it pays cuotas that aren't due yet/),
    ).toBeInTheDocument()

    await user.click(dialog.getByRole('button', { name: 'Record anyway' }))

    await waitFor(() => expect(mockRecordPayment).toHaveBeenCalledTimes(2))
    expect(mockRecordPayment.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        amount: '250000.00',
        allowOverpayment: true,
        allocations: [
          { itemId: 'plan', installmentId: 'c1', amount: '100000.00' },
          { itemId: 'flat', amount: '50000.00' },
          { itemId: 'plan', installmentId: 'c2', amount: '100000.00' },
        ],
      }),
    )
  })

  test('putting the rest on a debt beyond what it owes names it in the confirm', async () => {
    mockSuggested.mockResolvedValue(suggestion('250000.00', DUE_LINES))
    // Enough is owed overall, but the flat item would be paid past its 50.000.
    mockRecordPayment
      .mockRejectedValueOnce(
        new AllocationExceedsTargetError('flat', null, '50000.00', '150000.00'),
      )
      .mockResolvedValueOnce(DETAIL)
    const user = userEvent.setup()
    const { dialog } = renderForm()

    await user.type(await dialog.findByLabelText(/Amount received/), '250000')
    await waitFor(() => expect(dialog.getByLabelText(FLAT)).toHaveValue(50000))

    await user.click(dialog.getByRole('button', { name: 'Put the rest on…' }))
    const menu = within(
      await screen.findByRole('menu', { name: 'Debt to put the rest on' }),
    )
    await user.click(menu.getByRole('menuitem', { name: /Concert tickets/ }))

    // The row now exceeds what that debt owes — said inline, not clamped.
    expect(dialog.getByLabelText(FLAT)).toHaveValue(150000)
    expect(
      dialog.getByText(
        "That's ARS 100.000 more than the ARS 50.000 it owes. The extra becomes a credit, and you'll be asked to confirm it.",
      ),
    ).toBeInTheDocument()

    await user.click(dialog.getByRole('button', { name: 'Record payment' }))

    // The typed 409 names the debt and what it still owes.
    expect(await dialog.findByText('More than this debt owes')).toBeInTheDocument()
    expect(
      dialog.getByText(
        'Concert tickets only owes ARS 50.000, but this payment applies ARS 150.000 to it. Record the extra ARS 100.000 as a credit?',
      ),
    ).toBeInTheDocument()

    await user.click(dialog.getByRole('button', { name: 'Record anyway' }))
    await waitFor(() => expect(mockRecordPayment).toHaveBeenCalledTimes(2))
    expect(mockRecordPayment.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        amount: '250000.00',
        allowOverpayment: true,
        allocations: [
          { itemId: 'plan', installmentId: 'c1', amount: '100000.00' },
          { itemId: 'flat', amount: '150000.00' },
        ],
      }),
    )
  })
})
