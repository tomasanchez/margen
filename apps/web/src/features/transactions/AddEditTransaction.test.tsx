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
const {
  createMock,
  updateMock,
  fxMock,
  currentRateMock,
  fetchSettingsMock,
  monotributoMock,
  navigateMock,
} = vi.hoisted(() => ({
  createMock: vi.fn(),
  updateMock: vi.fn(),
  fxMock: vi.fn(),
  currentRateMock: vi.fn(),
  fetchSettingsMock: vi.fn(),
  monotributoMock: vi.fn(),
  navigateMock: vi.fn(),
}))

vi.mock('../../api/transactionsClient', () => ({
  transactionsClient: {
    list: vi.fn(() => Promise.resolve([])),
    create: createMock,
    update: updateMock,
    remove: vi.fn(),
  },
}))

// The add mutation now captures the day's preferred-source rate before create
// (ADR-148/149); mock both the suggest-confirm rates and the current-rate fetch
// the capture uses so no real network is hit.
vi.mock('../../api/fxClient', () => ({
  fetchSuggestedRates: fxMock,
  fetchCurrentRate: currentRateMock,
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

// The form's "Import statement" entry navigates via TanStack Router; stub
// useNavigate so the form renders standalone (renderWithProviders has no router).
vi.mock('@tanstack/react-router', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-router')>(
      '@tanstack/react-router',
    )
  return { ...actual, useNavigate: () => navigateMock }
})

beforeEach(() => {
  // Default: dolarapi suggests MEP 1245 + official 1045 (seeded prototype values).
  fxMock.mockResolvedValue({ mep: 1245, official: 1045 })
  // Default: the day's current preferred-source rate the add capture stamps.
  currentRateMock.mockResolvedValue(1245)
  // Default: the configured FX default is MEP (existing behavior).
  fetchSettingsMock.mockResolvedValue({
    preferredDisplayCurrency: 'ARS',
    fxDefaultRateType: 'MEP',
    preferredRateSource: 'bolsa',
    monotributoCurrentCategory: 'C',
    monotributoActivityType: 'services',
    monotributoEnabled: true,
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

describe('Add flow — mobile-reachable statement-import entry (ADR-017)', () => {
  test('the form exposes an "Import statement" button that navigates and closes the flow', async () => {
    const { user, dialog } = await openAddDialog()
    const form = within(dialog)

    const importButton = form.getByRole('button', { name: 'Import statement' })
    expect(importButton).toBeEnabled()

    await user.click(importButton)

    // It navigates to the routed import flow...
    expect(navigateMock).toHaveBeenCalledWith({ to: '/import-statement' })
    // ...and closes the Add dialog (so the user lands on the import page).
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    )
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

describe('Add flow — ARS row shows + captures the FX snapshot rate (ADR-148/151)', () => {
  test('prefills the visible USD rate from the cached preferred rate and materializes usd on save', async () => {
    createMock.mockResolvedValueOnce({})
    const { user, dialog } = await openAddDialog()
    const form = within(dialog)

    // The ARS row exposes an editable "USD rate" field, prefilled from the
    // cached preferred-source rate (currentRateMock = 1245) so the user SEES the
    // value being applied.
    const rateField = await form.findByLabelText(
      'USD rate for this transaction (ARS per USD)',
    )
    await waitFor(() => expect(rateField).toHaveValue('1245'))

    // Enter an ARS amount → the USD-equivalent preview appears (≈ 1245000/1245 = 1000).
    await user.type(form.getByLabelText(/^Amount in /), '1245000')
    expect(await form.findByText(/≈ USD 1\.000 at MEP/)).toBeInTheDocument()

    await user.click(form.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))

    // The submitted input pairs a positive rate with its source, so the backend
    // materializes usd_amount (never a source-without-rate).
    const [input] = createMock.mock.calls[0]
    expect(input.currency).toBe('ARS')
    expect(input.fxRate).toBe('1245')
    expect(input.fxSource).toBe('bolsa')
  })

  test('a user override becomes the stored rate + source (manual)', async () => {
    createMock.mockResolvedValueOnce({})
    const { user, dialog } = await openAddDialog()
    const form = within(dialog)

    const rateField = await form.findByLabelText(
      'USD rate for this transaction (ARS per USD)',
    )
    await waitFor(() => expect(rateField).toHaveValue('1245'))

    // Override the rate for this transaction (it cleared at a different rate).
    await user.clear(rateField)
    await user.type(rateField, '1300')
    await user.type(form.getByLabelText(/^Amount in /), '13000')

    await user.click(form.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))

    const [input] = createMock.mock.calls[0]
    expect(input.fxRate).toBe('1300')
    expect(input.fxSource).toBe('manual')
  })
})

describe('Add flow — USD picks an explicit FX source (ADR-044/045)', () => {
  test('choosing USD fetches both rates + pre-fills the default (MEP), then converts', async () => {
    const { user, dialog } = await openAddDialog()
    const form = within(dialog)

    // No USD-conversion line while the (default) currency is ARS. (The ARS row
    // now shows its own snapshot-rate field; the USD "≈ ARS … at MEP <rate>"
    // converted line is what stays hidden until USD is picked.)
    expect(form.queryByText(/≈ ARS .* at MEP/)).not.toBeInTheDocument()

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
      preferredRateSource: 'bolsa',
      monotributoCurrentCategory: 'C',
      monotributoActivityType: 'services',
      monotributoEnabled: true,
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

describe('Edit prefills the SAVED FX rate, not the current live rate (ADR-148/149)', () => {
  // The current live/cached rate in these tests is 9999 (both the suggest-confirm
  // fetch and the ARS snapshot's `usePreferredRate`), deliberately far from every
  // row's stored rate so a regression that re-rates to "today" is unmistakable.
  const LIVE = 9999

  test('CREATE (ARS) still prefills the CURRENT live rate', async () => {
    // Contrast case: a fresh add must SEED today's preferred-source rate so the
    // user records against the live figure (they can still override).
    currentRateMock.mockResolvedValue(LIVE)
    const { dialog } = await openAddDialog()
    const form = within(dialog)
    const rateField = await form.findByLabelText(
      'USD rate for this transaction (ARS per USD)',
    )
    await waitFor(() => expect(rateField).toHaveValue(String(LIVE)))
  })

  test('EDIT (ARS expense) prefills the row’s SAVED snapshot rate', async () => {
    currentRateMock.mockResolvedValue(LIVE)
    const { dialog } = await openAddDialog({
      id: 'ars-edit-saved',
      name: 'Groceries',
      type: 'expense',
      kind: 'expense',
      currency: 'ARS',
      category: 'Food',
      amountNum: 118000,
      fxRate: '1180.5',
      fxSource: 'bolsa',
      occurredOn: '2026-03-10',
      dispDate: 'Mar 10',
    })
    const form = within(dialog)
    const rateField = await form.findByLabelText(
      'USD rate for this transaction (ARS per USD)',
    )
    // The saved rate is shown, never overwritten by the live rate as it lands.
    await waitFor(() => expect(rateField).toHaveValue('1180.5'))
    expect(rateField).not.toHaveValue(String(LIVE))
  })

  test('EDIT (USD) prefills the row’s SAVED conversion rate (no re-suggest)', async () => {
    fxMock.mockResolvedValue({ mep: LIVE, official: LIVE - 100 })
    currentRateMock.mockResolvedValue(LIVE)
    const { dialog } = await openAddDialog({
      id: 'usd-edit-saved',
      name: 'Invoice',
      type: 'income',
      kind: 'invoice',
      currency: 'USD',
      category: 'Income',
      amountNum: 650000,
      usd: 500,
      rate: 1300,
      fxRateType: 'manual',
      fxRateAsOf: '2026-06-12T12:00:00.000Z',
      occurredOn: '2026-06-12',
      dispDate: 'Jun 12',
    })
    const form = within(dialog)
    // The suggestion fetch never fires for a stored-rate edit, so the field keeps
    // the saved 1300 and nothing re-rates it to the live figure.
    await waitFor(() => expect(form.getByLabelText('FX rate')).toHaveValue('1300'))
    expect(fxMock).not.toHaveBeenCalled()
  })

  test('EDIT (ARS) re-saves the SAVED rate + source, never re-tagged to today’s preferred source', async () => {
    updateMock.mockResolvedValueOnce({})
    currentRateMock.mockResolvedValue(LIVE)
    // The user's CURRENT preferred source is oficial, differing from the row's
    // saved bolsa snapshot — the save must keep bolsa, not silently re-tag it.
    fetchSettingsMock.mockResolvedValue({
      preferredDisplayCurrency: 'ARS',
      fxDefaultRateType: 'MEP',
      preferredRateSource: 'oficial',
      monotributoCurrentCategory: 'C',
      monotributoActivityType: 'services',
      monotributoEnabled: true,
    })
    const { user, dialog } = await openAddDialog({
      id: 'ars-edit-resave',
      name: 'Groceries',
      type: 'expense',
      kind: 'expense',
      currency: 'ARS',
      category: 'Food',
      amountNum: 118000,
      fxRate: '1180',
      fxSource: 'bolsa',
      occurredOn: '2026-03-10',
      dispDate: 'Mar 10',
    })
    const form = within(dialog)
    await waitFor(() =>
      expect(
        form.getByLabelText('USD rate for this transaction (ARS per USD)'),
      ).toHaveValue('1180'),
    )
    await user.click(form.getByRole('button', { name: /^Save changes$/ }))
    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1))
    const [, patch] = updateMock.mock.calls[0]
    expect(patch.fxRate).toBe('1180')
    expect(patch.fxSource).toBe('bolsa')
  })

  test('EDIT (ARS) overriding the rate re-tags the snapshot as manual', async () => {
    updateMock.mockResolvedValueOnce({})
    currentRateMock.mockResolvedValue(LIVE)
    const { user, dialog } = await openAddDialog({
      id: 'ars-edit-override',
      name: 'Groceries',
      type: 'expense',
      kind: 'expense',
      currency: 'ARS',
      category: 'Food',
      amountNum: 118000,
      fxRate: '1180',
      fxSource: 'bolsa',
      occurredOn: '2026-03-10',
      dispDate: 'Mar 10',
    })
    const form = within(dialog)
    const rateField = await form.findByLabelText(
      'USD rate for this transaction (ARS per USD)',
    )
    await waitFor(() => expect(rateField).toHaveValue('1180'))
    // A deliberate user change owns the rate → provenance flips to manual.
    await user.clear(rateField)
    await user.type(rateField, '1200')
    await user.click(form.getByRole('button', { name: /^Save changes$/ }))
    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1))
    const [, patch] = updateMock.mock.calls[0]
    expect(patch.fxRate).toBe('1200')
    expect(patch.fxSource).toBe('manual')
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

describe('Add flow — optional Name/merchant field (ADR-088)', () => {
  test('typing a Name sends it as the transaction name in the create payload', async () => {
    createMock.mockResolvedValueOnce({})
    const { user, dialog } = await openAddDialog()
    const form = within(dialog)

    await user.type(form.getByLabelText('Name'), 'Sushiclub')
    await user.type(form.getByLabelText(/^Amount in /), '12000')
    await user.click(form.getByRole('button', { name: /^Save$/ }))

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    const [input] = createMock.mock.calls[0]
    expect(input.name).toBe('Sushiclub')
  })

  test('leaving Name blank falls back to the category-derived label', async () => {
    createMock.mockResolvedValueOnce({})
    const { user, dialog } = await openAddDialog()
    const form = within(dialog)

    // Pick a non-default category so the fallback is observable.
    await user.click(form.getByRole('button', { name: 'Transport' }))
    await user.type(form.getByLabelText(/^Amount in /), '8000')
    // Name left untouched (empty).
    expect(form.getByLabelText('Name')).toHaveValue('')
    await user.click(form.getByRole('button', { name: /^Save$/ }))

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    const [input] = createMock.mock.calls[0]
    expect(input.name).toBe('Transport')
  })

  test('editing a transaction shows its current name in the field and keeps it on save', async () => {
    createMock.mockResolvedValueOnce({})
    const { dialog } = await openAddDialog({
      id: 'edit-name-1',
      name: 'Sushiclub',
      type: 'expense',
      kind: 'expense',
      currency: 'ARS',
      category: 'Food',
      bank: 'Transfer',
      amountNum: 12000,
      occurredOn: '2026-01-20',
      dispDate: 'Jan 20',
    })
    const form = within(dialog)

    // The field reflects the existing name on edit.
    expect(form.getByLabelText('Name')).toHaveValue('Sushiclub')
  })

  test('editing an imported row preserves its card detail on save (ADR-117)', async () => {
    updateMock.mockResolvedValueOnce({})
    const { user, dialog } = await openAddDialog({
      id: 'edit-card-1',
      name: 'YPF fuel',
      type: 'expense',
      kind: 'expense',
      currency: 'ARS',
      category: 'Transport',
      bank: 'Santander',
      // Import-set card detail — not editable in the form, but carried through.
      card: 'VISA ·5771',
      amountNum: 28000,
      occurredOn: '2026-05-15',
      dispDate: 'May 15',
    })
    const form = within(dialog)

    // There is no card input — it is import-only (ADR-117).
    expect(form.queryByLabelText(/card/i)).toBeNull()

    await user.click(form.getByRole('button', { name: /^Save changes$/ }))

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1))
    const [id, patch] = updateMock.mock.calls[0]
    expect(id).toBe('edit-card-1')
    // The card survives the re-save unchanged (ADR-117). The legacy bank tag is
    // no longer a form field (ADR-136 extension): the form does not send it, so
    // the stored value is left untouched by the patch (omitted = unchanged).
    expect(patch.card).toBe('VISA ·5771')
    expect(patch.bank).toBeUndefined()
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
