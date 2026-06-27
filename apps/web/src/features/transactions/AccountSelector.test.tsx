/**
 * Interaction test for the transaction account selector (ADR-122/133).
 *
 * Drives the shared Add/Edit form through its real seam and asserts that picking
 * an account from the selector sets `accountId` on the assembled create body, and
 * that editing a row seeded with an account preserves/changes it on the patch.
 * The account SUPERSEDES the bank tag for attribution while the bank chips stay
 * for display (ADR-117). English-pinned (ADR-105).
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
  fetchSettingsMock,
  monotributoMock,
  accountsListMock,
  navigateMock,
} = vi.hoisted(() => ({
  createMock: vi.fn(),
  updateMock: vi.fn(),
  fxMock: vi.fn(),
  fetchSettingsMock: vi.fn(),
  monotributoMock: vi.fn(),
  accountsListMock: vi.fn(),
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

vi.mock('../../api/fxClient', () => ({ fetchSuggestedRates: fxMock }))

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
      netWorth: vi.fn(),
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
  fetchSettingsMock.mockResolvedValue({
    preferredDisplayCurrency: 'ARS',
    fxDefaultRateType: 'MEP',
    monotributoCurrentCategory: 'C',
    monotributoActivityType: 'services',
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
    { id: 'acc-1', name: 'Galicia ARS', type: 'bank', currency: 'ARS', openingBalance: '0.00' },
    { id: 'acc-2', name: 'Deel USD', type: 'cash', currency: 'USD', openingBalance: '0.00' },
  ])
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

    // Open the Account select and pick "Deel USD".
    await user.click(form.getByRole('combobox', { name: 'Account' }))
    const option = await screen.findByRole('option', { name: 'Deel USD' })
    await user.click(option)

    // Save.
    await user.click(form.getByRole('button', { name: /^Save$/ }))

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    const input = createMock.mock.calls[0][0]
    expect(input.accountId).toBe('acc-2')
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

    // The selector is seeded to the row's account.
    expect(form.getByRole('combobox', { name: 'Account' })).toHaveTextContent(
      'Galicia ARS',
    )

    await user.click(form.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1))
    const [, patch] = updateMock.mock.calls[0]
    expect(patch.accountId).toBe('acc-1')
  })
})
