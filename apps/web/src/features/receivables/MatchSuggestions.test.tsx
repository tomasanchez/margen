/**
 * Unit tests for task 9's income match-suggestions review + per-person PDF export
 * (ADR-206/207/209), including the cuota-aware confirm (ADR-221).
 *
 * Drives the whole receivables section against a MOCKED {@link receivablesClient}
 * (the network boundary) so the real TanStack Query hooks + the suggestion review /
 * confirm-match / PDF-export flows run end to end, exactly like
 * {@link ReceivablesSection.test.tsx}:
 *
 *  - suggestions render for an expanded person, ranked by score (highest first);
 *  - reviewing a suggestion opens the confirm dialog, whose rows are PREFILLED
 *    from the server's suggested allocation for the income's amount (ADR-221) and
 *    settle it via `confirmMatch` (ADR-206/207);
 *  - an installment item's rows target its cuotas and send `installmentId`;
 *  - the rows must add up to the income: less needs an explicit acknowledgement
 *    (the income is claimed, the rest can't be matched again), more is blocked,
 *    and "apply the rest to upcoming cuotas" balances it explicitly;
 *  - a confirm-match overpayment (typed 409) warns, then retries with
 *    `allowOverpayment: true` (ADR-206);
 *  - a calm empty state renders when there are no suggestions;
 *  - the "Export PDF" button calls the authed download helper (ADR-209).
 *
 * English-pinned (ADR-105); money asserted via the shared es-AR formatter so exact
 * grouping never has to be hand-typed.
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
  type MatchSuggestion,
  type Person,
  type PersonDetail,
  type SuggestedAllocation,
  type SuggestedAllocationLine,
} from '../../api/receivablesClient'
import { formatCurrency } from '../../lib/format'
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
      createPerson: vi.fn(),
      renamePerson: vi.fn(),
      deletePerson: vi.fn(),
      addItem: vi.fn(),
      editItem: vi.fn(),
      deleteItem: vi.fn(),
      pardonItem: vi.fn(),
      unpardonItem: vi.fn(),
      editInstallment: vi.fn(),
      pardonInstallment: vi.fn(),
      unpardonInstallment: vi.fn(),
      suggestedAllocation: vi.fn(),
      searchExpenseCandidates: vi.fn(),
      recordPayment: vi.fn(),
      matchSuggestions: vi.fn(),
      confirmMatch: vi.fn(),
      downloadPersonPdf: vi.fn(),
    },
  }
})

const mockListPeople = vi.mocked(receivablesClient.listPeople)
const mockGetPerson = vi.mocked(receivablesClient.getPerson)
const mockMatchSuggestions = vi.mocked(receivablesClient.matchSuggestions)
const mockConfirmMatch = vi.mocked(receivablesClient.confirmMatch)
const mockDownloadPdf = vi.mocked(receivablesClient.downloadPersonPdf)
const mockSuggestedAllocation = vi.mocked(receivablesClient.suggestedAllocation)

const PEOPLE: Person[] = [
  makePerson({ id: 'p1', name: 'Ana', outstanding: '500000.00' }),
]

const ANA_DETAIL: PersonDetail = makeDetail({
  id: 'p1',
  name: 'Ana',
  outstanding: '500000.00',
  items: [
    makeItem({
      id: 'i1',
      occurredOn: '2026-08-01',
      amount: '300000.00',
      detail: 'Dinner',
    }),
    makeItem({
      id: 'i2',
      occurredOn: '2026-08-10',
      amount: '200000.00',
    }),
  ],
})

// Deliberately out of rank order so the component's score-sort is exercised: the
// weaker "Ana transfer" (0.55) precedes the stronger "Ana Perez" (0.92).
const SUGGESTIONS: MatchSuggestion[] = [
  {
    transactionId: 't-weak',
    name: 'Ana transfer',
    amount: '150000.00',
    occurredOn: '2026-08-05',
    score: 0.55,
  },
  {
    transactionId: 't-strong',
    name: 'Ana Perez',
    amount: '300000.00',
    occurredOn: '2026-08-12',
    score: 0.92,
  },
]

/** A server suggestion for `amount` spread over the given lines. */
function suggestion(
  amount: string,
  lines: SuggestedAllocationLine[],
): SuggestedAllocation {
  const allocated = lines.reduce((sum, line) => sum + Number(line.amount), 0)
  return {
    asOf: '2026-08-20',
    amount,
    allocated: allocated.toFixed(2),
    unallocated: (Number(amount) - allocated).toFixed(2),
    allocations: lines,
  }
}

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ColorModeProvider>
        <ReceivablesSection />
      </ColorModeProvider>
    </QueryClientProvider>,
  )
}

/** Expand Ana's detail panel and wait for her items to load. */
async function expandAna(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText('Ana')
  await user.click(screen.getByRole('button', { name: "Show Ana's items" }))
  await screen.findByText('Dinner')
}

describe('MatchSuggestions + PDF export (task 9)', () => {
  beforeEach(() => {
    mockListPeople.mockResolvedValue(PEOPLE)
    mockGetPerson.mockResolvedValue(ANA_DETAIL)
    mockMatchSuggestions.mockResolvedValue(SUGGESTIONS)
    mockConfirmMatch.mockResolvedValue(ANA_DETAIL)
    mockDownloadPdf.mockResolvedValue(undefined)
    // By default the server puts the whole income on the Dinner item (i1).
    mockSuggestedAllocation.mockImplementation((_personId, amount) =>
      Promise.resolve(
        suggestion(amount, [{ itemId: 'i1', installmentId: null, amount }]),
      ),
    )
  })
  afterEach(() => vi.clearAllMocks())

  test('lists a person\'s income suggestions, ranked by score', async () => {
    const user = userEvent.setup()
    renderSection()
    await expandAna(user)

    // Both suggestions render for the expanded person.
    expect(await screen.findByText('Ana Perez')).toBeInTheDocument()
    expect(screen.getByText('Ana transfer')).toBeInTheDocument()

    // Ranked highest-score-first: the strong match precedes the weak one in DOM
    // order, even though the API returned them out of order.
    const rows = screen.getAllByTestId('receivable-suggestion')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Ana Perez')
    expect(rows[0]).toHaveTextContent('Strong match')
    expect(rows[1]).toHaveTextContent('Ana transfer')
    expect(rows[1]).toHaveTextContent('Likely match')
  })

  test('reviewing a suggestion confirms it with the server-suggested allocation', async () => {
    const user = userEvent.setup()
    renderSection()
    await expandAna(user)
    await screen.findByText('Ana Perez')

    await user.click(
      screen.getByRole('button', {
        name: /Review the ARS 300\.000 income from Ana Perez on 2026-08-12/,
      }),
    )
    const dialog = within(await screen.findByRole('dialog'))
    // The matched income is shown for context.
    expect(dialog.getByText('Ana Perez')).toBeInTheDocument()

    // The rows are prefilled from the server's suggestion for the income amount.
    await waitFor(() =>
      expect(
        dialog.getByLabelText('Amount applied to the item from 2026-08-01'),
      ).toHaveValue(300000),
    )
    expect(mockSuggestedAllocation).toHaveBeenCalledWith('p1', '300000.00')

    await user.click(dialog.getByRole('button', { name: 'Confirm payment' }))

    await waitFor(() => expect(mockConfirmMatch).toHaveBeenCalledTimes(1))
    expect(mockConfirmMatch).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        matchedIncomeTransactionId: 't-strong',
        allocations: [{ itemId: 'i1', amount: '300000.00' }],
        // The API REQUIRES occurredOn (the matched income's payback date) and
        // amount (= Σ allocations); omitting them 422'd every confirm-match.
        occurredOn: '2026-08-12',
        amount: '300000.00',
      }),
    )
    // Suggestion-only: the first confirm carries no overpayment override.
    expect(mockConfirmMatch.mock.calls[0][1].allowOverpayment).toBeUndefined()
  })

  test('a confirm-match overpayment warns, then retries with allowOverpayment', async () => {
    const user = userEvent.setup()
    // First confirm 409s; the retry (allowOverpayment) succeeds.
    mockConfirmMatch
      .mockRejectedValueOnce(
        new ReceivableOverpaymentError('300000.00', '300000.00'),
      )
      .mockResolvedValueOnce(ANA_DETAIL)

    renderSection()
    await expandAna(user)
    await screen.findByText('Ana Perez')

    await user.click(
      screen.getByRole('button', {
        name: /Review the ARS 300\.000 income from Ana Perez on 2026-08-12/,
      }),
    )
    const dialog = within(await screen.findByRole('dialog'))
    const confirm = dialog.getByRole('button', { name: 'Confirm payment' })
    await waitFor(() => expect(confirm).toBeEnabled())
    await user.click(confirm)

    // The confirm-warning surfaces (ADR-206).
    expect(await dialog.findByText('More than owed')).toBeInTheDocument()
    await waitFor(() => expect(mockConfirmMatch).toHaveBeenCalledTimes(1))

    await user.click(dialog.getByRole('button', { name: 'Record anyway' }))

    await waitFor(() => expect(mockConfirmMatch).toHaveBeenCalledTimes(2))
    expect(mockConfirmMatch.mock.calls[1][1]).toEqual(
      expect.objectContaining({ allowOverpayment: true }),
    )
  })

  test('shows a calm empty state when there are no suggestions', async () => {
    mockMatchSuggestions.mockResolvedValue([])
    const user = userEvent.setup()
    renderSection()
    await expandAna(user)

    expect(
      await screen.findByText(/No suggested payments right now/),
    ).toBeInTheDocument()
    // Amount helper import kept meaningful — no suggestion rows rendered.
    expect(screen.queryAllByTestId('receivable-suggestion')).toHaveLength(0)
    // Sanity: the shared formatter is wired the same way the rows use it.
    expect(formatCurrency(300000, 'ARS')).toBe('ARS 300.000')
  })

  test('the Export PDF button calls the authed download helper', async () => {
    const user = userEvent.setup()
    renderSection()
    await expandAna(user)

    await user.click(
      await screen.findByRole('button', {
        name: "Export Ana's receivables as a PDF",
      }),
    )

    // The PDF follows the app locale (ADR-208 amendment): the active UI language
    // is passed through as the 3rd arg. The suite is en-pinned (ADR-105).
    await waitFor(() =>
      expect(mockDownloadPdf).toHaveBeenCalledWith('p1', 'Ana', 'en'),
    )
  })

  test('the Export PDF button shows a pending label, then a calm dismissible error when the download fails', async () => {
    const user = userEvent.setup()
    // A download we can leave in-flight (to assert the pending/disabled state)
    // and then reject (to assert the calm inline error, ADR-037).
    let rejectDownload!: (reason?: unknown) => void
    mockDownloadPdf.mockReturnValueOnce(
      new Promise<void>((_, reject) => {
        rejectDownload = reject
      }),
    )
    renderSection()
    await expandAna(user)

    const exportButton = await screen.findByRole('button', {
      name: "Export Ana's receivables as a PDF",
    })
    await user.click(exportButton)

    // While the fetch is in flight the button disables + swaps to a pending label.
    expect(exportButton).toBeDisabled()
    expect(screen.getByText(/Preparing PDF/)).toBeInTheDocument()

    // The download fails → a calm inline error surfaces (never throws into render).
    rejectDownload(new Error('boom'))
    expect(
      await screen.findByText(/We couldn't create the PDF/),
    ).toBeInTheDocument()
    // Back to idle: the button re-enables so the owner can retry.
    await waitFor(() => expect(exportButton).toBeEnabled())

    // The error is dismissible (ADR-037).
    await user.click(screen.getByRole('button', { name: /close/i }))
    await waitFor(() =>
      expect(screen.queryByText(/We couldn't create the PDF/)).toBeNull(),
    )
  })

  test('labels a low-score suggestion "Possible match" (relevance reads without color, ADR-019)', async () => {
    // Below the 0.5 "likely" floor → the weakest band, so the ranking still reads
    // from the WORD alone (never color, ADR-019). Completes the Strong/Likely set.
    mockMatchSuggestions.mockResolvedValue([
      {
        transactionId: 't-possible',
        name: 'Maybe Ana',
        amount: '120000.00',
        occurredOn: '2026-08-03',
        score: 0.3,
      },
    ])
    const user = userEvent.setup()
    renderSection()
    await expandAna(user)

    const row = await screen.findByTestId('receivable-suggestion')
    expect(row).toHaveTextContent('Maybe Ana')
    expect(row).toHaveTextContent('Possible match')
  })

  test('shows a calm error state when suggestions fail to load', async () => {
    mockMatchSuggestions.mockRejectedValue(new Error('boom'))
    const user = userEvent.setup()
    renderSection()
    await expandAna(user)

    expect(await screen.findByText("Can't load suggestions")).toBeInTheDocument()
    expect(screen.queryAllByTestId('receivable-suggestion')).toHaveLength(0)
  })

  test('prefills a suggestion that spills across open items, in the server\'s fill order', async () => {
    // The server fills flat items newest-first: the 400.000 income covers the
    // newer item (i2, 200.000) and spills the rest into the older one (i1).
    mockMatchSuggestions.mockResolvedValue([
      {
        transactionId: 't-spill',
        name: 'Ana Perez',
        amount: '400000.00',
        occurredOn: '2026-08-12',
        score: 0.9,
      },
    ])
    mockSuggestedAllocation.mockResolvedValue(
      suggestion('400000.00', [
        { itemId: 'i2', installmentId: null, amount: '200000.00' },
        { itemId: 'i1', installmentId: null, amount: '200000.00' },
      ]),
    )
    const user = userEvent.setup()
    renderSection()
    await expandAna(user)

    await user.click(
      await screen.findByRole('button', {
        name: /Review the ARS 400\.000 income from Ana Perez/,
      }),
    )
    const dialog = within(await screen.findByRole('dialog'))

    await waitFor(() =>
      expect(
        dialog.getByLabelText('Amount applied to the item from 2026-08-10'),
      ).toHaveValue(200000),
    )
    expect(
      dialog.getByLabelText('Amount applied to the item from 2026-08-01'),
    ).toHaveValue(200000)

    await user.click(dialog.getByRole('button', { name: 'Confirm payment' }))

    await waitFor(() => expect(mockConfirmMatch).toHaveBeenCalledTimes(1))
    expect(mockConfirmMatch).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        matchedIncomeTransactionId: 't-spill',
        amount: '400000.00',
        allocations: [
          { itemId: 'i1', amount: '200000.00' },
          { itemId: 'i2', amount: '200000.00' },
        ],
      }),
    )
  })

  test('excludes a pardoned item from the confirm-match allocation list (ADR-210)', async () => {
    // Ana's first item (2026-08-01) is forgiven, so only the second (2026-08-10,
    // 200.000 remaining) is a valid match target; the server suggests just it.
    mockGetPerson.mockResolvedValue({
      ...ANA_DETAIL,
      outstanding: '200000.00',
      items: [
        { ...ANA_DETAIL.items[0], pardoned: true, dueOutstanding: '0.00' },
        ANA_DETAIL.items[1],
      ],
    })
    mockSuggestedAllocation.mockResolvedValue(
      suggestion('300000.00', [
        { itemId: 'i2', installmentId: null, amount: '200000.00' },
      ]),
    )
    const user = userEvent.setup()
    renderSection()
    await expandAna(user)
    await screen.findByText('Ana Perez')

    await user.click(
      screen.getByRole('button', {
        name: /Review the ARS 300\.000 income from Ana Perez on 2026-08-12/,
      }),
    )
    const dialog = within(await screen.findByRole('dialog'))

    await waitFor(() =>
      expect(
        dialog.getByLabelText('Amount applied to the item from 2026-08-10'),
      ).toHaveValue(200000),
    )
    // The forgiven item is not a match target.
    expect(
      dialog.queryByLabelText('Amount applied to the item from 2026-08-01'),
    ).not.toBeInTheDocument()
    // The unassigned part of the income is called out, never silently dropped:
    // confirming needs an explicit acknowledgement that it can't be re-matched.
    expect(
      dialog.getByText(
        "ARS 100.000 of this ARS 300.000 income isn't assigned to a debt yet.",
      ),
    ).toBeInTheDocument()
    const confirm = dialog.getByRole('button', { name: 'Confirm payment' })
    expect(confirm).toBeDisabled()
    await user.click(
      dialog.getByRole('checkbox', {
        name: "Claim this ARS 300.000 income for only ARS 200.000. The rest can't be matched to anyone again.",
      }),
    )
    await user.click(confirm)

    await waitFor(() => expect(mockConfirmMatch).toHaveBeenCalledTimes(1))
    expect(mockConfirmMatch).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        matchedIncomeTransactionId: 't-strong',
        amount: '200000.00',
        allocations: [{ itemId: 'i2', amount: '200000.00' }],
      }),
    )
  })

  test('lets the owner edit a prefilled allocation before confirming', async () => {
    const user = userEvent.setup()
    renderSection()
    await expandAna(user)
    await screen.findByText('Ana Perez')

    // The strong 300.000 income is suggested onto the first item; the owner trims it.
    await user.click(
      screen.getByRole('button', {
        name: /Review the ARS 300\.000 income from Ana Perez on 2026-08-12/,
      }),
    )
    const dialog = within(await screen.findByRole('dialog'))
    const firstItem = dialog.getByLabelText(
      'Amount applied to the item from 2026-08-01',
    )
    // `type="number"` input → toHaveValue reads the numeric value.
    await waitFor(() => expect(firstItem).toHaveValue(300000))
    await user.clear(firstItem)
    await user.type(firstItem, '25000')

    // Claiming the income for less needs consent — and consent covers specific
    // amounts: changing the rows again withdraws it.
    const confirm = dialog.getByRole('button', { name: 'Confirm payment' })
    const consent = () =>
      dialog.getByRole('checkbox', { name: /Claim this ARS 300\.000 income for only/ })
    await user.click(consent())
    expect(confirm).toBeEnabled()
    await user.type(firstItem, '0')
    expect(consent()).not.toBeChecked()
    expect(confirm).toBeDisabled()
    await user.click(consent())

    await user.click(confirm)

    await waitFor(() => expect(mockConfirmMatch).toHaveBeenCalledTimes(1))
    // The edited amount is what gets sent, serialized to the 2-decimal string.
    expect(mockConfirmMatch).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        matchedIncomeTransactionId: 't-strong',
        allocations: [{ itemId: 'i1', amount: '250000.00' }],
      }),
    )
  })

  test('rows adding up to MORE than the income cannot be confirmed', async () => {
    const user = userEvent.setup()
    renderSection()
    await expandAna(user)
    await screen.findByText('Ana Perez')

    await user.click(
      screen.getByRole('button', {
        name: /Review the ARS 300\.000 income from Ana Perez on 2026-08-12/,
      }),
    )
    const dialog = within(await screen.findByRole('dialog'))
    const firstItem = dialog.getByLabelText(
      'Amount applied to the item from 2026-08-01',
    )
    await waitFor(() => expect(firstItem).toHaveValue(300000))
    await user.type(
      dialog.getByLabelText('Amount applied to the item from 2026-08-10'),
      '50000',
    )

    expect(
      dialog.getByText(
        'The lines add up to ARS 50.000 more than this ARS 300.000 income. Lower them to confirm.',
      ),
    ).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: 'Confirm payment' })).toBeDisabled()
    expect(mockConfirmMatch).not.toHaveBeenCalled()
  })

  test('targets cuotas of an installment item and sends their installmentId (ADR-221)', async () => {
    // Ana owes a 3-cuota plan: cuota 1 is due, cuotas 2-3 are upcoming.
    mockGetPerson.mockResolvedValue(
      makeDetail({
        id: 'p1',
        name: 'Ana',
        outstanding: '100000.00',
        upcomingTotal: '200000.00',
        items: [
          makeItem({
            id: 'plan',
            occurredOn: '2026-07-20',
            amount: '300000.00',
            detail: 'Dinner',
            dueOutstanding: '100000.00',
            upcomingTotal: '200000.00',
            installments: [
              makeCuota({ id: 'c1', index: 1, dueOn: '2026-08-20', amount: '100000.00', status: 'due' }),
              makeCuota({ id: 'c2', index: 2, dueOn: '2026-09-20', amount: '100000.00', status: 'upcoming' }),
              makeCuota({ id: 'c3', index: 3, dueOn: '2026-10-20', amount: '100000.00', status: 'upcoming' }),
            ],
          }),
        ],
      }),
    )
    mockSuggestedAllocation.mockResolvedValue(
      suggestion('300000.00', [
        { itemId: 'plan', installmentId: 'c1', amount: '100000.00' },
      ]),
    )
    const user = userEvent.setup()
    renderSection()
    await expandAna(user)
    await screen.findByText('Ana Perez')

    await user.click(
      screen.getByRole('button', {
        name: /Review the ARS 300\.000 income from Ana Perez on 2026-08-12/,
      }),
    )
    const dialog = within(await screen.findByRole('dialog'))

    // The due cuota is a labeled row, prefilled from the suggestion.
    expect(dialog.getByText('Dinner · Cuota 1/3')).toBeInTheDocument()
    await waitFor(() =>
      expect(
        dialog.getByLabelText(
          'Amount applied to cuota 1/3 of the item from 2026-07-20',
        ),
      ).toHaveValue(100000),
    )
    // Upcoming cuotas are tucked behind a toggle (paying them is early).
    expect(
      dialog.queryByLabelText(
        'Amount applied to cuota 2/3 of the item from 2026-07-20',
      ),
    ).not.toBeInTheDocument()

    // The other 200.000 of the income: apply it ahead to the upcoming cuotas.
    expect(dialog.getByRole('button', { name: 'Confirm payment' })).toBeDisabled()
    await user.click(
      dialog.getByRole('button', { name: 'Apply the rest to upcoming cuotas' }),
    )
    expect(
      dialog.getByLabelText(
        'Amount applied to cuota 2/3 of the item from 2026-07-20',
      ),
    ).toHaveValue(100000)
    await user.click(dialog.getByRole('button', { name: 'Confirm payment' }))

    await waitFor(() => expect(mockConfirmMatch).toHaveBeenCalledTimes(1))
    expect(mockConfirmMatch).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        amount: '300000.00',
        allocations: [
          { itemId: 'plan', installmentId: 'c1', amount: '100000.00' },
          { itemId: 'plan', installmentId: 'c2', amount: '100000.00' },
          { itemId: 'plan', installmentId: 'c3', amount: '100000.00' },
        ],
      }),
    )
  })
})
