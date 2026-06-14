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
// MEP + official rates are controllable per-test via `fxMock`.
const { createMock, fxMock, fetchSettingsMock, monotributoMock } = vi.hoisted(
  () => ({
    createMock: vi.fn(),
    fxMock: vi.fn(),
    fetchSettingsMock: vi.fn(),
    monotributoMock: vi.fn(),
  }),
)

vi.mock('../../api/transactionsClient', () => ({
  transactionsClient: {
    list: vi.fn(() => Promise.resolve([])),
    create: createMock,
    update: vi.fn(),
    remove: vi.fn(),
  },
}))

vi.mock('../../api/fxClient', () => ({
  fetchSuggestedRates: fxMock,
}))

// The Expense path reads the Monotributo snapshot to autofill the monthly cuota
// shortcut. Mock the client so the snapshot (current category + scale) is
// controllable per-test via `monotributoMock` and no real backend is hit.
vi.mock('../../api/monotributoClient', () => ({
  fetchMonotributo: monotributoMock,
}))

// The form now reads the configured FX default from settings (ADR-057). Mock the
// settings client so the default source is controllable per-test via
// `fetchSettingsMock`; the default below is a stable MEP (the existing
// assertions assume the MEP default), with one test overriding it to official.
vi.mock('../../api/settingsClient', async () => {
  const actual = await vi.importActual<
    typeof import('../../api/settingsClient')
  >('../../api/settingsClient')
  return {
    ...actual,
    fetchSettings: fetchSettingsMock,
  }
})

beforeEach(() => {
  // Default: dolarapi suggests MEP 1245 + official 1045 (seeded prototype values).
  fxMock.mockResolvedValue({ mep: 1245, official: 1045 })
  // Default: the configured FX default is MEP (existing behavior).
  fetchSettingsMock.mockResolvedValue({
    preferredDisplayCurrency: 'ARS',
    fxDefaultRateType: 'MEP',
    monotributoCurrentCategory: 'C',
    monotributoActivityType: 'services',
  })
  // Default: the user is on category C / services, whose monthly cuota is
  // ARS 56.502 (the services fee for the matching scale row).
  monotributoMock.mockResolvedValue(makeSnapshot('C', 'services'))
})

/** A minimal Monotributo snapshot with a known category, activity type + scale. */
function makeSnapshot(category: string, activityType: string) {
  return {
    current: {
      category,
      activityType,
      annualLimit: 21_113_697,
      used: 0,
      remaining: 21_113_697,
      percentUsed: 0,
      ratio: 0,
      status: 'safe',
      projectedCategory: category,
      projectionNote: '',
      periodStart: '2025-07-01',
      periodEnd: '2026-06-30',
    },
    previous: null,
    scale: [
      {
        letter: 'B',
        annualCeiling: 15_058_448,
        cuotaServicios: 48_251,
        cuotaBienes: 48_251,
      },
      {
        letter: 'C',
        annualCeiling: 21_113_697,
        cuotaServicios: 56_502,
        cuotaBienes: 55_227,
      },
    ],
    invoices: [],
  }
}

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

describe('Add flow — Monotributo cuota shortcut (expense path)', () => {
  test('clicking the button autofills the cuota, Taxes category + name, then saves as a plain ARS expense', async () => {
    createMock.mockResolvedValueOnce({})
    const { user, dialog } = await openAddDialog()
    const form = within(dialog)

    // The expense path shows the cuota button labelled with the ARS amount
    // (category C / services → 56.502).
    const cuotaButton = await form.findByRole('button', {
      name: 'Load Monotributo cuota (ARS 56.502)',
    })
    await waitFor(() => expect(cuotaButton).toBeEnabled())
    await user.click(cuotaButton)

    // The amount field is filled with the cuota and the Taxes chip is selected.
    expect(form.getByLabelText(/^Amount in /)).toHaveValue('56502')
    expect(form.getByRole('button', { name: 'Taxes' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    await user.click(form.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))

    const [input] = createMock.mock.calls[0]
    expect(input.type).toBe('expense')
    expect(input.currency).toBe('ARS')
    expect(input.category).toBe('Taxes')
    expect(input.name).toBe('Monotributo C')
    expect(input.amountNum).toBe(56502)
    expect(input.usd).toBeUndefined()
    expect(input.document).toBeUndefined()
  })

  test('a goods activity uses the cuotaBienes fee', async () => {
    monotributoMock.mockResolvedValue(makeSnapshot('C', 'goods'))
    const { user, dialog } = await openAddDialog()
    const form = within(dialog)

    // Category C / goods → cuotaBienes 55.227.
    const cuotaButton = await form.findByRole('button', {
      name: 'Load Monotributo cuota (ARS 55.227)',
    })
    await user.click(cuotaButton)
    expect(form.getByLabelText(/^Amount in /)).toHaveValue('55227')
  })

  test('the cuota button is absent on the income/invoice path', async () => {
    const { user, dialog } = await openAddDialog()
    const form = within(dialog)

    await user.click(form.getByRole('button', { name: 'Invoice / income' }))
    expect(
      form.queryByRole('button', { name: /Load Monotributo cuota/ }),
    ).not.toBeInTheDocument()
  })
})

describe('Add flow — USD picks an explicit FX source (ADR-044/045)', () => {
  test('choosing USD fetches both rates + pre-fills the default (MEP), then converts', async () => {
    const { user, dialog } = await openAddDialog()
    const form = within(dialog)

    // No FX line while the (default) currency is ARS.
    expect(form.queryByText(/at MEP/)).not.toBeInTheDocument()

    // Enter an amount, then switch the currency toggle to USD.
    const amount = form.getByLabelText(/^Amount in /)
    await user.type(amount, '500')
    await user.click(form.getByRole('button', { name: 'USD' }))

    // The default source (MEP, 1245) is fetched and pre-filled into the rate field.
    const rateField = await form.findByLabelText('FX rate')
    await waitFor(() => expect(rateField).toHaveValue('1245'))
    expect(fxMock).toHaveBeenCalled()

    // FX context line: 500 USD * MEP 1245 = ARS 622.500 (es-AR grouping), and
    // the source reads MEP because that is the default selection.
    expect(
      await form.findByText('≈ ARS 622.500 at MEP 1.245'),
    ).toBeInTheDocument()
    expect(
      form.getByText('Suggested MEP rate — confirm or edit.'),
    ).toBeInTheDocument()
    // Both source options label their suggested value.
    expect(
      form.getByRole('button', { name: 'MEP 1.245' }),
    ).toBeInTheDocument()
    expect(
      form.getByRole('button', { name: 'Official 1.045' }),
    ).toBeInTheDocument()
  })

  test('with settings.fxDefaultRateType=official, USD defaults the source to Official (ADR-057)', async () => {
    // The configured FX default is Official for this user.
    fetchSettingsMock.mockResolvedValue({
      preferredDisplayCurrency: 'ARS',
      fxDefaultRateType: 'official',
      monotributoCurrentCategory: 'C',
      monotributoActivityType: 'services',
    })
    const { user, dialog } = await openAddDialog()
    const form = within(dialog)

    await user.type(form.getByLabelText(/^Amount in /), '500')
    await user.click(form.getByRole('button', { name: 'USD' }))

    // The default source is the configured Official rate (1045), pre-filled into
    // the rate field — NOT the MEP default the other tests assume.
    const rateField = await form.findByLabelText('FX rate')
    await waitFor(() => expect(rateField).toHaveValue('1045'))

    // The Official option is the pressed/selected source and the subline reads
    // "official"; 500 USD * 1045 = ARS 522.500.
    expect(
      form.getByRole('button', { name: 'Official 1.045', pressed: true }),
    ).toBeInTheDocument()
    expect(
      await form.findByText('≈ ARS 522.500 at official 1.045'),
    ).toBeInTheDocument()
  })

  test('confirming the default sends fxRateType=MEP and amountNum=usd*rate', async () => {
    createMock.mockResolvedValueOnce({})
    const { user, dialog } = await openAddDialog()
    const form = within(dialog)

    await user.type(form.getByLabelText(/^Amount in /), '500')
    await user.click(form.getByRole('button', { name: 'USD' }))
    await waitFor(() =>
      expect(form.getByLabelText('FX rate')).toHaveValue('1245'),
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

  test('selecting Official pre-fills its rate and sends fxRateType=official', async () => {
    createMock.mockResolvedValueOnce({})
    const { user, dialog } = await openAddDialog()
    const form = within(dialog)

    await user.type(form.getByLabelText(/^Amount in /), '500')
    await user.click(form.getByRole('button', { name: 'USD' }))
    await waitFor(() =>
      expect(form.getByLabelText('FX rate')).toHaveValue('1245'),
    )

    // Pick the official source: the rate field switches to the official value.
    await user.click(form.getByRole('button', { name: 'Official 1.045' }))
    await waitFor(() =>
      expect(form.getByLabelText('FX rate')).toHaveValue('1045'),
    )
    // 500 USD * 1045 = ARS 522.500, source reads "official".
    expect(
      await form.findByText('≈ ARS 522.500 at official 1.045'),
    ).toBeInTheDocument()
    expect(
      form.getByText('Suggested official rate — confirm or edit.'),
    ).toBeInTheDocument()

    await user.click(form.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    const [input] = createMock.mock.calls[0]
    expect(input.fxRateType).toBe('official')
    expect(input.rate).toBe(1045)
    expect(input.amountNum).toBe(522500)
  })

  test('editing the rate switches the source to manual and recomputes amountNum', async () => {
    createMock.mockResolvedValueOnce({})
    const { user, dialog } = await openAddDialog()
    const form = within(dialog)

    await user.type(form.getByLabelText(/^Amount in /), '100')
    await user.click(form.getByRole('button', { name: 'USD' }))
    const rateField = await form.findByLabelText('FX rate')
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
    expect(form.getByLabelText('FX rate')).toHaveValue('1300')
    expect(fxMock).not.toHaveBeenCalled()
    // The stored source is preserved until the user edits the rate.
    expect(
      form.getByText('≈ ARS 650.000 at manual 1.300'),
    ).toBeInTheDocument()
  })

  test('editing an existing official row keeps source=official until edited', async () => {
    const { user, dialog } = await openAddDialog({
      id: 'usd-edit-official',
      name: 'Invoice · Atlas Co.',
      type: 'income',
      kind: 'invoice',
      currency: 'USD',
      category: 'Income',
      bank: 'Transfer',
      amountNum: 522500,
      usd: 500,
      rate: 1045,
      fxRateType: 'official',
      fxRateAsOf: '2026-06-12T12:00:00.000Z',
      occurredOn: '2026-06-12',
      dispDate: 'Jun 12',
    })
    const form = within(dialog)

    // The stored official rate is loaded; no re-suggest, source stays official:
    // the Official option is pressed and the subline reads "official".
    expect(form.getByLabelText('FX rate')).toHaveValue('1045')
    expect(fxMock).not.toHaveBeenCalled()
    expect(
      form.getByText('≈ ARS 522.500 at official 1.045'),
    ).toBeInTheDocument()
    expect(
      form.getByRole('button', { name: 'Official 1.045', pressed: true }),
    ).toBeInTheDocument()

    // Editing the rate flips the source to manual (the indicator updates).
    await user.clear(form.getByLabelText('FX rate'))
    await user.type(form.getByLabelText('FX rate'), '1100')
    expect(
      await form.findByText('≈ ARS 550.000 at manual 1.100'),
    ).toBeInTheDocument()
  })

  test('USD cannot be saved when both rates fail (required manual entry)', async () => {
    // dolarapi is fully down: neither suggestion arrives.
    fxMock.mockResolvedValue({ mep: null, official: null })
    const { user, dialog } = await openAddDialog()
    const form = within(dialog)

    await user.type(form.getByLabelText(/^Amount in /), '500')
    await user.click(form.getByRole('button', { name: 'USD' }))

    // The fetch failed → manual-entry prompt, no silent rate, Save disabled.
    expect(
      await form.findByText("Couldn't fetch a rate — enter it manually."),
    ).toBeInTheDocument()
    expect(form.getByLabelText('FX rate')).toHaveValue('')
    expect(form.getByRole('button', { name: /^Save$/ })).toBeDisabled()
    expect(createMock).not.toHaveBeenCalled()
    // Both suggested options are disabled when their rate failed to load.
    expect(form.getByRole('button', { name: 'MEP —' })).toBeDisabled()
    expect(form.getByRole('button', { name: 'Official —' })).toBeDisabled()

    // Entering a manual rate enables Save and records it as manual.
    await user.type(form.getByLabelText('FX rate'), '1300')
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
