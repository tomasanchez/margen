/**
 * Unit tests for task 9's income match-suggestions review + per-person PDF export
 * (ADR-206/207/209).
 *
 * Drives the whole receivables section against a MOCKED {@link receivablesClient}
 * (the network boundary) so the real TanStack Query hooks + the suggestion review /
 * confirm-match / PDF-export flows run end to end, exactly like
 * {@link ReceivablesSection.test.tsx}:
 *
 *  - suggestions render for an expanded person, ranked by score (highest first);
 *  - reviewing a suggestion opens the confirm dialog, which allocates across the
 *    person's open items and settles it via `confirmMatch` (ADR-206/207);
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
} from '../../api/receivablesClient'
import { formatCurrency } from '../../lib/format'

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
const mockMatchSuggestions = vi.mocked(receivablesClient.matchSuggestions)
const mockConfirmMatch = vi.mocked(receivablesClient.confirmMatch)
const mockDownloadPdf = vi.mocked(receivablesClient.downloadPersonPdf)

const PEOPLE: Person[] = [{ id: 'p1', name: 'Ana', outstanding: '500000.00' }]

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
    mockConfirmMatch.mockResolvedValue({
      id: 'pay-m1',
      occurredOn: '2026-08-12',
      amount: '300000.00',
      source: 'matched_income',
      matchedIncomeTransactionId: 't-strong',
      allocations: [{ itemId: 'i1', amount: '300000.00' }],
    })
    mockDownloadPdf.mockResolvedValue(undefined)
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

  test('reviewing a suggestion confirms it, allocated across open items', async () => {
    const user = userEvent.setup()
    renderSection()
    await expandAna(user)
    await screen.findByText('Ana Perez')

    // Review the strong (300.000) suggestion — its default allocation greedily
    // fills the first open item (Dinner, 300.000 remaining) to the hilt.
    await user.click(
      screen.getByRole('button', {
        name: /Review the ARS 300\.000 income from Ana Perez on 2026-08-12/,
      }),
    )
    const dialog = within(await screen.findByRole('dialog'))
    // The matched income is shown for context.
    expect(dialog.getByText('Ana Perez')).toBeInTheDocument()

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
      .mockResolvedValueOnce({
        id: 'pay-m2',
        occurredOn: '2026-08-12',
        amount: '300000.00',
        source: 'matched_income',
        matchedIncomeTransactionId: 't-strong',
        allocations: [{ itemId: 'i1', amount: '300000.00' }],
      })

    renderSection()
    await expandAna(user)
    await screen.findByText('Ana Perez')

    await user.click(
      screen.getByRole('button', {
        name: /Review the ARS 300\.000 income from Ana Perez on 2026-08-12/,
      }),
    )
    const dialog = within(await screen.findByRole('dialog'))
    await user.click(dialog.getByRole('button', { name: 'Confirm payment' }))

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

  test('seeds a greedy default allocation that spills across open items until the income is exhausted', async () => {
    // Income (400.000) overflows the first open item (300.000 remaining) and
    // spills the leftover 100.000 into the second (200.000 remaining) — the
    // greedy one-click default (ADR-206) the owner can still edit.
    mockMatchSuggestions.mockResolvedValue([
      {
        transactionId: 't-spill',
        name: 'Ana Perez',
        amount: '400000.00',
        occurredOn: '2026-08-12',
        score: 0.9,
      },
    ])
    const user = userEvent.setup()
    renderSection()
    await expandAna(user)

    await user.click(
      await screen.findByRole('button', {
        name: /Review the ARS 400\.000 income from Ana Perez/,
      }),
    )
    const dialog = within(await screen.findByRole('dialog'))

    // First item filled to the hilt, the overflow seeded into the second. The
    // inputs are now `type="number"`, so toHaveValue reads the numeric value.
    expect(
      dialog.getByLabelText('Amount applied to the item from 2026-08-01'),
    ).toHaveValue(300000)
    expect(
      dialog.getByLabelText('Amount applied to the item from 2026-08-10'),
    ).toHaveValue(100000)

    await user.click(dialog.getByRole('button', { name: 'Confirm payment' }))

    await waitFor(() => expect(mockConfirmMatch).toHaveBeenCalledTimes(1))
    expect(mockConfirmMatch).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        matchedIncomeTransactionId: 't-spill',
        allocations: [
          { itemId: 'i1', amount: '300000.00' },
          { itemId: 'i2', amount: '100000.00' },
        ],
      }),
    )
  })

  test('excludes a pardoned item from the confirm-match allocation list (ADR-210)', async () => {
    // Ana's first item (2026-08-01) is forgiven, so only the second (2026-08-10,
    // 200.000 remaining) is a valid match target: the 300.000 income seeds it to
    // 200.000 and the pardoned item never appears.
    mockGetPerson.mockResolvedValue({
      ...ANA_DETAIL,
      outstanding: '200000.00',
      items: [
        { ...ANA_DETAIL.items[0], pardoned: true },
        ANA_DETAIL.items[1],
      ],
    })
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

    // Only the open item is allocatable, seeded up to its remaining. The input
    // is now `type="number"`, so toHaveValue reads the numeric value.
    expect(
      dialog.getByLabelText('Amount applied to the item from 2026-08-10'),
    ).toHaveValue(200000)
    // The forgiven item is not a match target.
    expect(
      dialog.queryByLabelText('Amount applied to the item from 2026-08-01'),
    ).not.toBeInTheDocument()

    await user.click(dialog.getByRole('button', { name: 'Confirm payment' }))

    await waitFor(() => expect(mockConfirmMatch).toHaveBeenCalledTimes(1))
    expect(mockConfirmMatch).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        matchedIncomeTransactionId: 't-strong',
        allocations: [{ itemId: 'i2', amount: '200000.00' }],
      }),
    )
  })

  test('lets the owner edit a seeded allocation before confirming', async () => {
    const user = userEvent.setup()
    renderSection()
    await expandAna(user)
    await screen.findByText('Ana Perez')

    // The strong 300.000 income seeds the first item to 300.000; the owner trims it.
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
    expect(firstItem).toHaveValue(300000)
    await user.clear(firstItem)
    await user.type(firstItem, '250000')

    await user.click(dialog.getByRole('button', { name: 'Confirm payment' }))

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
})
