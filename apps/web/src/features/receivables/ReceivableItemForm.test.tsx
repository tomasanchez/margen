/**
 * Unit tests for the receivable item form's installments + expense link
 * (ADR-204/214/216/217/218/220, ADR-037).
 *
 * Driven against a MOCKED {@link receivablesClient} (the network boundary) so the
 * real TanStack Query hooks + the save orchestration run end to end:
 *
 *  - the "Pay in installments" toggle reveals a LIVE preview of the even split
 *    (cents remainder on the last cuota, monthly due dates from next month) and
 *    sends `installments: { count, firstDueOn }`;
 *  - a create is ONE atomic, idempotent request: previewed cuota tweaks travel as
 *    `installments.cuotas`, the form's client id rides along as `id` and is
 *    REUSED on retry, and an `item_id_conflict` reads as "may already be saved";
 *  - picking an expense prefills the untouched fields, shows the non-blocking
 *    over-split warning against the expense's PLAN total, and sends
 *    `sourceTransactionId`; a card-cuota expense turns the plan on with its count;
 *  - a stale plan re-shape answering 409 shows the friendly lock message, and a
 *    plan with payments disables its shape fields while per-cuota edits still go
 *    through the cuota PATCH — never below what was paid (inline + typed 422);
 *  - dates outside 2000..2100 can't be saved.
 *
 * English-pinned (ADR-105); money asserted via the shared es-AR formatter.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ColorModeProvider } from '../../theme/colorMode'
import {
  InstallmentAmountBelowPaidError,
  InstallmentScheduleLockedError,
  ReceivableItemIdConflictError,
  receivablesClient,
  type ReceivableItem,
} from '../../api/receivablesClient'
import { formatCurrency } from '../../lib/format'
import {
  ReceivableItemForm,
  type ReceivableItemFormProps,
} from './ReceivableItemForm'
import { addMonthsClamped, todayIso } from './installments'
import {
  makeCandidate,
  makeCreated,
  makeCuota,
  makeDetail,
  makeItem,
  makePerson,
} from './__fixtures__/receivables'

vi.mock('../../api/receivablesClient', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/receivablesClient')>()
  return {
    ...actual,
    receivablesClient: {
      listPeople: vi.fn(),
      getPerson: vi.fn(),
      createPerson: vi.fn(),
      addItem: vi.fn(),
      editItem: vi.fn(),
      editInstallment: vi.fn(),
      searchExpenseCandidates: vi.fn(),
    },
  }
})

const mockListPeople = vi.mocked(receivablesClient.listPeople)
const mockGetPerson = vi.mocked(receivablesClient.getPerson)
const mockAddItem = vi.mocked(receivablesClient.addItem)
const mockEditItem = vi.mocked(receivablesClient.editItem)
const mockEditInstallment = vi.mocked(receivablesClient.editInstallment)
const mockSearch = vi.mocked(receivablesClient.searchExpenseCandidates)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const EXISTING = makeItem({
  id: 'i1',
  occurredOn: '2026-08-01',
  amount: '5000.00',
  detail: 'Coffee',
})

const DETAIL = makeDetail({ id: 'p1', name: 'Ana', items: [EXISTING] })

/** A 3-cuota plan (300.000) from 2026-08-20, monthly. */
function planItem(fields: Partial<ReceivableItem> = {}): ReceivableItem {
  return makeItem({
    id: 'plan',
    occurredOn: '2026-08-01',
    amount: '300000.00',
    detail: 'Flights',
    installments: [
      makeCuota({ id: 'c1', index: 1, dueOn: '2026-08-20', amount: '100000.00', status: 'due' }),
      makeCuota({ id: 'c2', index: 2, dueOn: '2026-09-20', amount: '100000.00', status: 'upcoming' }),
      makeCuota({ id: 'c3', index: 3, dueOn: '2026-10-20', amount: '100000.00', status: 'upcoming' }),
    ],
    ...fields,
  })
}

/** The plan with cuota 1 fully paid (so its shape is locked, ADR-216). */
function paidPlan(): ReceivableItem {
  return planItem({
    allocated: '100000.00',
    remaining: '200000.00',
    installments: [
      makeCuota({ id: 'c1', index: 1, dueOn: '2026-08-20', amount: '100000.00', status: 'paid', paid: '100000.00' }),
      makeCuota({ id: 'c2', index: 2, dueOn: '2026-09-20', amount: '100000.00', status: 'upcoming', paid: '40000.00' }),
      makeCuota({ id: 'c3', index: 3, dueOn: '2026-10-20', amount: '100000.00', status: 'upcoming' }),
    ],
  })
}

function renderForm(props: Partial<ReceivableItemFormProps> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const onClose = vi.fn()
  const onSaved = vi.fn()
  render(
    <QueryClientProvider client={queryClient}>
      <ColorModeProvider>
        <ReceivableItemForm
          open
          personId="p1"
          item={null}
          onClose={onClose}
          onSaved={onSaved}
          {...props}
        />
      </ColorModeProvider>
    </QueryClientProvider>,
  )
  return { onClose, onSaved, dialog: within(screen.getByRole('dialog')) }
}

/** The preview's cuota rows (label + due + amount text). */
function cuotaRows(dialog: ReturnType<typeof within>) {
  return dialog.getAllByTestId('installment-row')
}

describe('ReceivableItemForm — installments + link', () => {
  beforeEach(() => {
    mockListPeople.mockResolvedValue([makePerson({ id: 'p1', name: 'Ana' })])
    mockGetPerson.mockResolvedValue(DETAIL)
    mockAddItem.mockResolvedValue(makeCreated(DETAIL, 'new-item'))
    mockEditItem.mockResolvedValue(
      makeDetail({ id: 'p1', name: 'Ana', items: [planItem()] }),
    )
    mockEditInstallment.mockResolvedValue(
      makeDetail({ id: 'p1', name: 'Ana', items: [planItem()] }),
    )
    mockSearch.mockResolvedValue([])
  })
  afterEach(() => vi.clearAllMocks())

  test('the installments toggle previews the even split and saves the plan', async () => {
    const user = userEvent.setup()
    const { dialog, onClose, onSaved } = renderForm()

    await user.type(dialog.getByLabelText(/Amount/), '1000')
    await user.click(
      dialog.getByRole('switch', { name: 'Pay in installments (cuotas)' }),
    )

    // The amount now reads as the plan's total; 3 cuotas by default, the cents
    // remainder on the LAST one (the backend's split).
    expect(dialog.getByLabelText(/Total amount/)).toHaveValue(1000)
    const firstDue = addMonthsClamped(todayIso(), 1) ?? ''
    expect(dialog.getByLabelText(/First cuota due/)).toHaveValue(firstDue)
    let rows = cuotaRows(dialog)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('Cuota 1/3')
    expect(rows[0]).toHaveTextContent(`Due ${firstDue}`)
    expect(rows[0]).toHaveTextContent(formatCurrency(333.33, 'ARS'))
    expect(rows[1]).toHaveTextContent(formatCurrency(333.33, 'ARS'))
    expect(rows[2]).toHaveTextContent(formatCurrency(333.34, 'ARS'))
    expect(rows[1]).toHaveTextContent(
      `Due ${addMonthsClamped(firstDue, 1) ?? ''}`,
    )

    // A new count re-splits live.
    const count = dialog.getByLabelText(/Number of cuotas/)
    await user.clear(count)
    await user.type(count, '4')
    rows = cuotaRows(dialog)
    expect(rows).toHaveLength(4)
    expect(rows[3]).toHaveTextContent(formatCurrency(250, 'ARS'))
    expect(dialog.getByText('4 cuotas · total ARS 1.000')).toBeInTheDocument()

    await user.click(dialog.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockAddItem).toHaveBeenCalledTimes(1))
    const [personId, body] = mockAddItem.mock.calls[0]
    expect(personId).toBe('p1')
    expect(body).toEqual(
      expect.objectContaining({
        amount: '1000.00',
        installments: { count: 4, firstDueOn: firstDue, cuotas: [] },
      }),
    )
    // Every create carries the form's client-generated idempotency id.
    expect(body.id).toMatch(UUID)
    // The create is atomic: no extra read, no follow-up cuota PATCH.
    expect(mockGetPerson).not.toHaveBeenCalled()
    expect(mockEditInstallment).not.toHaveBeenCalled()
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    // The created item's id comes from the response's createdItemId.
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ personId: 'p1', itemId: 'new-item' }),
    )
  })

  test('previewed cuota tweaks travel in the create itself (installments.cuotas)', async () => {
    const user = userEvent.setup()
    const { dialog, onClose } = renderForm()

    await user.type(dialog.getByLabelText(/Amount/), '1000')
    await user.click(
      dialog.getByRole('switch', { name: 'Pay in installments (cuotas)' }),
    )

    // A recargo on the last cuota: edit it inline.
    await user.click(dialog.getByRole('button', { name: 'Edit cuota 3/3' }))
    const cuotaAmount = dialog.getByLabelText('Amount · cuota 3/3')
    await user.clear(cuotaAmount)
    await user.type(cuotaAmount, '400')
    await user.click(dialog.getByRole('button', { name: 'Save cuota 3/3' }))

    const rows = cuotaRows(dialog)
    expect(rows[2]).toHaveTextContent('Edited')
    expect(rows[2]).toHaveTextContent(formatCurrency(400, 'ARS'))
    expect(
      dialog.getByText(
        `3 cuotas · total ${formatCurrency(1066.66, 'ARS')} with your edits`,
      ),
    ).toBeInTheDocument()

    await user.click(dialog.getByRole('button', { name: 'Save' }))

    // ONE request: the even split plus the tweak, applied atomically.
    await waitFor(() => expect(mockAddItem).toHaveBeenCalledTimes(1))
    expect(mockAddItem).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        amount: '1000.00',
        installments: expect.objectContaining({
          count: 3,
          cuotas: [{ index: 3, amount: '400.00' }],
        }),
      }),
    )
    expect(mockGetPerson).not.toHaveBeenCalled()
    expect(mockEditInstallment).not.toHaveBeenCalled()
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  test('a retried create reuses its idempotency id; an id conflict says it may already exist', async () => {
    // 1st attempt: the response is lost (network error). 2nd: the API reports
    // the id is already used with other terms (the owner changed the amount).
    mockAddItem
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new ReceivableItemIdConflictError('x'))
    const user = userEvent.setup()
    const { dialog, onClose } = renderForm()

    await user.type(dialog.getByLabelText(/Amount/), '1000')
    await user.click(dialog.getByRole('button', { name: 'Save' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent(
      "We couldn't save this item. Check your connection and try again.",
    )

    const amount = dialog.getByLabelText(/Amount/)
    await user.clear(amount)
    await user.type(amount, '1200')
    await user.click(dialog.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockAddItem).toHaveBeenCalledTimes(2))
    // The SAME id on the retry — a lost response can never duplicate the item.
    const firstId = mockAddItem.mock.calls[0][1].id
    expect(firstId).toMatch(UUID)
    expect(mockAddItem.mock.calls[1][1].id).toBe(firstId)
    expect(await dialog.findByRole('alert')).toHaveTextContent(
      'This item may already have been saved, with different details, on an earlier attempt. Close this form and check the list before adding it again.',
    )
    expect(onClose).not.toHaveBeenCalled()
  })

  test('the inline cuota editor: Enter saves the cuota (not the item), Escape cancels', async () => {
    const user = userEvent.setup()
    const { dialog, onClose } = renderForm()

    await user.type(dialog.getByLabelText(/Amount/), '900')
    await user.click(
      dialog.getByRole('switch', { name: 'Pay in installments (cuotas)' }),
    )

    // Enter inside the cuota editor saves THAT cuota and never submits the form.
    await user.click(dialog.getByRole('button', { name: 'Edit cuota 2/3' }))
    const cuotaAmount = dialog.getByLabelText('Amount · cuota 2/3')
    expect(cuotaAmount).toHaveFocus()
    await user.clear(cuotaAmount)
    await user.type(cuotaAmount, '350{Enter}')
    expect(mockAddItem).not.toHaveBeenCalled()
    expect(cuotaRows(dialog)[1]).toHaveTextContent(formatCurrency(350, 'ARS'))
    // Focus returns to the row's edit button (never lost to <body>).
    expect(dialog.getByRole('button', { name: 'Edit cuota 2/3' })).toHaveFocus()

    // Escape closes only the editor — the dialog stays open, the row unchanged.
    await user.click(dialog.getByRole('button', { name: 'Edit cuota 1/3' }))
    await user.type(dialog.getByLabelText('Amount · cuota 1/3'), '9')
    await user.keyboard('{Escape}')
    expect(dialog.queryByLabelText('Amount · cuota 1/3')).toBeNull()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    expect(cuotaRows(dialog)[0]).toHaveTextContent(formatCurrency(300, 'ARS'))
    expect(cuotaRows(dialog)[0]).not.toHaveTextContent('Edited')
  })

  test('picking an expense prefills the fields, warns on an over-split, and links it', async () => {
    mockSearch.mockResolvedValue([
      makeCandidate({
        id: 'tx-1',
        name: 'Dinner at Don Julio',
        occurredOn: '2026-10-05',
        amount: '60000.00',
        // Other people's items already link 40.000 of it (ADR-218).
        linkedItemsTotal: '40000.00',
      }),
    ])
    const user = userEvent.setup()
    const { dialog } = renderForm()

    await user.type(
      dialog.getByRole('combobox', { name: 'Link transaction (optional)' }),
      'Din',
    )
    // The search is server-side and debounced with the typed text.
    await waitFor(() =>
      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'Din' }),
      ),
    )
    await user.click(
      await screen.findByRole('option', { name: /Dinner at Don Julio/ }),
    )

    // Untouched fields follow the expense.
    expect(dialog.getByLabelText(/Date/)).toHaveValue('2026-10-05')
    expect(dialog.getByLabelText(/Amount/)).toHaveValue(60000)
    expect(dialog.getByLabelText(/Detail/)).toHaveValue('Dinner at Don Julio')

    // 40.000 already linked + 60.000 here > the 60.000 expense → calm warning.
    expect(
      await dialog.findByText(
        'Debts linked to this expense would add up to ARS 100.000, more than its ARS 60.000. You can still save.',
      ),
    ).toBeInTheDocument()

    // Splitting it fairly clears the warning (non-blocking either way).
    const amount = dialog.getByLabelText(/Amount/)
    await user.clear(amount)
    await user.type(amount, '20000')
    expect(
      dialog.queryByText(/Debts linked to this expense would add up/),
    ).not.toBeInTheDocument()

    await user.click(dialog.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mockAddItem).toHaveBeenCalledTimes(1))
    expect(mockAddItem).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        occurredOn: '2026-10-05',
        amount: '20000.00',
        detail: 'Dinner at Don Julio',
        sourceTransactionId: 'tx-1',
        installments: null,
      }),
    )
  })

  test('a card-cuota expense: plan on with its count, total left open, warning vs the PLAN total', async () => {
    mockSearch.mockResolvedValue([
      makeCandidate({
        id: 'tx-2',
        name: 'Notebook',
        occurredOn: '2026-10-05',
        amount: '10000.00',
        installmentsIndex: 3,
        installmentsTotal: 6,
        // planTotal defaults to 10.000 × 6 = 60.000 (the server's figure).
      }),
    ])
    const user = userEvent.setup()
    const { dialog } = renderForm()

    await user.click(
      dialog.getByRole('combobox', { name: 'Link transaction (optional)' }),
    )
    await user.click(await screen.findByRole('option', { name: /Notebook/ }))

    expect(
      dialog.getByRole('switch', { name: 'Pay in installments (cuotas)' }),
    ).toBeChecked()
    expect(dialog.getByLabelText(/Number of cuotas/)).toHaveValue(6)
    // The expense's amount is ONE card cuota, never assumed to be the total.
    expect(dialog.getByLabelText(/Total amount/)).toHaveValue(null)
    expect(
      dialog.getByText(
        'This expense is cuota 3/6 of ARS 10.000 (ARS 60.000 in total). Enter the total this person owes you.',
      ),
    ).toBeInTheDocument()
    // The first cuota falls due a month after the expense.
    expect(dialog.getByLabelText(/First cuota due/)).toHaveValue('2026-11-05')

    // The debt equals the whole purchase → NO over-split warning (it would warn
    // if compared against the single 10.000 cuota).
    await user.type(dialog.getByLabelText(/Total amount/), '60000')
    expect(cuotaRows(dialog)).toHaveLength(6)
    expect(dialog.queryByText(/would add up to/)).not.toBeInTheDocument()

    // Beyond the purchase total → the plan-worded warning.
    const total = dialog.getByLabelText(/Total amount/)
    await user.clear(total)
    await user.type(total, '70000')
    expect(
      dialog.getByText(
        'Debts linked to this purchase would add up to ARS 70.000, more than its ARS 60.000 total (6 cuotas). You can still save.',
      ),
    ).toBeInTheDocument()
  })

  test('re-shaping a plan that turned out to have payments shows the friendly 409 message', async () => {
    mockEditItem.mockRejectedValue(
      new InstallmentScheduleLockedError('plan', 'allocations'),
    )
    const user = userEvent.setup()
    const { dialog, onClose } = renderForm({ item: planItem() })

    const count = dialog.getByLabelText(/Number of cuotas/)
    expect(count).toHaveValue(3)
    await user.clear(count)
    await user.type(count, '4')
    expect(
      dialog.getByText('Saving re-splits every cuota evenly.'),
    ).toBeInTheDocument()

    await user.click(dialog.getByRole('button', { name: 'Save' }))

    expect(await dialog.findByRole('alert')).toHaveTextContent(
      "This plan already has payments, so its total, number of cuotas or first due date can't change. Remove those payments first, or edit individual cuotas instead.",
    )
    // Only the plan is re-sent (the unchanged total is omitted).
    expect(mockEditItem).toHaveBeenCalledWith('p1', 'plan', {
      installments: { count: 4, firstDueOn: '2026-08-20' },
    })
    expect(onClose).not.toHaveBeenCalled()
  })

  test('a plan with payments locks its shape but still edits single cuotas', async () => {
    const user = userEvent.setup()
    const { dialog, onClose } = renderForm({ item: paidPlan() })

    expect(
      dialog.getByText(
        "This plan already has payments, so its total, number of cuotas and first due date can't change. You can still edit individual cuotas.",
      ),
    ).toBeInTheDocument()
    expect(dialog.getByLabelText(/Number of cuotas/)).toBeDisabled()
    expect(dialog.getByLabelText(/First cuota due/)).toBeDisabled()
    expect(dialog.getByLabelText(/Total amount/)).toBeDisabled()
    expect(
      dialog.getByRole('switch', { name: 'Pay in installments (cuotas)' }),
    ).toBeDisabled()
    // The saved cuotas keep their status chips.
    expect(cuotaRows(dialog)[0]).toHaveTextContent('Paid')

    // A recargo on cuota 3 still goes through (cuota PATCH only).
    await user.click(dialog.getByRole('button', { name: 'Edit cuota 3/3' }))
    const cuotaAmount = dialog.getByLabelText('Amount · cuota 3/3')
    await user.clear(cuotaAmount)
    await user.type(cuotaAmount, '120000')
    fireEvent.change(dialog.getByLabelText('Due date · cuota 3/3'), {
      target: { value: '2026-10-25' },
    })
    await user.click(dialog.getByRole('button', { name: 'Save cuota 3/3' }))
    await user.click(dialog.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockEditInstallment).toHaveBeenCalledTimes(1))
    expect(mockEditInstallment).toHaveBeenCalledWith('p1', 'plan', 3, {
      amount: '120000.00',
      dueOn: '2026-10-25',
    })
    // Nothing else changed → no item PATCH that could trip the lock.
    expect(mockEditItem).not.toHaveBeenCalled()
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  test('a cuota can never go below what was already paid (inline, and the typed 422)', async () => {
    mockEditInstallment.mockRejectedValue(
      new InstallmentAmountBelowPaidError('plan', 2, '40000.00', '30000.00'),
    )
    const user = userEvent.setup()
    const { dialog } = renderForm({ item: paidPlan() })

    // Cuota 1 is fully paid (100.000): lowering it is refused up front.
    await user.click(dialog.getByRole('button', { name: 'Edit cuota 1/3' }))
    const first = dialog.getByLabelText('Amount · cuota 1/3')
    await user.clear(first)
    await user.type(first, '50000')
    expect(
      dialog.getByText("Can't be less than the ARS 100.000 already paid."),
    ).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: 'Save cuota 1/3' })).toBeDisabled()
    await user.keyboard('{Escape}')

    // If the server still refuses (stale data), the save says which cuota.
    await user.click(dialog.getByRole('button', { name: 'Edit cuota 2/3' }))
    const second = dialog.getByLabelText('Amount · cuota 2/3')
    await user.clear(second)
    await user.type(second, '45000')
    await user.click(dialog.getByRole('button', { name: 'Save cuota 2/3' }))
    await user.click(dialog.getByRole('button', { name: 'Save' }))

    expect(await dialog.findByRole('alert')).toHaveTextContent(
      "Cuota 2 can't be less than the ARS 40.000 already paid.",
    )
  })

  test('dates outside 2000..2100 cannot be saved', async () => {
    const user = userEvent.setup()
    const { dialog } = renderForm()

    await user.type(dialog.getByLabelText(/Amount/), '1000')
    fireEvent.change(dialog.getByLabelText(/Date/), {
      target: { value: '1999-12-31' },
    })
    expect(dialog.getByText('Pick a date between 2000 and 2100.')).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled()

    fireEvent.change(dialog.getByLabelText(/Date/), {
      target: { value: '2026-10-05' },
    })
    expect(dialog.getByRole('button', { name: 'Save' })).toBeEnabled()
  })
})
