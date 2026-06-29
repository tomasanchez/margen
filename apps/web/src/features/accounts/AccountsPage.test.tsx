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
import { AccountsPage } from './AccountsPage'
import {
  accountsClient,
  AccountApiError,
  type NetWorth,
} from '../../api/accountsClient'
import { fetchSuggestedRates } from '../../api/fxClient'
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

// The page reads live FX rates only to ORDER institutions by net-worth subtotal
// (rows show native balances), so a fixed MEP keeps the order deterministic and
// avoids a real network call.
vi.mock('../../api/fxClient', () => ({
  fetchSuggestedRates: vi.fn(),
}))

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

/**
 * Net worth carries each account's CURRENT native balance (opening + transaction
 * deltas, ADR-122) — deliberately DIFFERENT from the openingBalance above so the
 * tests prove the row shows the net-worth balance, not the stale opening one.
 * At MEP 1.000 Deel (USD 1.500 → ARS 1.500.000) outranks Galicia (ARS 765.000),
 * so Deel sorts before Galicia (subtotal DESC).
 */
const NET_WORTH: NetWorth = {
  total: '2265000.00',
  currency: 'ARS',
  accounts: [
    {
      id: 'a1',
      institutionId: 'inst-1',
      institutionName: 'Galicia',
      type: 'bank',
      currency: 'ARS',
      balance: '765000.00',
      balanceConverted: '765000.00',
    },
    {
      id: 'a2',
      institutionId: 'inst-2',
      institutionName: 'Deel',
      type: 'wallet',
      currency: 'USD',
      balance: '1500.00',
      balanceConverted: '1500000.00',
    },
  ],
}

const mockListInstitutions = vi.mocked(accountsClient.listInstitutions)
const mockListAccounts = vi.mocked(accountsClient.list)
const mockNetWorth = vi.mocked(accountsClient.netWorth)
const mockCreateInstitution = vi.mocked(accountsClient.createInstitution)
const mockCreateAccount = vi.mocked(accountsClient.create)
const mockUpdateAccount = vi.mocked(accountsClient.update)
const mockRates = vi.mocked(fetchSuggestedRates)

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
    mockNetWorth.mockResolvedValue(NET_WORTH)
    mockRates.mockResolvedValue({ mep: 1000, official: 1000 })
    mockCreateInstitution.mockResolvedValue(INSTITUTIONS[0])
    mockCreateAccount.mockResolvedValue(ACCOUNTS[0])
    mockUpdateAccount.mockResolvedValue(ACCOUNTS[0])
  })
  afterEach(() => vi.clearAllMocks())

  test('shows each account CURRENT balance from net worth, not its opening balance', async () => {
    renderAccountsPage()

    // Each institution is a section header.
    expect(await screen.findByText('Galicia')).toBeInTheDocument()
    expect(screen.getByText('Deel')).toBeInTheDocument()

    // Rows show the net-worth CURRENT balance (opening + deltas, ADR-122) — the
    // SAME value Home shows — NOT the stale opening balance.
    expect(screen.getByText('ARS 765.000')).toBeInTheDocument()
    expect(screen.getByText('USD 1.500')).toBeInTheDocument()

    // The opening balances (150.000 / 1.200) are deliberately different and must
    // NOT be what the list renders.
    expect(screen.queryByText('ARS 150.000')).not.toBeInTheDocument()
    expect(screen.queryByText('USD 1.200')).not.toBeInTheDocument()
  })

  test('orders institutions by net-worth subtotal desc (Deel before Galicia here)', async () => {
    renderAccountsPage()
    await screen.findByText('Galicia')

    // Institution section titles are h2 headings; in subtotal-DESC order Deel
    // (ARS 1.500.000 at MEP 1.000) precedes Galicia (ARS 765.000).
    const names = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent)
    expect(names.indexOf('Deel')).toBeLessThan(names.indexOf('Galicia'))
  })

  test('an account row links to its transactions drilldown', async () => {
    renderAccountsPage()
    const link = await screen.findByRole('link', {
      name: 'View Galicia ARS transactions',
    })
    expect(link).toHaveAttribute('href', '/transactions?account=a1&month=all')
  })

  test('the onboarding wizard advances step 1 -> 2 and skips to create the institution alone', async () => {
    const user = userEvent.setup()
    mockCreateInstitution.mockResolvedValue({
      id: 'inst-new',
      name: 'Brubank',
      type: 'bank',
    })
    renderAccountsPage()
    await screen.findByText('Galicia')

    await user.click(screen.getByRole('button', { name: 'Add institution' }))
    await screen.findByRole('dialog')

    // Step 1: name is required to advance.
    const next = screen.getByRole('button', { name: 'Next' })
    expect(next).toBeDisabled()
    await user.type(screen.getByRole('textbox', { name: /Name/ }), 'Brubank')
    expect(next).toBeEnabled()
    await user.click(next)

    // Step 2: with nothing queued, Skip creates the institution with no accounts.
    await screen.findByRole('button', { name: 'Skip' })
    await user.click(screen.getByRole('button', { name: 'Skip' }))

    await waitFor(() => expect(mockCreateInstitution).toHaveBeenCalledTimes(1))
    expect(mockCreateInstitution).toHaveBeenCalledWith({
      name: 'Brubank',
      type: 'bank',
    })
    // No accounts were created on a skip.
    expect(mockCreateAccount).not.toHaveBeenCalled()
    // Calm success is shown, not a crash.
    expect(await screen.findByText('Brubank is ready')).toBeInTheDocument()
  })

  test('the wizard queues ARS + USD accounts and finish creates the institution then both accounts', async () => {
    const user = userEvent.setup()
    mockCreateInstitution.mockResolvedValue({
      id: 'inst-new',
      name: 'Brubank',
      type: 'bank',
    })
    renderAccountsPage()
    await screen.findByText('Galicia')

    await user.click(screen.getByRole('button', { name: 'Add institution' }))
    await screen.findByRole('dialog')
    await user.type(screen.getByRole('textbox', { name: /Name/ }), 'Brubank')
    await user.click(screen.getByRole('button', { name: 'Next' }))

    // Queue an ARS and a USD account.
    await user.click(screen.getByRole('button', { name: 'Add ARS account' }))
    await user.click(screen.getByRole('button', { name: 'Add USD account' }))

    const balanceFields = screen.getAllByRole('textbox', {
      name: /Opening balance/,
    })
    await user.type(balanceFields[0], '150000')
    await user.type(balanceFields[1], '1200')

    await user.click(screen.getByRole('button', { name: 'Finish' }))

    // Institution is created first.
    await waitFor(() => expect(mockCreateInstitution).toHaveBeenCalledTimes(1))
    // Then both accounts, attached to the new institution id.
    await waitFor(() => expect(mockCreateAccount).toHaveBeenCalledTimes(2))
    expect(mockCreateAccount).toHaveBeenNthCalledWith(1, {
      institutionId: 'inst-new',
      currency: 'ARS',
      openingBalance: '150000.00',
    })
    expect(mockCreateAccount).toHaveBeenNthCalledWith(2, {
      institutionId: 'inst-new',
      currency: 'USD',
      openingBalance: '1200.00',
    })
    expect(await screen.findByText('Brubank is ready')).toBeInTheDocument()
  })

  test('on a partial account failure the wizard keeps the institution and retries only the failed account', async () => {
    const user = userEvent.setup()
    mockCreateInstitution.mockResolvedValue({
      id: 'inst-new',
      name: 'Brubank',
      type: 'bank',
    })
    // First account (ARS) succeeds; second (USD) fails, then succeeds on retry.
    mockCreateAccount
      .mockResolvedValueOnce(ACCOUNTS[0])
      .mockRejectedValueOnce(new AccountApiError(503, 'unavailable'))
      .mockResolvedValueOnce(ACCOUNTS[1])

    renderAccountsPage()
    await screen.findByText('Galicia')

    await user.click(screen.getByRole('button', { name: 'Add institution' }))
    await screen.findByRole('dialog')
    await user.type(screen.getByRole('textbox', { name: /Name/ }), 'Brubank')
    await user.click(screen.getByRole('button', { name: 'Next' }))

    await user.click(screen.getByRole('button', { name: 'Add ARS account' }))
    await user.click(screen.getByRole('button', { name: 'Add USD account' }))
    const balanceFields = screen.getAllByRole('textbox', {
      name: /Opening balance/,
    })
    await user.type(balanceFields[0], '150000')
    await user.type(balanceFields[1], '1200')

    await user.click(screen.getByRole('button', { name: 'Finish' }))

    // The institution is created once and is NOT discarded on the failure.
    await waitFor(() => expect(mockCreateInstitution).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mockCreateAccount).toHaveBeenCalledTimes(2))
    // The partial-failure message surfaces and the wizard offers a retry.
    expect(
      await screen.findByText(/the institution was created, but some accounts/i),
    ).toBeInTheDocument()
    const retry = await screen.findByRole('button', {
      name: 'Retry failed accounts',
    })

    // Retry re-POSTs ONLY the failed (USD) account — institution is not re-created.
    await user.click(retry)
    await waitFor(() => expect(mockCreateAccount).toHaveBeenCalledTimes(3))
    expect(mockCreateInstitution).toHaveBeenCalledTimes(1)
    // The retried call is the USD account.
    expect(mockCreateAccount).toHaveBeenNthCalledWith(3, {
      institutionId: 'inst-new',
      currency: 'USD',
      openingBalance: '1200.00',
    })
    expect(await screen.findByText('Brubank is ready')).toBeInTheDocument()
  })

  test('"Add account" under an institution POSTs the currency + balance body', async () => {
    const user = userEvent.setup()
    renderAccountsPage()
    await screen.findByText('Galicia')

    // Scope to Galicia's section explicitly — institution ORDER now follows
    // net-worth subtotal (Deel sorts first here), so "first button" is brittle.
    const galiciaSection = screen
      .getByRole('heading', { level: 2, name: 'Galicia' })
      .closest('section') as HTMLElement
    await user.click(
      within(galiciaSection).getByRole('button', { name: 'Add account' }),
    )

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
