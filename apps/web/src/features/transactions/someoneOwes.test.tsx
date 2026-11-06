/**
 * "Someone owes me this" — the transactions-list entry point into receivables
 * (ADR-217…220).
 *
 * Renders the real {@link TransactionsPage} against MOCKED transactions and
 * receivables clients (the network boundary) and drives the row action:
 *
 *  - an expense row's action opens the receivable item form PREFILLED from the
 *    expense (date, amount, its name as the detail, the link to it) with a
 *    person picker; a typed new name creates the person, then the item is saved
 *    linked to the expense and a calm confirmation shows;
 *  - the form looks up how much other items already link the expense and warns,
 *    non-blocking, when this debt would over-split it (ADR-218);
 *  - a card-cuota expense prefills a cuota plan with its count (ADR-174/220) and
 *    leaves the total to the owner; its over-split check uses the whole PLAN
 *    total (a debt for the full purchase is not an over-split); an existing
 *    person is matched by name;
 *  - every create carries the form's idempotency id.
 *
 * Rows are dated TODAY so the page's default current-month scope shows them
 * without pinning the clock. English-pinned (ADR-105).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '../../test/renderWithProviders'
import type { MonthName, Transaction } from '../../mock/types'
import { receivablesClient } from '../../api/receivablesClient'
import { TransactionsPage } from './TransactionsPage'
import { addMonthsClamped, todayIso } from '../receivables/installments'
import {
  makeCandidate,
  makeCreated,
  makeDetail,
  makePerson,
} from '../receivables/__fixtures__/receivables'

const { listMock } = vi.hoisted(() => ({ listMock: vi.fn() }))

vi.mock('../../api/transactionsClient', () => ({
  transactionsClient: {
    list: listMock,
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}))

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
      editInstallment: vi.fn(),
      searchExpenseCandidates: vi.fn(),
    },
  }
})

const mockListPeople = vi.mocked(receivablesClient.listPeople)
const mockCreatePerson = vi.mocked(receivablesClient.createPerson)
const mockAddItem = vi.mocked(receivablesClient.addItem)
const mockSearch = vi.mocked(receivablesClient.searchExpenseCandidates)

const MONTHS: MonthName[] = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

const TODAY = todayIso()
const NOW = new Date()

/** An expense row dated today (inside the page's default month scope). */
function expense(fields: Partial<Transaction> & Pick<Transaction, 'id' | 'name' | 'amountNum'>): Transaction {
  return {
    occurredOn: TODAY,
    dispDate: TODAY,
    month: MONTHS[NOW.getMonth()],
    category: 'Social',
    bank: 'Galicia',
    currency: 'ARS',
    type: 'expense',
    kind: 'expense',
    ...fields,
  }
}

const DINNER = expense({ id: 'tx-dinner', name: 'Dinner at Don Julio', amountNum: 60000 })
const NOTEBOOK = expense({
  id: 'tx-notebook',
  name: 'Notebook',
  amountNum: 100000,
  category: 'Shopping',
  recurringCadence: 'installment',
  installmentsIndex: 2,
  installmentsTotal: 6,
})

/** Open a row's actions menu and pick "Someone owes me this". */
async function openOwed(user: ReturnType<typeof userEvent.setup>, name: string) {
  const [trigger] = await screen.findAllByRole('button', {
    name: `Actions for ${name}`,
  })
  await user.click(trigger)
  await user.click(
    await screen.findByRole('menuitem', { name: 'Someone owes me this' }),
  )
  const dialog = await screen.findByRole('dialog', {
    name: 'Someone owes me this',
  })
  return within(dialog)
}

describe('Transactions → "Someone owes me this" (ADR-220)', () => {
  beforeEach(() => {
    listMock.mockResolvedValue([DINNER, NOTEBOOK])
    mockListPeople.mockResolvedValue([makePerson({ id: 'p1', name: 'Ana' })])
    mockCreatePerson.mockResolvedValue(
      makeDetail({ id: 'p-new', name: 'Carla', items: [] }),
    )
    mockAddItem.mockResolvedValue(
      makeCreated(makeDetail({ id: 'p-new', name: 'Carla', items: [] }), 'i-new'),
    )
    // The form's linked-total lookup finds the expense by name on its date.
    mockSearch.mockResolvedValue([
      makeCandidate({
        id: 'tx-dinner',
        name: 'Dinner at Don Julio',
        occurredOn: TODAY,
        amount: '60000.00',
        linkedItemsTotal: '30000.00',
      }),
      // A card cuota (2/6 of 100.000): the purchase stands for 600.000.
      makeCandidate({
        id: 'tx-notebook',
        name: 'Notebook',
        occurredOn: TODAY,
        amount: '100000.00',
        installmentsIndex: 2,
        installmentsTotal: 6,
        planTotal: '600000.00',
        linkedItemsTotal: '0.00',
      }),
    ])
  })
  afterEach(() => vi.clearAllMocks())

  test('opens the item form prefilled from the expense and saves it linked, for a new person', async () => {
    const user = userEvent.setup()
    renderWithProviders(<TransactionsPage />, { withAddProvider: true })

    const dialog = await openOwed(user, 'Dinner at Don Julio')

    // Prefilled from the expense (ADR-220).
    expect(dialog.getByLabelText(/Date/)).toHaveValue(TODAY)
    expect(dialog.getByLabelText(/Amount/)).toHaveValue(60000)
    expect(dialog.getByLabelText(/Detail/)).toHaveValue('Dinner at Don Julio')
    expect(
      dialog.getByRole('combobox', { name: 'Link transaction (optional)' }),
    ).toHaveValue('Dinner at Don Julio')
    expect(
      dialog.getByRole('switch', { name: 'Pay in installments (cuotas)' }),
    ).not.toBeChecked()

    // 30.000 already linked by someone else + this 60.000 > the 60.000 dinner.
    expect(
      await dialog.findByText(
        'Debts linked to this expense would add up to ARS 90.000, more than its ARS 60.000. You can still save.',
      ),
    ).toBeInTheDocument()
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'Dinner at Don Julio', from: TODAY, to: TODAY }),
    )

    // Saving needs a person: a typed new name is created on save.
    const save = dialog.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    await user.type(dialog.getByRole('combobox', { name: /Who owes you/ }), 'Carla')
    expect(
      dialog.getByText('Carla will be added as a new person.'),
    ).toBeInTheDocument()
    await user.click(save)

    await waitFor(() => expect(mockAddItem).toHaveBeenCalledTimes(1))
    expect(mockCreatePerson).toHaveBeenCalledWith('Carla')
    // The create carries the form's client-generated idempotency id.
    expect(mockAddItem.mock.calls[0][1].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(mockAddItem).toHaveBeenCalledWith(
      'p-new',
      expect.objectContaining({
        occurredOn: TODAY,
        amount: '60000.00',
        detail: 'Dinner at Don Julio',
        sourceTransactionId: 'tx-dinner',
        installments: null,
      }),
    )

    // A calm confirmation; the dialog is gone.
    expect(
      await screen.findByText('Added to what Carla owes you.'),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Someone owes me this' }),
      ).toBeNull(),
    )
  })

  test('a card-cuota expense prefills a cuota plan; an existing person is matched by name', async () => {
    mockAddItem.mockResolvedValue(
      makeCreated(makeDetail({ id: 'p1', name: 'Ana', items: [] }), 'i-new'),
    )
    const user = userEvent.setup()
    renderWithProviders(<TransactionsPage />, { withAddProvider: true })

    const dialog = await openOwed(user, 'Notebook')

    expect(
      dialog.getByRole('switch', { name: 'Pay in installments (cuotas)' }),
    ).toBeChecked()
    expect(dialog.getByLabelText(/Number of cuotas/)).toHaveValue(6)
    // One card cuota is not the debt: the total is left to the owner.
    expect(dialog.getByLabelText(/Total amount/)).toHaveValue(null)
    // The hint shows the cuota AND the whole purchase (from the lookup).
    expect(
      await dialog.findByText(
        'This expense is cuota 2/6 of ARS 100.000 (ARS 600.000 in total). Enter the total this person owes you.',
      ),
    ).toBeInTheDocument()

    await user.type(dialog.getByRole('combobox', { name: /Who owes you/ }), 'ana')
    expect(dialog.getByText('Adding to what Ana owes you.')).toBeInTheDocument()

    // More than the whole purchase → the plan-worded over-split warning…
    const total = dialog.getByLabelText(/Total amount/)
    await user.type(total, '700000')
    expect(
      dialog.getByText(
        'Debts linked to this purchase would add up to ARS 700.000, more than its ARS 600.000 total (6 cuotas). You can still save.',
      ),
    ).toBeInTheDocument()
    // …while a debt for exactly the whole purchase is NOT an over-split (it
    // would be, wrongly, if compared against the single 100.000 cuota).
    await user.clear(total)
    await user.type(total, '600000')
    expect(dialog.queryByText(/would add up to/)).not.toBeInTheDocument()

    await user.click(dialog.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockAddItem).toHaveBeenCalledTimes(1))
    expect(mockCreatePerson).not.toHaveBeenCalled()
    expect(mockAddItem).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        amount: '600000.00',
        detail: 'Notebook',
        sourceTransactionId: 'tx-notebook',
        installments: {
          count: 6,
          firstDueOn: addMonthsClamped(TODAY, 1),
          cuotas: [],
        },
      }),
    )
    expect(
      await screen.findByText('Added to what Ana owes you.'),
    ).toBeInTheDocument()
  })
})
