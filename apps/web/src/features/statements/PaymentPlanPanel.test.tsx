/**
 * Interaction tests for the payment-plan panel + register-card flow (ADR-188/189/190).
 *
 * These render the {@link StatementReviewTable} (the panel's host) with the
 * accounts / institutions / net-worth reads mocked so the plan + match are
 * deterministic. They assert AC-critical behaviors:
 *   - the panel shows per-currency NEED / AVAILABLE + a concrete transfer list;
 *   - the "Pending — due {date}" label appears when the due date is in the future;
 *   - the plan recomputes when a kept line is toggled off (NEED drops);
 *   - changing the main / pay-from account recomputes the transfer suggestion;
 *   - "Register this card" opens a prefilled wizard whose confirm posts an
 *     institution with type=card + brand + last4 and one account per statement
 *     currency (ADR-190).
 *
 * English-pinned (ADR-105); no network — the accounts client is mocked.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '../../test/renderWithProviders'
import type { StatementParse } from '../../api/statementsClient'
import { StatementReviewTable } from './StatementReviewTable'

const {
  accountsListMock,
  institutionsListMock,
  netWorthMock,
  createInstitutionMock,
  createAccountMock,
} = vi.hoisted(() => ({
  accountsListMock: vi.fn(),
  institutionsListMock: vi.fn(),
  netWorthMock: vi.fn(),
  createInstitutionMock: vi.fn(),
  createAccountMock: vi.fn(),
}))

vi.mock('../../api/accountsClient', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/accountsClient')>(
      '../../api/accountsClient',
    )
  return {
    ...actual,
    accountsClient: {
      ...actual.accountsClient,
      list: accountsListMock,
      listInstitutions: institutionsListMock,
      netWorth: netWorthMock,
      createInstitution: createInstitutionMock,
      create: createAccountMock,
    },
  }
})

/** A net-worth account row (native balance) for the AVAILABLE pool. */
function nwAccount(
  id: string,
  institutionName: string,
  type: string,
  currency: string,
  balance: string,
) {
  return {
    id,
    institutionId: `inst-${id}`,
    institutionName,
    type,
    currency,
    balance,
    balanceConverted: balance,
  }
}

/** An accounts-list leaf mirroring a net-worth account. */
function acctLeaf(
  id: string,
  institutionName: string,
  type: string,
  currency: string,
  openingBalance: string,
) {
  return {
    id,
    institutionId: `inst-${id}`,
    institutionName,
    type,
    currency,
    openingBalance,
  }
}

/** Wrap a flat accounts list in an empty-liabilities net-worth read. */
function netWorthWith(accounts: ReturnType<typeof nwAccount>[]) {
  return {
    total: '0',
    currency: 'ARS',
    accounts,
    liabilities: {
      installments: '0',
      installmentsNative: { ars: '0', usd: '0' },
      ccBalance: null,
      ccBalanceNative: { ars: '0', usd: '0' },
      other: null,
      otherNative: { ars: '0', usd: '0' },
      total: '0',
    },
    netAfterLiabilities: '0',
  }
}

/** A USD statement (two USD lines) with a future due date. */
function usdParse(): StatementParse {
  return {
    status: 'ok',
    duplicate: false,
    bankName: 'Galicia',
    network: 'VISA',
    cardLast4: '5771',
    card: 'VISA ·5771',
    periodClose: '2026-07-01',
    periodDue: '2999-12-31',
    naturalKey: null,
    lines: [
      {
        id: '0',
        occurredOn: '2026-07-05',
        name: 'AWS',
        amount: 0,
        currency: 'USD',
        usdAmount: 4000,
        lineKind: 'purchase',
        include: true,
      },
      {
        id: '1',
        occurredOn: '2026-07-05',
        name: 'GitHub',
        amount: 0,
        currency: 'USD',
        usdAmount: 2000,
        lineKind: 'purchase',
        include: true,
      },
    ],
    document: { pdfBase64: 'AAA', contentType: 'application/pdf' },
  }
}

beforeEach(() => {
  accountsListMock.mockResolvedValue([])
  institutionsListMock.mockResolvedValue([])
  netWorthMock.mockResolvedValue(netWorthWith([]))
  createInstitutionMock.mockResolvedValue({
    id: 'new-inst',
    name: 'Galicia',
    type: 'card',
    brand: 'VISA',
    last4: '5771',
  })
  createAccountMock.mockResolvedValue({
    id: 'new-acct',
    institutionId: 'new-inst',
    institutionName: 'Galicia',
    type: 'card',
    currency: 'USD',
    openingBalance: '0',
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

const noop = () => {}

describe('PaymentPlanPanel (ADR-188/189)', () => {
  test('shows per-currency need / available + a greedy transfer list and a pending label', async () => {
    // Two USD funding accounts: Galicia 4,000 (main default) + Deel 3,000.
    // Need 6,000 → shortfall 2,000, pulled from Deel.
    const funding = [
      nwAccount('gal', 'Galicia', 'bank', 'USD', '4000'),
      nwAccount('deel', 'Deel', 'wallet', 'USD', '3000'),
    ]
    accountsListMock.mockResolvedValue([
      acctLeaf('gal', 'Galicia', 'bank', 'USD', '4000'),
      acctLeaf('deel', 'Deel', 'wallet', 'USD', '3000'),
    ])
    netWorthMock.mockResolvedValue(netWorthWith(funding))

    renderWithProviders(
      <StatementReviewTable parse={usdParse()} onImport={noop} isImporting={false} />,
    )

    const region = await screen.findByRole('region', { name: 'Card payment plan' })
    // Need = 4,000 + 2,000 = 6,000 (from the kept lines, available immediately).
    expect(within(region).getByText('USD 6.000')).toBeInTheDocument()
    // Available = 7,000 once the accounts + net-worth reads resolve.
    await waitFor(() =>
      expect(within(region).getByText('USD 7.000')).toBeInTheDocument(),
    )
    // The concrete transfer sentence: move the 2,000 shortfall from Deel.
    expect(
      within(region).getByText('Move USD 2.000 from Deel → Galicia'),
    ).toBeInTheDocument()
    // Pending label for the far-future due date.
    expect(within(region).getByText(/Pending — due/)).toBeInTheDocument()
  })

  test('recomputes the need when a kept line is toggled off', async () => {
    const funding = [nwAccount('gal', 'Galicia', 'bank', 'USD', '10000')]
    accountsListMock.mockResolvedValue([
      acctLeaf('gal', 'Galicia', 'bank', 'USD', '10000'),
    ])
    netWorthMock.mockResolvedValue(netWorthWith(funding))
    const user = userEvent.setup()

    renderWithProviders(
      <StatementReviewTable parse={usdParse()} onImport={noop} isImporting={false} />,
    )

    const region = await screen.findByRole('region', { name: 'Card payment plan' })
    expect(within(region).getByText('USD 6.000')).toBeInTheDocument()

    // Toggle the 2,000 GitHub line off → need drops to 4,000.
    await user.click(
      screen.getByRole('switch', { name: /Skip GitHub/ }),
    )
    await waitFor(() =>
      expect(within(region).getByText('USD 4.000')).toBeInTheDocument(),
    )
  })

  test('changing the main pay-from account recomputes the transfer', async () => {
    // Galicia 4,000 (default main) + Deel 3,000. Need 6,000.
    const funding = [
      nwAccount('gal', 'Galicia', 'bank', 'USD', '4000'),
      nwAccount('deel', 'Deel', 'wallet', 'USD', '3000'),
    ]
    accountsListMock.mockResolvedValue([
      acctLeaf('gal', 'Galicia', 'bank', 'USD', '4000'),
      acctLeaf('deel', 'Deel', 'wallet', 'USD', '3000'),
    ])
    netWorthMock.mockResolvedValue(netWorthWith(funding))
    const user = userEvent.setup()

    renderWithProviders(
      <StatementReviewTable parse={usdParse()} onImport={noop} isImporting={false} />,
    )

    const region = await screen.findByRole('region', { name: 'Card payment plan' })
    // Default main = Galicia (largest) → pull 2,000 from Deel.
    await waitFor(() =>
      expect(
        within(region).getByText('Move USD 2.000 from Deel → Galicia'),
      ).toBeInTheDocument(),
    )

    // Switch the main to Deel (3,000) → shortfall 3,000, pulled from Galicia.
    await user.click(within(region).getByRole('combobox', { name: /USD pay from/ }))
    await user.click(
      await screen.findByRole('option', { name: /Deel · USD 3\.000/ }),
    )
    await waitFor(() =>
      expect(
        within(region).getByText('Move USD 3.000 from Galicia → Deel'),
      ).toBeInTheDocument(),
    )
  })
})

describe('Register this card (ADR-190)', () => {
  test('prefills the wizard and posts type=card + brand + last4 with the statement currencies', async () => {
    // No card account exists → the USD currency shows "no match" + register action.
    accountsListMock.mockResolvedValue([])
    institutionsListMock.mockResolvedValue([])
    netWorthMock.mockResolvedValue(netWorthWith([]))
    const user = userEvent.setup()

    renderWithProviders(
      <StatementReviewTable parse={usdParse()} onImport={noop} isImporting={false} />,
    )

    // The register action lives in the account-attach section for the unmatched USD.
    const registerButton = await screen.findByRole('button', {
      name: 'Register this card',
    })
    await user.click(registerButton)

    // The dialog is prefilled from the parse.
    const dialog = await screen.findByRole('dialog', { name: 'Register this card' })
    expect(within(dialog).getByDisplayValue('Galicia')).toBeInTheDocument()
    expect(within(dialog).getByDisplayValue('VISA')).toBeInTheDocument()
    expect(within(dialog).getByDisplayValue('5771')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Register card' }))

    // The institution POST carries type=card + brand + last4 (ADR-190).
    await waitFor(() => expect(createInstitutionMock).toHaveBeenCalledTimes(1))
    expect(createInstitutionMock).toHaveBeenCalledWith({
      name: 'Galicia',
      type: 'card',
      brand: 'VISA',
      last4: '5771',
    })
    // One account per currency present in the statement (USD only here).
    await waitFor(() => expect(createAccountMock).toHaveBeenCalledTimes(1))
    expect(createAccountMock).toHaveBeenCalledWith(
      expect.objectContaining({ institutionId: 'new-inst', currency: 'USD' }),
    )
  })

  test('blocks confirm and does not POST when last4 has fewer than 4 digits', async () => {
    accountsListMock.mockResolvedValue([])
    institutionsListMock.mockResolvedValue([])
    netWorthMock.mockResolvedValue(netWorthWith([]))
    const user = userEvent.setup()

    renderWithProviders(
      <StatementReviewTable parse={usdParse()} onImport={noop} isImporting={false} />,
    )

    await user.click(
      await screen.findByRole('button', { name: 'Register this card' }),
    )
    const dialog = await screen.findByRole('dialog', { name: 'Register this card' })

    // Reduce the prefilled 5771 to a 2-digit value → invalid.
    const last4 = within(dialog).getByLabelText('Last 4 digits')
    await user.clear(last4)
    await user.type(last4, '57')

    // The field shows a calm inline error and the confirm is disabled.
    expect(
      within(dialog).getByText('Enter the 4 digits, or leave this blank.'),
    ).toBeInTheDocument()
    const confirm = within(dialog).getByRole('button', { name: 'Register card' })
    // The disabled confirm cannot be activated → nothing is posted (the server
    // 422 stays the backstop, but we never reach it with a client-invalid last4).
    expect(confirm).toBeDisabled()
    expect(createInstitutionMock).not.toHaveBeenCalled()
    expect(createAccountMock).not.toHaveBeenCalled()
  })

  test('confirms when last4 is corrected back to 4 digits', async () => {
    accountsListMock.mockResolvedValue([])
    institutionsListMock.mockResolvedValue([])
    netWorthMock.mockResolvedValue(netWorthWith([]))
    const user = userEvent.setup()

    renderWithProviders(
      <StatementReviewTable parse={usdParse()} onImport={noop} isImporting={false} />,
    )

    await user.click(
      await screen.findByRole('button', { name: 'Register this card' }),
    )
    const dialog = await screen.findByRole('dialog', { name: 'Register this card' })

    const last4 = within(dialog).getByLabelText('Last 4 digits')
    await user.clear(last4)
    await user.type(last4, '57')
    await user.type(last4, '71')

    // No error once it is 4 digits again; the confirm posts the identity.
    expect(
      within(dialog).queryByText('Enter the 4 digits, or leave this blank.'),
    ).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Register card' }))
    await waitFor(() => expect(createInstitutionMock).toHaveBeenCalledTimes(1))
    expect(createInstitutionMock).toHaveBeenCalledWith(
      expect.objectContaining({ last4: '5771' }),
    )
  })
})
