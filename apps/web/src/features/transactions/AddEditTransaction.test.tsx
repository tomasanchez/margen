/**
 * Interaction tests for the Add/Edit transaction flow (ADR-018, ADR-019).
 *
 * Drives the flow through its real seam: a tiny trigger calls openAdd(), the
 * AddTransactionProvider renders the shared AddEditForm inside its Dialog/Drawer,
 * and the tests assert the AC-critical toggles:
 *   - switching Expense <-> Invoice/income shows/hides the income-only
 *     "Counts toward Monotributo" control;
 *   - selecting USD reveals the FX context line (converted ARS + MEP rate) and
 *     its rate-edit affordance.
 *
 * Queries prefer roles/labels per ADR-019. No store mutation happens here (we
 * never submit), so no re-seed is needed.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '../../test/renderWithProviders'
import { useAddTransaction } from './addContext'

// Mock the HTTP client so the flow never touches a real backend (ADR-038), and
// the dolarapi FX adapter so no real network is hit (ADR-044). The suggested
// MEP rate is controllable per-test via `fxMock`.
const { createMock, fxMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  fxMock: vi.fn(),
}))

vi.mock('../../api/transactionsClient', () => ({
  transactionsClient: {
    list: vi.fn(() => Promise.resolve([])),
    create: createMock,
    update: vi.fn(),
    remove: vi.fn(),
  },
}))

vi.mock('../../api/fxClient', () => ({
  fetchSuggestedMepRate: fxMock,
}))

beforeEach(() => {
  // Default: dolarapi suggests an MEP rate of 1245 (the seeded prototype value).
  fxMock.mockResolvedValue(1245)
})

afterEach(() => {
  vi.clearAllMocks()
})

import type { AddPrefill } from './addContext'

/** A trigger that opens the Add/Edit flow with an optional prefill. */
function OpenAddTrigger({ prefill }: { prefill?: AddPrefill }) {
  const { openAdd } = useAddTransaction()
  return (
    <button type="button" onClick={() => openAdd(prefill)}>
      open add
    </button>
  )
}

/** Open the Add/Edit dialog and return the dialog element + a userEvent session. */
async function openAddDialog(prefill?: AddPrefill) {
  const user = userEvent.setup()
  renderWithProviders(<OpenAddTrigger prefill={prefill} />, {
    withAddProvider: true,
  })

  await user.click(screen.getByRole('button', { name: 'open add' }))
  // The Dialog (desktop, jsdom's default width) is labelled by the form title.
  const dialog = await screen.findByRole('dialog')
  return { user, dialog }
}

/** Today as a local ISO YYYY-MM-DD string (mirrors the form's `todayIsoDate`). */
function todayIso(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

describe('Add flow — type toggles required fields', () => {
  test('Expense hides the Monotributo control; switching to income shows it', async () => {
    const { user, dialog } = await openAddDialog()
    const form = within(dialog)

    // Opens on Expense by default (concept default).
    expect(
      form.getByRole('heading', { name: 'New expense' }),
    ).toBeInTheDocument()
    expect(
      form.queryByText('Counts toward Monotributo'),
    ).not.toBeInTheDocument()
    // The expense category picker is present for expenses.
    expect(form.getByText('Category')).toBeInTheDocument()

    // Switch to Invoice / income.
    await user.click(form.getByRole('button', { name: 'Invoice / income' }))

    expect(
      form.getByRole('heading', { name: 'New invoice · income' }),
    ).toBeInTheDocument()
    // The income-only Monotributo switch now appears.
    expect(form.getByText('Counts toward Monotributo')).toBeInTheDocument()
    // ...and the expense-only Category section is gone.
    expect(form.queryByText('Category')).not.toBeInTheDocument()

    // Switching back to Expense hides it again.
    await user.click(form.getByRole('button', { name: 'Expense' }))
    expect(
      form.queryByText('Counts toward Monotributo'),
    ).not.toBeInTheDocument()
  })
})

describe('Add flow — USD suggests then confirms the MEP rate (ADR-044/045)', () => {
  test('choosing USD fetches + pre-fills the suggested MEP rate, then converts', async () => {
    const { user, dialog } = await openAddDialog()
    const form = within(dialog)

    // No FX line while the (default) currency is ARS.
    expect(form.queryByText(/at MEP/)).not.toBeInTheDocument()

    // Enter an amount, then switch the currency toggle to USD.
    const amount = form.getByLabelText(/^Amount in /)
    await user.type(amount, '500')
    await user.click(form.getByRole('button', { name: 'USD' }))

    // The suggested rate (1245) is fetched and pre-filled into the rate field.
    const rateField = await form.findByLabelText('MEP rate')
    await waitFor(() => expect(rateField).toHaveValue('1245'))
    expect(fxMock).toHaveBeenCalled()

    // FX context line: 500 USD * MEP 1245 = ARS 622.500 (es-AR grouping), and
    // the source reads MEP because the suggestion is unedited.
    expect(
      await form.findByText('≈ ARS 622.500 at MEP 1.245'),
    ).toBeInTheDocument()
    expect(
      form.getByText('Suggested MEP rate — confirm or edit.'),
    ).toBeInTheDocument()
  })

  test('confirming the suggested rate sends fxRateType=MEP and amountNum=usd*rate', async () => {
    createMock.mockResolvedValueOnce({})
    const { user, dialog } = await openAddDialog()
    const form = within(dialog)

    await user.type(form.getByLabelText(/^Amount in /), '500')
    await user.click(form.getByRole('button', { name: 'USD' }))
    await waitFor(() =>
      expect(form.getByLabelText('MEP rate')).toHaveValue('1245'),
    )

    // Save without touching the suggestion → MEP.
    await user.click(form.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))

    const [input] = createMock.mock.calls[0]
    expect(input.currency).toBe('USD')
    expect(input.usd).toBe(500)
    expect(input.rate).toBe(1245)
    expect(input.fxRateType).toBe('MEP')
    expect(input.amountNum).toBe(622500)
    expect(typeof input.fxRateAsOf).toBe('string')
  })

  test('editing the rate switches the source to manual and recomputes amountNum', async () => {
    createMock.mockResolvedValueOnce({})
    const { user, dialog } = await openAddDialog()
    const form = within(dialog)

    await user.type(form.getByLabelText(/^Amount in /), '100')
    await user.click(form.getByRole('button', { name: 'USD' }))
    const rateField = await form.findByLabelText('MEP rate')
    await waitFor(() => expect(rateField).toHaveValue('1245'))

    // Override the suggestion.
    await user.clear(rateField)
    await user.type(rateField, '1300')

    // 100 USD * 1300 = ARS 130.000, now labelled "manual".
    expect(
      await form.findByText('≈ ARS 130.000 at manual 1.300'),
    ).toBeInTheDocument()

    await user.click(form.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    const [input] = createMock.mock.calls[0]
    expect(input.fxRateType).toBe('manual')
    expect(input.rate).toBe(1300)
    expect(input.amountNum).toBe(130000)
  })

  test('editing an existing USD row prefills the stored rate (no re-suggest)', async () => {
    const { dialog } = await openAddDialog({
      id: 'usd-edit-1',
      name: 'Invoice · Atlas Co.',
      type: 'income',
      kind: 'invoice',
      currency: 'USD',
      category: 'Income',
      bank: 'Transfer',
      amountNum: 650000,
      usd: 500,
      rate: 1300,
      fxRateType: 'manual',
      fxRateAsOf: '2026-06-12T12:00:00.000Z',
      occurredOn: '2026-06-12',
      dispDate: 'Jun 12',
    })
    const form = within(dialog)

    // The stored rate is loaded; no suggestion fetch fires (it already has one).
    expect(form.getByLabelText('MEP rate')).toHaveValue('1300')
    expect(fxMock).not.toHaveBeenCalled()
    // The stored source is preserved until the user edits the rate.
    expect(
      form.getByText('≈ ARS 650.000 at manual 1.300'),
    ).toBeInTheDocument()
  })

  test('USD cannot be saved without a rate (required)', async () => {
    // dolarapi is down: no suggestion arrives.
    fxMock.mockResolvedValue(null)
    const { user, dialog } = await openAddDialog()
    const form = within(dialog)

    await user.type(form.getByLabelText(/^Amount in /), '500')
    await user.click(form.getByRole('button', { name: 'USD' }))

    // The fetch failed → manual-entry prompt, no silent rate, Save disabled.
    expect(
      await form.findByText("Couldn't fetch a rate — enter it manually."),
    ).toBeInTheDocument()
    expect(form.getByLabelText('MEP rate')).toHaveValue('')
    expect(form.getByRole('button', { name: /^Save$/ })).toBeDisabled()
    expect(createMock).not.toHaveBeenCalled()

    // Entering a manual rate enables Save and records it as manual.
    await user.type(form.getByLabelText('MEP rate'), '1300')
    expect(form.getByRole('button', { name: /^Save$/ })).toBeEnabled()
  })
})

describe('Add flow — a save failure keeps the form open', () => {
  test('a rejected create surfaces an error notice without closing the form', async () => {
    createMock.mockRejectedValueOnce(new Error('save failed'))
    const { user, dialog } = await openAddDialog()
    const form = within(dialog)

    // Enter a valid ARS amount, then save.
    await user.type(form.getByLabelText(/^Amount in /), '5000')
    await user.click(form.getByRole('button', { name: /^Save$/ }))

    // The calm error notice appears and the form is still open (ADR-036/037).
    expect(
      await screen.findByText(
        "We couldn't save your transaction. Please try again.",
      ),
    ).toBeInTheDocument()
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})

describe('Date picker (ADR-041)', () => {
  test('shows a date input defaulting to today with max=today', async () => {
    const { dialog } = await openAddDialog()
    const date = within(dialog).getByLabelText('Transaction date')

    expect(date).toHaveAttribute('type', 'date')
    expect(date).toHaveValue(todayIso())
    expect(date).toHaveAttribute('max', todayIso())
  })

  test('creating sends occurredOn equal to the picked (backdated) date', async () => {
    createMock.mockResolvedValueOnce({})
    const { user, dialog } = await openAddDialog()
    const form = within(dialog)

    // Pick an older date, enter an amount, save.
    const date = form.getByLabelText('Transaction date')
    await user.clear(date)
    await user.type(date, '2026-02-09')
    await user.type(form.getByLabelText(/^Amount in /), '5000')
    await user.click(form.getByRole('button', { name: /^Save$/ }))

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    const [input] = createMock.mock.calls[0]
    expect(input.occurredOn).toBe('2026-02-09')
    // The display label is derived from the picked date, not "today".
    expect(input.dispDate).toBe('Feb 09')
  })

  test('editing prefills the date from the row occurredOn', async () => {
    const { dialog } = await openAddDialog({
      id: 'edit-1',
      name: 'Old expense',
      type: 'expense',
      kind: 'expense',
      currency: 'ARS',
      category: 'Food',
      bank: 'Transfer',
      amountNum: 5000,
      occurredOn: '2026-01-20',
      dispDate: 'Jan 20',
    })

    expect(within(dialog).getByLabelText('Transaction date')).toHaveValue(
      '2026-01-20',
    )
  })
})
