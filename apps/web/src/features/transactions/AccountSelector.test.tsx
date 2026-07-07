/**
 * Interaction test for the transaction account selector (ADR-122/133).
 *
 * Drives the shared Add/Edit form through its real seam and asserts that picking
 * an account from the selector sets `accountId` on the assembled create body, and
 * that editing a row seeded with an account preserves/changes it on the patch.
 * The account IS the attribution: the legacy bank picker has been retired from
 * the form (ADR-136 extension), so a manual entry carries an `accountId` and no
 * `bank` tag. English-pinned (ADR-105).
 *
 * The HTTP client, FX adapter, settings, monotributo, and accounts clients are
 * all mocked so the form renders standalone with no real backend.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '../../test/renderWithProviders'
import { useAddTransaction } from './addContext'
import type { AddPrefill } from './addContext'

const {
  createMock,
  updateMock,
  fxMock,
  currentRateMock,
  fetchSettingsMock,
  monotributoMock,
  accountsListMock,
  netWorthMock,
  transfersListMock,
  navigateMock,
} = vi.hoisted(() => ({
  createMock: vi.fn(),
  updateMock: vi.fn(),
  fxMock: vi.fn(),
  currentRateMock: vi.fn(),
  fetchSettingsMock: vi.fn(),
  monotributoMock: vi.fn(),
  accountsListMock: vi.fn(),
  netWorthMock: vi.fn(),
  transfersListMock: vi.fn(),
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

vi.mock('../../api/fxClient', () => ({
  fetchSuggestedRates: fxMock,
  fetchCurrentRate: currentRateMock,
}))

vi.mock('../../api/monotributoClient', () => ({
  fetchMonotributo: monotributoMock,
}))

vi.mock('../../api/settingsClient', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/settingsClient')>(
      '../../api/settingsClient',
    )
  return { ...actual, fetchSettings: fetchSettingsMock }
})

vi.mock('../../api/accountsClient', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/accountsClient')>(
      '../../api/accountsClient',
    )
  return {
    ...actual,
    accountsClient: {
      list: accountsListMock,
      create: vi.fn(),
      update: vi.fn(),
      netWorth: netWorthMock,
    },
  }
})

vi.mock('../../api/transfersClient', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/transfersClient')>(
      '../../api/transfersClient',
    )
  return {
    ...actual,
    transfersClient: {
      list: transfersListMock,
      create: vi.fn(),
      remove: vi.fn(),
    },
  }
})

vi.mock('@tanstack/react-router', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-router')>(
      '@tanstack/react-router',
    )
  return { ...actual, useNavigate: () => navigateMock }
})

beforeEach(() => {
  fxMock.mockResolvedValue({ mep: 1245, official: 1045 })
  currentRateMock.mockResolvedValue(1245)
  fetchSettingsMock.mockResolvedValue({
    preferredDisplayCurrency: 'ARS',
    fxDefaultRateType: 'MEP',
    preferredRateSource: 'bolsa',
    monotributoCurrentCategory: 'C',
    monotributoActivityType: 'services',
    monotributoEnabled: true,
  })
  monotributoMock.mockResolvedValue({
    current: {
      category: 'C',
      activityType: 'services',
      annualLimit: 21_113_697,
      used: 0,
      remaining: 21_113_697,
      percentUsed: 0,
      ratio: 0,
      status: 'safe',
      projectedCategory: 'C',
      projectionNote: '',
      periodStart: '2025-07-01',
      periodEnd: '2026-06-30',
    },
    previous: null,
    scale: [],
    invoices: [],
  })
  accountsListMock.mockResolvedValue([
    {
      id: 'acc-1',
      institutionId: 'inst-1',
      institutionName: 'Galicia',
      type: 'bank',
      currency: 'ARS',
      openingBalance: '0.00',
    },
    {
      id: 'acc-2',
      institutionId: 'inst-2',
      institutionName: 'Deel',
      type: 'wallet',
      currency: 'USD',
      openingBalance: '0.00',
    },
  ])
  // Default: no cross-currency net worth + no transfers so the spendable-now
  // subline degrades to each account's opening balance (0) with no pending legs.
  netWorthMock.mockResolvedValue({ total: 0, accounts: [] })
  transfersListMock.mockResolvedValue([])
})

afterEach(() => vi.clearAllMocks())

/** A trigger that opens the Add/Edit flow with an optional prefill. */
function OpenAddTrigger({ prefill }: { prefill?: AddPrefill }) {
  const { openAdd } = useAddTransaction()
  return (
    <button type="button" onClick={() => openAdd(prefill)}>
      open add
    </button>
  )
}

async function openDialog(prefill?: AddPrefill) {
  const user = userEvent.setup()
  renderWithProviders(<OpenAddTrigger prefill={prefill} />, {
    withAddProvider: true,
  })
  await user.click(screen.getByRole('button', { name: 'open add' }))
  const dialog = await screen.findByRole('dialog')
  return { user, dialog }
}

describe('transaction account selector (ADR-122/133)', () => {
  test('picking an account sets accountId on the create body', async () => {
    const { user, dialog } = await openDialog()
    const form = within(dialog)

    // Wait for the accounts to load into the selector.
    await waitFor(() => expect(accountsListMock).toHaveBeenCalled())

    // Enter an ARS amount so the form can save.
    await user.type(form.getByLabelText(/^Amount in /), '5000')

    // Open the Account select and pick "Galicia · ARS" (institution · currency).
    // The form currency is ARS, so only the ARS account is offered (ADR-122/123).
    // The option's accessible name now also carries the spendable-now subline
    // (ADR-194), so match the institution·currency label as a prefix.
    await user.click(form.getByRole('combobox', { name: 'Account' }))
    const option = await screen.findByRole('option', { name: /Galicia · ARS/ })
    await user.click(option)

    // Save.
    await user.click(form.getByRole('button', { name: /^Save$/ }))

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    const input = createMock.mock.calls[0][0]
    expect(input.accountId).toBe('acc-1')
  })

  test('the form no longer renders the legacy bank picker (ADR-136 extension)', async () => {
    const { dialog } = await openDialog()
    const form = within(dialog)
    await waitFor(() => expect(accountsListMock).toHaveBeenCalled())

    // The Account selector — the attribution control — is present...
    expect(form.getByRole('combobox', { name: 'Account' })).toBeInTheDocument()
    // ...but the retired "Bank / card" picker section is gone, and none of the
    // bank chips (e.g. Galicia) render as a selectable form control.
    expect(form.queryByText('Bank / card')).not.toBeInTheDocument()
    expect(form.queryByRole('button', { name: 'Galicia' })).toBeNull()
  })

  test('a manual entry with no account picked sends no bank tag', async () => {
    const { user, dialog } = await openDialog()
    const form = within(dialog)
    await waitFor(() => expect(accountsListMock).toHaveBeenCalled())

    // Just an amount — no account chosen.
    await user.type(form.getByLabelText(/^Amount in /), '5000')
    await user.click(form.getByRole('button', { name: /^Save$/ }))

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    const input = createMock.mock.calls[0][0]
    // The legacy bank tag is no longer a form field — it is omitted entirely.
    expect(input.bank).toBeUndefined()
    // Attribution is the account; none picked here, so it is explicitly null.
    expect(input.accountId).toBeNull()
  })

  test('the selector lists only accounts matching the form currency (ARS)', async () => {
    const { user, dialog } = await openDialog()
    const form = within(dialog)
    await waitFor(() => expect(accountsListMock).toHaveBeenCalled())

    // Default currency is ARS, so only the ARS account is offered; the USD
    // account is absent (an account holds one currency, ADR-122/123).
    await user.click(form.getByRole('combobox', { name: 'Account' }))
    expect(
      await screen.findByRole('option', { name: /Galicia · ARS/ }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('option', { name: /Deel · USD/ }),
    ).not.toBeInTheDocument()
  })

  test('switching ARS→USD swaps the options to USD accounts and clears a stranded ARS pick', async () => {
    const { user, dialog } = await openDialog()
    const form = within(dialog)
    await waitFor(() => expect(accountsListMock).toHaveBeenCalled())

    // Pick the ARS account while the form is ARS.
    await user.click(form.getByRole('combobox', { name: 'Account' }))
    await user.click(await screen.findByRole('option', { name: /Galicia · ARS/ }))
    expect(form.getByRole('combobox', { name: 'Account' })).toHaveTextContent(
      'Galicia · ARS',
    )

    // Switch the form currency to USD: the ARS account no longer matches, so the
    // selection is cleared back to "No account", and the options become USD-only.
    await user.click(form.getByRole('button', { name: 'USD' }))
    await waitFor(() =>
      expect(
        form.getByRole('combobox', { name: 'Account' }),
      ).not.toHaveTextContent('Galicia · ARS'),
    )

    await user.click(form.getByRole('combobox', { name: 'Account' }))
    expect(
      await screen.findByRole('option', { name: /Deel · USD/ }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('option', { name: /Galicia · ARS/ }),
    ).not.toBeInTheDocument()
  })

  test('a USD transaction saves a currency-matching account', async () => {
    fxMock.mockResolvedValue({ mep: 1245, official: 1045 })
    const { user, dialog } = await openDialog()
    const form = within(dialog)
    await waitFor(() => expect(accountsListMock).toHaveBeenCalled())

    // Switch to USD, enter an amount + rate, pick the USD account, save.
    await user.click(form.getByRole('button', { name: 'USD' }))
    await user.type(form.getByLabelText(/^Amount in /), '500')
    // The MEP suggestion pre-fills the rate; await it so the form can save.
    await form.findByText('≈ ARS 622.500 at MEP 1.245')

    await user.click(form.getByRole('combobox', { name: 'Account' }))
    await user.click(await screen.findByRole('option', { name: /Deel · USD/ }))

    await user.click(form.getByRole('button', { name: /^Save$/ }))

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    const input = createMock.mock.calls[0][0]
    expect(input.currency).toBe('USD')
    expect(input.accountId).toBe('acc-2')
  })

  test('editing a USD transaction keeps its USD account seeded (not cleared)', async () => {
    const { user, dialog } = await openDialog({
      id: 'tx-usd',
      type: 'expense',
      kind: 'expense',
      currency: 'USD',
      amountNum: 622500,
      usd: 500,
      rate: 1245,
      fxRateType: 'MEP',
      category: 'Food',
      accountId: 'acc-2',
      occurredOn: '2026-06-10',
      dispDate: 'Jun 10',
      name: 'Hardware',
    })
    const form = within(dialog)
    await waitFor(() => expect(accountsListMock).toHaveBeenCalled())

    // The seeded USD account matches the row's currency, so it stays selected on
    // the initial seed (ADR-136); no clearing fires.
    expect(form.getByRole('combobox', { name: 'Account' })).toHaveTextContent(
      'Deel · USD',
    )

    await user.click(form.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1))
    const [, patch] = updateMock.mock.calls[0]
    expect(patch.accountId).toBe('acc-2')
  })

  test('each option shows spendable-now = balance − pendingOut + an "arriving" caption when pendingIn > 0 (ADR-194)', async () => {
    // Galicia (ARS) has an as-of-today balance of 100.000, a future-dated
    // outflow of 30.000 (pending, ADR-191), and a future-dated top-up of 20.000
    // arriving. Spendable-now = 100.000 − 30.000 = 70.000 (the arriving 20.000 is
    // NEVER folded in — it shows as a calm caption only).
    netWorthMock.mockResolvedValue({
      total: 0,
      accounts: [
        {
          id: 'acc-1',
          institutionId: 'inst-1',
          institutionName: 'Galicia',
          type: 'bank',
          currency: 'ARS',
          balance: '100000.00',
          balanceConverted: '100000.00',
        },
      ],
    })
    transfersListMock.mockResolvedValue([
      {
        id: 't-out',
        fromAccountId: 'acc-1',
        toAccountId: 'acc-9',
        amountOut: '30000.00',
        amountIn: '30000.00',
        occurredOn: '2100-01-01',
      },
      {
        id: 't-in',
        fromAccountId: 'acc-9',
        toAccountId: 'acc-1',
        amountOut: '20000.00',
        amountIn: '20000.00',
        occurredOn: '2100-01-02',
      },
    ])

    const { user, dialog } = await openDialog()
    const form = within(dialog)
    await waitFor(() => expect(accountsListMock).toHaveBeenCalled())
    await waitFor(() => expect(netWorthMock).toHaveBeenCalled())
    await waitFor(() => expect(transfersListMock).toHaveBeenCalled())

    await user.click(form.getByRole('combobox', { name: 'Account' }))
    const option = await screen.findByRole('option', { name: /Galicia · ARS/ })
    // Spendable-now = balance (100.000) − pendingOut (30.000) = 70.000.
    expect(within(option).getByText('Spendable now ARS 70.000')).toBeInTheDocument()
    // The arriving inflow (20.000) is a caption, NOT added to the figure.
    expect(within(option).getByText('+ARS 20.000 arriving')).toBeInTheDocument()
    expect(within(option).queryByText(/ARS 90\.000/)).not.toBeInTheDocument()
  })

  test('an edit seeded with an account preserves it on save', async () => {
    const { user, dialog } = await openDialog({
      id: 'tx-1',
      type: 'expense',
      kind: 'expense',
      currency: 'ARS',
      amountNum: 5000,
      category: 'Food',
      bank: 'Galicia',
      accountId: 'acc-1',
      occurredOn: '2026-06-10',
      dispDate: 'Jun 10',
      name: 'Lunch',
    })
    const form = within(dialog)
    await waitFor(() => expect(accountsListMock).toHaveBeenCalled())

    // The selector is seeded to the row's account (institution · currency).
    expect(form.getByRole('combobox', { name: 'Account' })).toHaveTextContent(
      'Galicia · ARS',
    )

    await user.click(form.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1))
    const [, patch] = updateMock.mock.calls[0]
    expect(patch.accountId).toBe('acc-1')
  })
})
