/**
 * Unit tests for installment items + expense links in the Owed list
 * (ADR-214/215/216/217/218/221).
 *
 * Renders the real {@link ReceivablesSection} behind a memory router (the linked
 * expense chip is a TanStack `<Link>`) against a MOCKED {@link receivablesClient}:
 *
 *  - a person's row shows what is owed today plus the upcoming cuotas;
 *  - a plan reads "N/M cuotas due · owed · upcoming" (the due count from the
 *    server's cuota status) and its cuota list shows a status chip per cuota;
 *  - forgiving one cuota goes through a confirm and the cuota pardon; restoring
 *    one is direct; forgiving the item forgives the rest of the plan;
 *  - an inline cuota edit PATCHes only what changed, and a typed 422 (below what
 *    was paid) reads inline;
 *  - while ANY write for an item is in flight, all of that item's actions hold;
 *  - money paid beyond what is owed reads as a CREDIT, never a negative owed;
 *  - the link chip opens the transactions list filtered to the expense, and an
 *    over-split expense shows a calm warning against its plan total.
 *
 * Dates are chosen so nothing depends on the real clock: past cuotas sit in 2020
 * and upcoming ones in 2099. English-pinned (ADR-105).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { ColorModeProvider } from '../../theme/colorMode'
import { validateTransactionsSearch } from '../transactions/filtering'
import { ReceivablesSection } from './ReceivablesSection'
import {
  InstallmentAmountBelowPaidError,
  receivablesClient,
  type PersonDetail,
  type ReceivableItem,
} from '../../api/receivablesClient'
import {
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
      pardonItem: vi.fn(),
      unpardonItem: vi.fn(),
      editInstallment: vi.fn(),
      pardonInstallment: vi.fn(),
      unpardonInstallment: vi.fn(),
      matchSuggestions: vi.fn(),
      downloadPersonPdf: vi.fn(),
    },
  }
})

const mockListPeople = vi.mocked(receivablesClient.listPeople)
const mockGetPerson = vi.mocked(receivablesClient.getPerson)
const mockPardonItem = vi.mocked(receivablesClient.pardonItem)
const mockEditInstallment = vi.mocked(receivablesClient.editInstallment)
const mockPardonInstallment = vi.mocked(receivablesClient.pardonInstallment)
const mockUnpardonInstallment = vi.mocked(receivablesClient.unpardonInstallment)
const mockMatchSuggestions = vi.mocked(receivablesClient.matchSuggestions)

/** A 3-cuota plan: cuota 1 paid, cuota 2 due, cuota 3 upcoming; linked. */
function plan(fields: Partial<ReceivableItem> = {}): ReceivableItem {
  return makeItem({
    id: 'plan',
    occurredOn: '2020-01-01',
    amount: '300000.00',
    detail: 'Flights',
    allocated: '100000.00',
    remaining: '200000.00',
    dueOutstanding: '100000.00',
    upcomingTotal: '100000.00',
    installments: [
      makeCuota({ id: 'c1', index: 1, dueOn: '2020-01-10', amount: '100000.00', status: 'paid', paid: '100000.00' }),
      makeCuota({ id: 'c2', index: 2, dueOn: '2020-02-10', amount: '100000.00', status: 'due' }),
      makeCuota({ id: 'c3', index: 3, dueOn: '2099-03-10', amount: '100000.00', status: 'upcoming' }),
    ],
    sourceTransaction: {
      id: 'tx-1',
      name: 'Dinner at Don Julio',
      occurredOn: '2026-10-05',
      amount: '60000.00',
      currency: 'ARS',
      usdAmount: null,
      installmentsIndex: null,
      installmentsTotal: null,
      planTotal: '60000.00',
      linkedItemsTotal: '300000.00',
    },
    linkedTotalExceedsExpense: true,
    ...fields,
  })
}

function detail(item: ReceivableItem = plan()): PersonDetail {
  return makeDetail({
    id: 'p1',
    name: 'Ana',
    outstanding: '100000.00',
    upcomingTotal: '100000.00',
    items: [item],
  })
}

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <ReceivablesSection />
        <Outlet />
      </>
    ),
  })
  const transactionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/transactions',
    validateSearch: validateTransactionsSearch,
    component: () => <p>Transactions page</p>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([transactionsRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(
    <QueryClientProvider client={queryClient}>
      <ColorModeProvider>
        <RouterProvider router={router} />
      </ColorModeProvider>
    </QueryClientProvider>,
  )
  return router
}

/** Expand Ana and wait for her plan to load. */
async function expandAna(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: "Show Ana's items" }))
  await screen.findByText('Flights')
}

/** Open the plan's cuota list and return its rows. */
async function openCuotas(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Show cuotas (3)' }))
  return screen.getAllByTestId('installment-row')
}

describe('Owed list — installments + expense links', () => {
  beforeEach(() => {
    mockListPeople.mockResolvedValue([
      makePerson({
        id: 'p1',
        name: 'Ana',
        outstanding: '100000.00',
        upcomingTotal: '100000.00',
      }),
    ])
    mockGetPerson.mockResolvedValue(detail())
    mockPardonItem.mockResolvedValue(detail())
    mockEditInstallment.mockResolvedValue(detail())
    mockPardonInstallment.mockResolvedValue(detail())
    mockUnpardonInstallment.mockResolvedValue(detail())
    mockMatchSuggestions.mockResolvedValue([])
  })
  afterEach(() => vi.clearAllMocks())

  test('a person row shows what is owed today plus the upcoming cuotas', async () => {
    renderSection()
    expect(await screen.findByText('Ana')).toBeInTheDocument()
    // Outstanding counts only due cuotas (ADR-215); upcoming reads apart.
    expect(screen.getByText('ARS 100.000')).toBeInTheDocument()
    expect(screen.getByText('+ ARS 100.000 upcoming')).toBeInTheDocument()
  })

  test('a plan summarizes its cuotas and lists each with a status chip', async () => {
    const user = userEvent.setup()
    renderSection()
    await expandAna(user)

    expect(
      screen.getByText('ARS 100.000 due now · ARS 100.000 in upcoming cuotas'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('2020-01-01 · ARS 300.000 in 3 cuotas'),
    ).toBeInTheDocument()
    // One cuota is DUE per the server's status (the paid one doesn't count).
    expect(
      screen.getByText('1/3 cuotas due · ARS 100.000 owed · ARS 100.000 upcoming'),
    ).toBeInTheDocument()
    // Still owed = due + upcoming (forgiven cuotas would be excluded).
    expect(screen.getByText('ARS 200.000 remaining')).toBeInTheDocument()

    const rows = await openCuotas(user)
    expect(rows).toHaveLength(3)
    expect(within(rows[0]).getByText('Paid')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Due')).toBeInTheDocument()
    expect(within(rows[2]).getByText('Upcoming')).toBeInTheDocument()
    expect(rows[2]).toHaveTextContent('Due 2099-03-10')
    // A paid cuota has nothing left to forgive.
    expect(
      screen.queryByRole('button', { name: 'Forgive cuota 1/3' }),
    ).not.toBeInTheDocument()
  })

  test('forgiving one cuota confirms, then calls the cuota pardon', async () => {
    const user = userEvent.setup()
    renderSection()
    await expandAna(user)
    await openCuotas(user)

    await user.click(screen.getByRole('button', { name: 'Forgive cuota 2/3' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(
      dialog.getByText(/Forgive cuota 2\/3 of "Flights"\?/),
    ).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Forgive' }))

    await waitFor(() =>
      expect(mockPardonInstallment).toHaveBeenCalledWith('p1', 'plan', 2),
    )
    expect(mockPardonItem).not.toHaveBeenCalled()
  })

  test('restoring a covered cuota is a direct toggle (no confirm)', async () => {
    const covered = plan({
      installments: [
        makeCuota({ id: 'c1', index: 1, dueOn: '2020-01-10', amount: '100000.00', status: 'paid', paid: '100000.00' }),
        makeCuota({ id: 'c2', index: 2, dueOn: '2020-02-10', amount: '100000.00', status: 'due' }),
        makeCuota({ id: 'c3', index: 3, dueOn: '2099-03-10', amount: '100000.00', status: 'pardoned' }),
      ],
      upcomingTotal: '0.00',
    })
    mockGetPerson.mockResolvedValue(detail(covered))
    const user = userEvent.setup()
    renderSection()
    await expandAna(user)
    const rows = await openCuotas(user)
    expect(within(rows[2]).getByText('Covered')).toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'Restore cuota 3/3 as owed' }),
    )

    await waitFor(() =>
      expect(mockUnpardonInstallment).toHaveBeenCalledWith('p1', 'plan', 3),
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  test('forgiving the plan item forgives every cuota still owed (plan copy)', async () => {
    const user = userEvent.setup()
    renderSection()
    await expandAna(user)

    await user.click(
      screen.getByRole('button', {
        name: 'Forgive the remaining cuotas of the item from 2020-01-01',
      }),
    )
    const dialog = within(await screen.findByRole('dialog'))
    expect(
      dialog.getByText(/Forgive every cuota still owed on this plan\?/),
    ).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Forgive' }))

    await waitFor(() =>
      expect(mockPardonItem).toHaveBeenCalledWith('p1', 'plan'),
    )
  })

  test('an inline cuota edit PATCHes only the changed field', async () => {
    const user = userEvent.setup()
    renderSection()
    await expandAna(user)
    await openCuotas(user)

    await user.click(screen.getByRole('button', { name: 'Edit cuota 3/3' }))
    fireEvent.change(screen.getByLabelText('Due date · cuota 3/3'), {
      target: { value: '2099-04-10' },
    })
    await user.click(screen.getByRole('button', { name: 'Save cuota 3/3' }))

    await waitFor(() => expect(mockEditInstallment).toHaveBeenCalledTimes(1))
    const [personId, itemId, index, change] = mockEditInstallment.mock.calls[0]
    expect([personId, itemId, index]).toEqual(['p1', 'plan', 3])
    expect(change).toEqual({ amount: undefined, dueOn: '2099-04-10' })
    // The editor closes once the PATCH lands.
    await waitFor(() =>
      expect(screen.queryByLabelText('Due date · cuota 3/3')).toBeNull(),
    )
  })

  test('a typed 422 (below what was already paid) reads inline in the cuota editor', async () => {
    mockEditInstallment.mockRejectedValue(
      new InstallmentAmountBelowPaidError('plan', 3, '25000.00', '20000.00'),
    )
    const user = userEvent.setup()
    renderSection()
    await expandAna(user)
    await openCuotas(user)

    await user.click(screen.getByRole('button', { name: 'Edit cuota 3/3' }))
    const amount = screen.getByLabelText('Amount · cuota 3/3')
    await user.clear(amount)
    await user.type(amount, '20000')
    await user.click(screen.getByRole('button', { name: 'Save cuota 3/3' }))

    expect(
      await screen.findByText("Can't be less than the ARS 25.000 already paid."),
    ).toBeInTheDocument()
    // The editor stays open with the owner's input.
    expect(screen.getByLabelText('Amount · cuota 3/3')).toHaveValue(20000)
  })

  test("while any write for an item is in flight, all of that item's actions hold", async () => {
    let finish!: (value: PersonDetail) => void
    mockEditInstallment.mockReturnValueOnce(
      new Promise<PersonDetail>((resolve) => {
        finish = resolve
      }),
    )
    const user = userEvent.setup()
    renderSection()
    await expandAna(user)
    await openCuotas(user)

    await user.click(screen.getByRole('button', { name: 'Edit cuota 3/3' }))
    fireEvent.change(screen.getByLabelText('Due date · cuota 3/3'), {
      target: { value: '2099-04-10' },
    })
    await user.click(screen.getByRole('button', { name: 'Save cuota 3/3' }))

    // The cuota edit is pending → every other action on this item is held.
    const held = [
      'Edit item from 2020-01-01',
      'Forgive the remaining cuotas of the item from 2020-01-01',
      'Delete item from 2020-01-01',
      'Edit cuota 2/3',
      'Forgive cuota 2/3',
      'Edit cuota 3/3',
    ]
    await waitFor(() => {
      for (const name of held) {
        expect(screen.getByRole('button', { name })).toBeDisabled()
      }
    })

    finish(detail())
    await waitFor(() => {
      for (const name of held) {
        expect(screen.getByRole('button', { name })).toBeEnabled()
      }
    })
  })

  test('money paid beyond what is owed reads as a credit, never a negative owed', async () => {
    // Cuota 2 (not due yet) was paid 5.000 beyond its amount: it shows as paid
    // with a credit, and the person's outstanding is −5.000 (ADR-206).
    const credit = plan({
      dueOutstanding: '-5000.00',
      upcomingTotal: '100000.00',
      linkedTotalExceedsExpense: false,
      sourceTransaction: null,
      installments: [
        makeCuota({ id: 'c1', index: 1, dueOn: '2020-01-10', amount: '100000.00', status: 'paid', paid: '100000.00' }),
        makeCuota({ id: 'c2', index: 2, dueOn: '2099-02-10', amount: '100000.00', status: 'paid', paid: '105000.00' }),
        makeCuota({ id: 'c3', index: 3, dueOn: '2099-03-10', amount: '100000.00', status: 'upcoming' }),
      ],
    })
    mockListPeople.mockResolvedValue([
      makePerson({
        id: 'p1',
        name: 'Ana',
        outstanding: '-5000.00',
        upcomingTotal: '100000.00',
      }),
    ])
    mockGetPerson.mockResolvedValue(
      makeDetail({
        id: 'p1',
        name: 'Ana',
        outstanding: '-5000.00',
        upcomingTotal: '100000.00',
        items: [credit],
      }),
    )
    const user = userEvent.setup()
    renderSection()

    // The person row: a credit, not "−ARS 5.000".
    expect(await screen.findByText('Credit ARS 5.000')).toBeInTheDocument()
    expect(screen.queryByText(/−ARS 5\.000/)).not.toBeInTheDocument()

    await expandAna(user)
    expect(
      screen.getByText('Credit ARS 5.000 · ARS 100.000 in upcoming cuotas'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('0/3 cuotas due · Credit ARS 5.000 · ARS 100.000 upcoming'),
    ).toBeInTheDocument()

    const rows = await openCuotas(user)
    expect(rows[1]).toHaveTextContent('Paid')
    expect(rows[1]).toHaveTextContent('Due 2099-02-10 · ARS 5.000 credit')
  })

  test('the link chip opens the transactions list filtered to the expense', async () => {
    const user = userEvent.setup()
    const router = renderSection()
    await expandAna(user)

    // The shared expense is over-split across items → a calm warning against
    // its plan total (ADR-218).
    expect(
      screen.getByText(
        'Debts linked to this expense add up to more than its ARS 60.000.',
      ),
    ).toBeInTheDocument()

    await user.click(
      screen.getByRole('link', {
        name: 'Open the linked expense Dinner at Don Julio from 2026-10-05 in Transactions',
      }),
    )

    expect(await screen.findByText('Transactions page')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/transactions')
    expect(router.state.location.search).toEqual({
      q: 'Dinner at Don Julio',
      month: '2026-10',
    })
  })
})
