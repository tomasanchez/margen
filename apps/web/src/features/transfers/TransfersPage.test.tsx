/**
 * Unit tests for the Transfers page (ADR-135, ADR-037).
 *
 * Drives the page against a MOCKED {@link transfersClient} + {@link accountsClient}
 * (the network boundaries), so the real TanStack Query hooks and the page's
 * create/delete flows run end to end:
 *
 *  - transfers render newest-first as from → to with amounts + currencies + date;
 *  - a cross-currency transfer additionally shows the received amount;
 *  - "New transfer" opens the form; a SAME-currency transfer hides the received
 *    field and POSTs amountOut === amountIn; a CROSS-currency transfer shows both
 *    and forwards distinct figures; from ≠ to is enforced;
 *  - fee lines are forwarded in the POST body;
 *  - creating a transfer invalidates the accounts/net-worth + transactions keys
 *    (fees add transactions) alongside the transfers list (ADR-135);
 *  - delete confirms (copy notes fees survive) and calls the delete mutation.
 *
 * English-pinned (ADR-105). The page renders TanStack <Link>s (the Accounts
 * shortcut), so it mounts behind a memory router.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { ColorModeProvider } from '../../theme/colorMode'
import { TransfersPage } from './TransfersPage'
import { transfersClient } from '../../api/transfersClient'
import { accountsClient } from '../../api/accountsClient'
import type { Account, Transfer } from '../../mock/types'

vi.mock('../../api/transfersClient', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/transfersClient')>()
  return {
    ...actual,
    transfersClient: { list: vi.fn(), create: vi.fn(), remove: vi.fn() },
  }
})

vi.mock('../../api/accountsClient', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/accountsClient')>()
  return {
    ...actual,
    accountsClient: {
      listInstitutions: vi.fn(),
      createInstitution: vi.fn(),
      updateInstitution: vi.fn(),
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      netWorth: vi.fn(),
    },
  }
})

const ACCOUNTS: Account[] = [
  {
    id: 'acc-ars',
    institutionId: 'inst-1',
    institutionName: 'Galicia',
    type: 'bank',
    currency: 'ARS',
    openingBalance: '150000.00',
  },
  {
    id: 'acc-ars-2',
    institutionId: 'inst-2',
    institutionName: 'Brubank',
    type: 'bank',
    currency: 'ARS',
    openingBalance: '50000.00',
  },
  {
    id: 'acc-usd',
    institutionId: 'inst-3',
    institutionName: 'Deel',
    type: 'wallet',
    currency: 'USD',
    openingBalance: '1200.00',
  },
]

const TRANSFERS: Transfer[] = [
  {
    id: 'tr-1',
    fromAccountId: 'acc-ars',
    toAccountId: 'acc-ars-2',
    amountOut: '1000.00',
    amountIn: '1000.00',
    occurredOn: '2026-06-20',
    note: 'rent move',
  },
]

const mockList = vi.mocked(transfersClient.list)
const mockCreate = vi.mocked(transfersClient.create)
const mockRemove = vi.mocked(transfersClient.remove)
const mockAccountsList = vi.mocked(accountsClient.list)

function renderTransfersPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
  const rootRoute = createRootRoute({ component: () => <TransfersPage /> })
  const transfersRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/transfers',
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([transfersRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ColorModeProvider>
        <RouterProvider router={router} />
      </ColorModeProvider>
    </QueryClientProvider>,
  )
  return { ...utils, invalidateSpy }
}

/** Open the New-transfer dialog and return its scope. */
async function openForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'New transfer' }))
  return within(await screen.findByRole('dialog'))
}

/** Pick an option from a MUI Select by its visible label. */
async function selectOption(
  user: ReturnType<typeof userEvent.setup>,
  dialog: ReturnType<typeof within>,
  label: RegExp,
  optionName: string,
) {
  await user.click(dialog.getByLabelText(label))
  await user.click(await screen.findByRole('option', { name: optionName }))
}

describe('TransfersPage', () => {
  beforeEach(() => {
    mockList.mockResolvedValue(TRANSFERS)
    mockAccountsList.mockResolvedValue(ACCOUNTS)
    mockCreate.mockResolvedValue({
      transfer: TRANSFERS[0],
      feeTransactionIds: [],
    })
    mockRemove.mockResolvedValue(undefined)
  })
  afterEach(() => vi.clearAllMocks())

  test('lists transfers as from -> to with amount + currency + note', async () => {
    renderTransfersPage()
    expect(await screen.findByText('Galicia')).toBeInTheDocument()
    expect(screen.getByText('Brubank')).toBeInTheDocument()
    // Same-currency transfer renders the sent amount (es-AR ARS grouping).
    expect(screen.getByText('ARS 1.000')).toBeInTheDocument()
    expect(screen.getByText(/rent move/)).toBeInTheDocument()
  })

  test('same-currency transfer hides the received field and POSTs amountOut === amountIn', async () => {
    const user = userEvent.setup()
    renderTransfersPage()
    await screen.findByText('Galicia')

    const dialog = await openForm(user)
    await selectOption(user, dialog, /From account/, 'Galicia · ARS')
    await selectOption(user, dialog, /To account/, 'Brubank · ARS')

    // Same currency: no "amount received" field is shown.
    expect(dialog.queryByLabelText(/Amount received/)).toBeNull()

    await user.type(dialog.getByLabelText(/Amount sent/), '1000')
    await user.click(dialog.getByRole('button', { name: 'Save transfer' }))

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
    const body = mockCreate.mock.calls[0][0]
    expect(body.fromAccountId).toBe('acc-ars')
    expect(body.toAccountId).toBe('acc-ars-2')
    expect(body.amountOut).toBe('1000.00')
    expect(body.amountIn).toBe('1000.00')
    expect(body.fees).toBeUndefined()
  })

  test('cross-currency transfer shows both fields and forwards distinct amounts', async () => {
    const user = userEvent.setup()
    renderTransfersPage()
    await screen.findByText('Galicia')

    const dialog = await openForm(user)
    await selectOption(user, dialog, /From account/, 'Deel · USD')
    await selectOption(user, dialog, /To account/, 'Galicia · ARS')

    // Different currencies: the received field appears.
    const received = await dialog.findByLabelText(/Amount received/)
    await user.type(dialog.getByLabelText(/Amount sent/), '1000')
    await user.type(received, '1240000')
    await user.click(dialog.getByRole('button', { name: 'Save transfer' }))

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
    const body = mockCreate.mock.calls[0][0]
    expect(body.amountOut).toBe('1000.00')
    expect(body.amountIn).toBe('1240000.00')
  })

  test('rejects a from === to transfer (no POST)', async () => {
    const user = userEvent.setup()
    renderTransfersPage()
    await screen.findByText('Galicia')

    const dialog = await openForm(user)
    await selectOption(user, dialog, /From account/, 'Galicia · ARS')
    await selectOption(user, dialog, /To account/, 'Galicia · ARS')
    await user.type(dialog.getByLabelText(/Amount sent/), '1000')

    // from === to surfaces the validation message and disables Save (no POST).
    expect(
      dialog.getByText('Pick a different account to transfer to.'),
    ).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: 'Save transfer' })).toBeDisabled()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  test('a fee line is forwarded in the POST body', async () => {
    const user = userEvent.setup()
    renderTransfersPage()
    await screen.findByText('Galicia')

    const dialog = await openForm(user)
    await selectOption(user, dialog, /From account/, 'Galicia · ARS')
    await selectOption(user, dialog, /To account/, 'Brubank · ARS')
    await user.type(dialog.getByLabelText(/Amount sent/), '1000')

    await user.click(dialog.getByRole('button', { name: 'Add fee' }))
    await user.type(dialog.getByLabelText('Fee amount'), '15')
    await user.type(dialog.getByLabelText('Fee label'), 'Wire fee')
    await user.click(dialog.getByRole('button', { name: 'Save transfer' }))

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
    const body = mockCreate.mock.calls[0][0]
    // The fee account defaulted to the `from` account (acc-ars).
    expect(body.fees).toEqual([
      { accountId: 'acc-ars', amount: '15.00', label: 'Wire fee' },
    ])
  })

  test('creating a transfer invalidates transfers + accounts + transactions keys', async () => {
    const user = userEvent.setup()
    const { invalidateSpy } = renderTransfersPage()
    await screen.findByText('Galicia')

    const dialog = await openForm(user)
    await selectOption(user, dialog, /From account/, 'Galicia · ARS')
    await selectOption(user, dialog, /To account/, 'Brubank · ARS')
    await user.type(dialog.getByLabelText(/Amount sent/), '1000')
    await user.click(dialog.getByRole('button', { name: 'Save transfer' }))

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
    const invalidatedKeys = invalidateSpy.mock.calls.map(
      (call) => (call[0] as { queryKey: unknown[] }).queryKey[0],
    )
    expect(invalidatedKeys).toContain('transfers')
    expect(invalidatedKeys).toContain('accounts')
    expect(invalidatedKeys).toContain('transactions')
  })

  test('deleting a transfer confirms (fees survive) and calls remove', async () => {
    const user = userEvent.setup()
    renderTransfersPage()
    await screen.findByText('Galicia')

    await user.click(
      screen.getByRole('button', {
        name: 'Delete transfer from Galicia to Brubank',
      }),
    )
    const dialog = within(await screen.findByRole('dialog'))
    // Confirm copy makes clear the fee expenses are NOT deleted.
    expect(dialog.getByText(/stay as expenses/i)).toBeInTheDocument()

    await user.click(dialog.getByRole('button', { name: 'Delete transfer' }))
    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith('tr-1'))
  })
})
