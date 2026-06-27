/**
 * Unit tests for the Accounts page (ADR-122/130/134, ADR-037).
 *
 * Drives the page against a MOCKED {@link accountsClient} (the network boundary),
 * so the real TanStack Query hooks + the page's add/edit flows run end to end:
 *
 *  - institutions are grouped, each showing its per-currency accounts + balances;
 *  - "Add institution" opens the institution form and POSTs name + type;
 *  - "Add account" under an institution POSTs { institutionId, currency, balance };
 *  - editing an account opens the form seeded with its values and PUTs an update;
 *  - an account row links to /transactions?account=<id> (the drilldown, ADR-134);
 *  - a GET failure surfaces the calm error state (incl. a cross-tenant 404).
 *
 * The page renders TanStack <Link>s, so it mounts behind a memory router (the
 * same approach the CategoryBreakdown drilldown test uses). English-pinned
 * (ADR-105). Money is asserted via the shared es-AR formatter.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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
import { AccountsPage } from './AccountsPage'
import { accountsClient, AccountApiError } from '../../api/accountsClient'
import type { Account, Institution } from '../../mock/types'

vi.mock('../../api/accountsClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/accountsClient')>()
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

const INSTITUTIONS: Institution[] = [
  { id: 'inst-1', name: 'Galicia', type: 'bank' },
  { id: 'inst-2', name: 'Deel', type: 'wallet' },
]

const ACCOUNTS: Account[] = [
  {
    id: 'a1',
    institutionId: 'inst-1',
    institutionName: 'Galicia',
    type: 'bank',
    currency: 'ARS',
    openingBalance: '150000.00',
  },
  {
    id: 'a2',
    institutionId: 'inst-2',
    institutionName: 'Deel',
    type: 'wallet',
    currency: 'USD',
    openingBalance: '1200.00',
  },
]

const mockListInstitutions = vi.mocked(accountsClient.listInstitutions)
const mockListAccounts = vi.mocked(accountsClient.list)
const mockCreateInstitution = vi.mocked(accountsClient.createInstitution)
const mockCreateAccount = vi.mocked(accountsClient.create)
const mockUpdateAccount = vi.mocked(accountsClient.update)

/** Render the page behind a memory router so its drilldown <Link>s resolve. */
function renderAccountsPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute({ component: () => <AccountsPage /> })
  const transactionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/transactions',
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([transactionsRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ColorModeProvider>
        <RouterProvider router={router} />
      </ColorModeProvider>
    </QueryClientProvider>,
  )
}

describe('AccountsPage', () => {
  beforeEach(() => {
    mockListInstitutions.mockResolvedValue(INSTITUTIONS)
    mockListAccounts.mockResolvedValue(ACCOUNTS)
    mockCreateInstitution.mockResolvedValue(INSTITUTIONS[0])
    mockCreateAccount.mockResolvedValue(ACCOUNTS[0])
    mockUpdateAccount.mockResolvedValue(ACCOUNTS[0])
  })
  afterEach(() => vi.clearAllMocks())

  test('groups institutions and shows each account currency + balance', async () => {
    renderAccountsPage()

    // Each institution is a section header.
    expect(await screen.findByText('Galicia')).toBeInTheDocument()
    expect(screen.getByText('Deel')).toBeInTheDocument()
    // ARS balance under Galicia (es-AR grouping).
    expect(screen.getByText('ARS 150.000')).toBeInTheDocument()
    // USD account under Deel renders in its native currency.
    expect(screen.getByText('USD 1.200')).toBeInTheDocument()
  })

  test('an account row links to its transactions drilldown', async () => {
    renderAccountsPage()
    const link = await screen.findByRole('link', {
      name: 'View Galicia ARS transactions',
    })
    expect(link).toHaveAttribute('href', '/transactions?account=a1&month=all')
  })

  test('"Add institution" saves name + type', async () => {
    const user = userEvent.setup()
    renderAccountsPage()
    await screen.findByText('Galicia')

    await user.click(screen.getByRole('button', { name: 'Add institution' }))
    await screen.findByRole('dialog')
    await user.type(screen.getByRole('textbox', { name: /Name/ }), 'Brubank')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockCreateInstitution).toHaveBeenCalledTimes(1))
    expect(mockCreateInstitution).toHaveBeenCalledWith({
      name: 'Brubank',
      type: 'bank',
    })
  })

  test('"Add account" under an institution POSTs the currency + balance body', async () => {
    const user = userEvent.setup()
    renderAccountsPage()
    await screen.findByText('Galicia')

    // The first institution section's "Add account" button.
    const addAccountButtons = screen.getAllByRole('button', {
      name: 'Add account',
    })
    await user.click(addAccountButtons[0])

    await screen.findByRole('dialog')
    await user.type(
      screen.getByRole('textbox', { name: /Opening balance/ }),
      '50000',
    )
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockCreateAccount).toHaveBeenCalledTimes(1))
    expect(mockCreateAccount).toHaveBeenCalledWith({
      institutionId: 'inst-1',
      currency: 'ARS',
      openingBalance: '50000.00',
    })
  })

  test('editing an account seeds the form and PUTs the update', async () => {
    const user = userEvent.setup()
    renderAccountsPage()
    await screen.findByText('Galicia')

    await user.click(
      screen.getByRole('button', { name: 'Edit Galicia ARS account' }),
    )
    await screen.findByRole('dialog')

    const balanceField = screen.getByRole('textbox', {
      name: /Opening balance/,
    })
    expect(balanceField).toHaveValue('150000.00')
    await user.clear(balanceField)
    await user.type(balanceField, '200000')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockUpdateAccount).toHaveBeenCalledTimes(1))
    expect(mockUpdateAccount).toHaveBeenCalledWith('a1', {
      institutionId: 'inst-1',
      currency: 'ARS',
      openingBalance: '200000.00',
    })
  })

  test('a load failure surfaces the calm error state', async () => {
    mockListInstitutions.mockRejectedValueOnce(
      new AccountApiError(404, 'not found'),
    )
    renderAccountsPage()
    expect(
      await screen.findByText("Can't load your accounts"),
    ).toBeInTheDocument()
  })
})
