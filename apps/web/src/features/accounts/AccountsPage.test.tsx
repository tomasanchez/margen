/**
 * Unit tests for the Accounts page (ADR-122/130, ADR-037).
 *
 * Drives the page against a MOCKED {@link accountsClient} (the network boundary),
 * so the real TanStack Query hooks + the page's add/edit flow run end to end:
 *
 *  - the list renders each account with its type / currency / opening balance;
 *  - "Add account" opens the form, and a save POSTs the assembled write body;
 *  - editing an account opens the form seeded with its values and PUTs an update;
 *  - a GET failure surfaces the calm error state (incl. a cross-tenant 404).
 *
 * English-pinned (ADR-105). Money is asserted via the shared es-AR formatter.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '../../test/renderWithProviders'
import { AccountsPage } from './AccountsPage'
import { accountsClient, AccountApiError } from '../../api/accountsClient'
import type { Account } from '../../mock/types'

vi.mock('../../api/accountsClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/accountsClient')>()
  return {
    ...actual,
    accountsClient: {
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      netWorth: vi.fn(),
    },
  }
})

const ACCOUNTS: Account[] = [
  {
    id: 'a1',
    name: 'Galicia ARS',
    type: 'bank',
    currency: 'ARS',
    openingBalance: '150000.00',
  },
  {
    id: 'a2',
    name: 'Deel USD',
    type: 'cash',
    currency: 'USD',
    openingBalance: '1200.00',
  },
]

const mockList = vi.mocked(accountsClient.list)
const mockCreate = vi.mocked(accountsClient.create)
const mockUpdate = vi.mocked(accountsClient.update)

describe('AccountsPage', () => {
  beforeEach(() => {
    mockList.mockResolvedValue(ACCOUNTS)
    mockCreate.mockResolvedValue(ACCOUNTS[0])
    mockUpdate.mockResolvedValue(ACCOUNTS[0])
  })
  afterEach(() => vi.clearAllMocks())

  test('lists each account with its currency and opening balance', async () => {
    renderWithProviders(<AccountsPage />)

    expect(await screen.findByText('Galicia ARS')).toBeInTheDocument()
    expect(screen.getByText('Deel USD')).toBeInTheDocument()
    // ARS balance, es-AR grouping.
    expect(screen.getByText('ARS 150.000')).toBeInTheDocument()
    // USD account renders in its native currency.
    expect(screen.getByText('USD 1.200')).toBeInTheDocument()
  })

  test('opening "Add account" and saving POSTs the assembled write body', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AccountsPage />)
    await screen.findByText('Galicia ARS')

    await user.click(screen.getByRole('button', { name: 'Add account' }))

    await screen.findByRole('dialog')
    await user.type(screen.getByRole('textbox', { name: /Name/ }), 'Brubank ARS')
    await user.type(
      screen.getByRole('textbox', { name: /Opening balance/ }),
      '50000',
    )
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
    expect(mockCreate).toHaveBeenCalledWith({
      name: 'Brubank ARS',
      type: 'bank',
      currency: 'ARS',
      openingBalance: '50000.00',
    })
  })

  test('editing an account seeds the form and PUTs the update', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AccountsPage />)
    await screen.findByText('Galicia ARS')

    await user.click(screen.getByRole('button', { name: 'Edit Galicia ARS' }))

    await screen.findByRole('dialog')
    const nameField = screen.getByRole('textbox', { name: /Name/ })
    expect(nameField).toHaveValue('Galicia ARS')

    await user.clear(nameField)
    await user.type(nameField, 'Galicia pesos')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1))
    expect(mockUpdate).toHaveBeenCalledWith('a1', {
      name: 'Galicia pesos',
      type: 'bank',
      currency: 'ARS',
      openingBalance: '150000.00',
    })
  })

  test('a load failure surfaces the calm error state', async () => {
    mockList.mockRejectedValueOnce(new AccountApiError(404, 'not found'))
    renderWithProviders(<AccountsPage />)
    expect(await screen.findByText("Can't load your accounts")).toBeInTheDocument()
  })
})
