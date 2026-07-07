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
  createTransferMock,
  transfersListMock,
} = vi.hoisted(() => ({
  accountsListMock: vi.fn(),
  institutionsListMock: vi.fn(),
  netWorthMock: vi.fn(),
  createInstitutionMock: vi.fn(),
  createAccountMock: vi.fn(),
  createTransferMock: vi.fn(),
  transfersListMock: vi.fn(),
}))

// The Schedule action (ADR-191) fires one own-account transfer per suggested leg.
// The list feeds the projected due-date balance (ADR-193/195): pending legs shift
// what each funding account can source.
vi.mock('../../api/transfersClient', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/transfersClient')>(
      '../../api/transfersClient',
    )
  return {
    ...actual,
    transfersClient: {
      ...actual.transfersClient,
      list: transfersListMock,
      create: createTransferMock,
      remove: vi.fn(),
    },
  }
})

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
  transfersListMock.mockResolvedValue([])
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
  createTransferMock.mockResolvedValue({
    transfer: {
      id: 'tr-new',
      fromAccountId: 'deel',
      toAccountId: 'gal',
      amountOut: '2000.00',
      amountIn: '2000.00',
      occurredOn: '2999-12-31',
    },
    feeTransactionIds: [],
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

const noop = () => {}

/** Render the review host for a USD statement and resolve the plan region. */
async function renderAndFindPlan() {
  renderWithProviders(
    <StatementReviewTable parse={usdParse()} onImport={noop} isImporting={false} />,
  )
  return screen.findByRole('region', { name: 'Card payment plan' })
}

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

  test('a pending outflow reduces a funding account\'s projected contribution (ADR-193/195)', async () => {
    // Galicia 4,000 (main) + Deel 3,000 as-of-today → AVAILABLE would be 7,000 and
    // the 2,000 shortfall would pull cleanly from Deel. But Deel already has a
    // scheduled (future-dated, ADR-191) OUTFLOW of 2,000: its PROJECTED balance is
    // 3,000 − 2,000 = 1,000, so it can no longer source the full 2,000. AVAILABLE
    // drops to 4,000 + 1,000 = 5,000 and the plan is left 1,000 short — proving the
    // planner now sources against the projected (commitment-aware) balance.
    const funding = [
      nwAccount('gal', 'Galicia', 'bank', 'USD', '4000'),
      nwAccount('deel', 'Deel', 'wallet', 'USD', '3000'),
    ]
    accountsListMock.mockResolvedValue([
      acctLeaf('gal', 'Galicia', 'bank', 'USD', '4000'),
      acctLeaf('deel', 'Deel', 'wallet', 'USD', '3000'),
    ])
    netWorthMock.mockResolvedValue(netWorthWith(funding))
    transfersListMock.mockResolvedValue([
      {
        // A scheduled payment OUT of Deel to an account outside the funding pool
        // (e.g. an external / card destination) — so it debits Deel's projection
        // WITHOUT crediting any funding account back (no self-cancelling top-up).
        id: 'pending-out',
        fromAccountId: 'deel',
        toAccountId: 'external-x',
        amountOut: '2000.00',
        amountIn: '2000.00',
        occurredOn: '2999-12-30',
      },
    ])

    const region = await renderAndFindPlan()
    await waitFor(() => expect(transfersListMock).toHaveBeenCalled())
    // AVAILABLE reflects the projection: 4,000 (Galicia) + 1,000 (Deel projected).
    await waitFor(() =>
      expect(within(region).getByText('USD 5.000')).toBeInTheDocument(),
    )
    // Deel can only supply its projected 1,000 toward the 2,000 shortfall.
    expect(
      within(region).getByText('Move USD 1.000 from Deel → Galicia'),
    ).toBeInTheDocument()
    // The remaining 1,000 is unreachable — the plan is no longer fully coverable.
    expect(
      within(region).getByText('Still short by USD 1.000 after all your USD accounts.'),
    ).toBeInTheDocument()
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

/** A USD statement with a PAST due date (statement already due). */
function pastDueParse(): StatementParse {
  return { ...usdParse(), periodClose: '2020-01-01', periodDue: '2020-01-10' }
}

describe('Schedule transfers (ADR-191)', () => {
  test('schedules the exact suggested leg as a future-dated transfer (occurredOn = due date)', async () => {
    // Galicia 4,000 (main default) + Deel 3,000. Need 6,000 → pull 2,000 from Deel.
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

    const { queryClient } = renderWithProviders(
      <StatementReviewTable parse={usdParse()} onImport={noop} isImporting={false} />,
    )
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    const region = await screen.findByRole('region', { name: 'Card payment plan' })
    // Wait for the coverable plan to resolve so the Schedule button appears.
    const scheduleButton = await within(region).findByRole('button', {
      name: 'Schedule these transfers',
    })
    await user.click(scheduleButton)

    await waitFor(() => expect(createTransferMock).toHaveBeenCalledTimes(1))
    const body = createTransferMock.mock.calls[0][0]
    // The exact greedy leg: 2,000 from Deel → the main Galicia, same currency.
    expect(body.fromAccountId).toBe('deel')
    expect(body.toAccountId).toBe('gal')
    expect(body.amountOut).toBe('2000.00')
    expect(body.amountIn).toBe('2000.00')
    // today (2026) < the far-future due date (2999) → dated on the due date so it
    // stays pending until then (ADR-191/186).
    expect(body.occurredOn).toBe('2999-12-31')
    expect(body.note).toBe('Statement payment top-up')

    // The pending reservation must refresh: transfers + accounts (net-worth) keys.
    const invalidatedKeys = invalidateSpy.mock.calls.map(
      (call) => (call[0] as { queryKey: unknown[] }).queryKey[0],
    )
    expect(invalidatedKeys).toContain('transfers')
    expect(invalidatedKeys).toContain('accounts')

    // The panel reflects the completed schedule (calm confirmation).
    expect(await within(region).findByText('Transfers scheduled')).toBeInTheDocument()
  })

  test('dates the transfer TODAY when the statement is already past due', async () => {
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
      <StatementReviewTable parse={pastDueParse()} onImport={noop} isImporting={false} />,
    )

    const region = await screen.findByRole('region', { name: 'Card payment plan' })
    await user.click(
      await within(region).findByRole('button', { name: 'Schedule these transfers' }),
    )

    await waitFor(() => expect(createTransferMock).toHaveBeenCalledTimes(1))
    const today = new Date()
    const y = today.getFullYear()
    const m = String(today.getMonth() + 1).padStart(2, '0')
    const d = String(today.getDate()).padStart(2, '0')
    // Past due → dated today (nothing to defer, ADR-191).
    expect(createTransferMock.mock.calls[0][0].occurredOn).toBe(`${y}-${m}-${d}`)
  })

  test('no Schedule button when the main account already covers the balance', async () => {
    // Galicia alone (10,000) covers the 6,000 need → sufficient, nothing to schedule.
    const funding = [nwAccount('gal', 'Galicia', 'bank', 'USD', '10000')]
    accountsListMock.mockResolvedValue([
      acctLeaf('gal', 'Galicia', 'bank', 'USD', '10000'),
    ])
    netWorthMock.mockResolvedValue(netWorthWith(funding))

    renderWithProviders(
      <StatementReviewTable parse={usdParse()} onImport={noop} isImporting={false} />,
    )

    const region = await screen.findByRole('region', { name: 'Card payment plan' })
    // The Sufficient badge resolves; the Schedule button never appears.
    await within(region).findByText('Sufficient')
    expect(
      within(region).queryByRole('button', { name: 'Schedule these transfers' }),
    ).toBeNull()
  })

  test('no Schedule button when a residual gap remains (suggest-only)', async () => {
    // Need 6,000 but only 4,000 total across USD accounts → residual gap 2,000.
    const funding = [nwAccount('gal', 'Galicia', 'bank', 'USD', '4000')]
    accountsListMock.mockResolvedValue([
      acctLeaf('gal', 'Galicia', 'bank', 'USD', '4000'),
    ])
    netWorthMock.mockResolvedValue(netWorthWith(funding))

    renderWithProviders(
      <StatementReviewTable parse={usdParse()} onImport={noop} isImporting={false} />,
    )

    const region = await screen.findByRole('region', { name: 'Card payment plan' })
    // The residual note appears; the Schedule button is withheld.
    await within(region).findByText(/Still short by/)
    expect(
      within(region).queryByRole('button', { name: 'Schedule these transfers' }),
    ).toBeNull()
    expect(createTransferMock).not.toHaveBeenCalled()
  })
})

/**
 * A card institution matching the usdParse identity (VISA · 5771) so the import
 * auto-attaches its USD card account (ADR-184/190). The attached card account is
 * the destination of the Slice B payment leg (ADR-196).
 */
function cardInstitution() {
  return {
    id: 'inst-card',
    name: 'Galicia',
    type: 'card' as const,
    brand: 'VISA',
    last4: '5771',
  }
}

/** The USD card account under the matched card institution (payment destination). */
function usdCardAccount() {
  return {
    id: 'card-usd',
    institutionId: 'inst-card',
    institutionName: 'Galicia',
    type: 'card' as const,
    currency: 'USD' as const,
    openingBalance: '0',
  }
}

describe('Schedule payment leg (Slice B, ADR-196)', () => {
  test('fires the payment leg (main → attached card, full need) as the LAST leg, after the top-up', async () => {
    // Two USD funding accounts: Galicia 4,000 (main default) + Deel 3,000. Need
    // 6,000 → top-up 2,000 from Deel → Galicia, THEN the payment leg 6,000 from
    // Galicia → the attached card (VISA · 5771 matches usdParse).
    const funding = [
      nwAccount('gal', 'Galicia Bank', 'bank', 'USD', '4000'),
      nwAccount('deel', 'Deel', 'wallet', 'USD', '3000'),
    ]
    accountsListMock.mockResolvedValue([
      acctLeaf('gal', 'Galicia Bank', 'bank', 'USD', '4000'),
      acctLeaf('deel', 'Deel', 'wallet', 'USD', '3000'),
      usdCardAccount(),
    ])
    institutionsListMock.mockResolvedValue([cardInstitution()])
    netWorthMock.mockResolvedValue(netWorthWith(funding))
    const user = userEvent.setup()

    const region = await renderAndFindPlan()
    await user.click(
      await within(region).findByRole('button', { name: 'Schedule these transfers' }),
    )

    // Two POSTs: the top-up (leg 1) then the payment (leg 2, LAST).
    await waitFor(() => expect(createTransferMock).toHaveBeenCalledTimes(2))
    const [topUp, payment] = createTransferMock.mock.calls.map((c) => c[0])
    // Leg 1 = the greedy top-up: 2,000 Deel → the main Galicia bank.
    expect(topUp.fromAccountId).toBe('deel')
    expect(topUp.toAccountId).toBe('gal')
    expect(topUp.amountOut).toBe('2000.00')
    expect(topUp.note).toBe('Statement payment top-up')
    // Leg 2 (LAST) = the payment: full need 6,000 from the main → the attached card.
    expect(payment.fromAccountId).toBe('gal')
    expect(payment.toAccountId).toBe('card-usd')
    expect(payment.amountOut).toBe('6000.00')
    expect(payment.amountIn).toBe('6000.00')
    // Same future due date → stays pending (ADR-191), so it reserves the main.
    expect(payment.occurredOn).toBe('2999-12-31')
    expect(payment.note).toBe('Card payment')

    expect(await within(region).findByText('Transfers scheduled')).toBeInTheDocument()
  })

  test('payment-only plan: main already covers the balance + attached card → the Schedule button fires ONLY the payment leg', async () => {
    // Galicia alone (10,000) covers the full 6,000 need → the currency is sufficient
    // (zero top-ups). The card is attached (VISA · 5771). This is the PRIMARY Slice B
    // case — "I have the money, just earmark the card payment so the next card's plan
    // sees it gone." The Schedule button MUST appear (it no longer gates on a top-up)
    // and firing must create exactly the payment leg (main → card, full need), no
    // top-up legs.
    const funding = [nwAccount('gal', 'Galicia Bank', 'bank', 'USD', '10000')]
    accountsListMock.mockResolvedValue([
      acctLeaf('gal', 'Galicia Bank', 'bank', 'USD', '10000'),
      usdCardAccount(),
    ])
    institutionsListMock.mockResolvedValue([cardInstitution()])
    netWorthMock.mockResolvedValue(netWorthWith(funding))
    const user = userEvent.setup()

    const region = await renderAndFindPlan()
    // The Sufficient badge resolves (no shortfall) yet the Schedule affordance is
    // now offered because there is a payment leg to earmark.
    await within(region).findByText('Sufficient')
    const scheduleButton = await within(region).findByRole('button', {
      name: 'Schedule these transfers',
    })
    // The hint copy reads sensibly for a payment-only schedule (no top-up wording).
    expect(
      within(region).getByText(
        'Move the funds now as transfers dated for the due date — they stay pending until then.',
      ),
    ).toBeInTheDocument()

    await user.click(scheduleButton)

    // Exactly ONE POST: the payment leg. No top-up (the main already covered it).
    await waitFor(() => expect(createTransferMock).toHaveBeenCalledTimes(1))
    const payment = createTransferMock.mock.calls[0][0]
    expect(payment.fromAccountId).toBe('gal')
    expect(payment.toAccountId).toBe('card-usd')
    expect(payment.amountOut).toBe('6000.00')
    expect(payment.amountIn).toBe('6000.00')
    expect(payment.occurredOn).toBe('2999-12-31')
    expect(payment.note).toBe('Card payment')
    // No top-up leg was fired.
    const topUpCalls = createTransferMock.mock.calls.filter(
      (c) => c[0].note === 'Statement payment top-up',
    )
    expect(topUpCalls).toHaveLength(0)

    // The calm confirmation, with the generalized (non-"top-up") detail copy.
    expect(await within(region).findByText('Transfers scheduled')).toBeInTheDocument()
    expect(
      within(region).getByText(
        'Your transfers are scheduled for the due date. They stay pending until then.',
      ),
    ).toBeInTheDocument()
  })

  test('retry after the succeeded top-up shifts the signature: the top-up is NOT re-fired and the payment fires once', async () => {
    // Galicia 4,000 (main) + Deel 3,000 + attached card. Legs: top-up (Deel 2,000)
    // then payment (Galicia 6,000). Attempt 1: top-up succeeds, payment fails. Before
    // the retry the transfers-list mock is re-driven to INCLUDE the succeeded top-up
    // (as the real invalidation would surface it). That pending inflow reshapes the
    // projection — SHIFTING legSignature — but the projection self-heals: Deel's
    // outflow + Galicia's inflow net out so the plan still needs the same payment.
    // The retry must fire ONLY the payment leg (the top-up is not re-created).
    const funding = [
      nwAccount('gal', 'Galicia Bank', 'bank', 'USD', '4000'),
      nwAccount('deel', 'Deel', 'wallet', 'USD', '3000'),
    ]
    accountsListMock.mockResolvedValue([
      acctLeaf('gal', 'Galicia Bank', 'bank', 'USD', '4000'),
      acctLeaf('deel', 'Deel', 'wallet', 'USD', '3000'),
      usdCardAccount(),
    ])
    institutionsListMock.mockResolvedValue([cardInstitution()])
    netWorthMock.mockResolvedValue(netWorthWith(funding))
    // Attempt 1: top-up ok, payment fails. Attempt 2: payment ok.
    createTransferMock
      .mockResolvedValueOnce({
        transfer: {
          id: 'tr-topup',
          fromAccountId: 'deel',
          toAccountId: 'gal',
          amountOut: '2000.00',
          amountIn: '2000.00',
          occurredOn: '2999-12-31',
        },
        feeTransactionIds: [],
      })
      .mockRejectedValueOnce(new Error('server 500'))
      .mockResolvedValueOnce({
        transfer: {
          id: 'tr-pay',
          fromAccountId: 'gal',
          toAccountId: 'card-usd',
          amountOut: '6000.00',
          amountIn: '6000.00',
          occurredOn: '2999-12-31',
        },
        feeTransactionIds: [],
      })
    const user = userEvent.setup()

    const region = await renderAndFindPlan()
    await user.click(
      await within(region).findByRole('button', { name: 'Schedule these transfers' }),
    )
    await waitFor(() => expect(createTransferMock).toHaveBeenCalledTimes(2))
    await within(region).findByRole('alert')

    // Re-drive the transfers list to surface the succeeded top-up as a pending leg
    // (mirrors the post-mutation invalidation). This shifts the projected balances
    // and therefore legSignature — the safety net is the resume cursor keyed to the
    // succeeded top-up, plus the projection self-heal (Deel −2,000 / Galicia +2,000
    // net to the same plan).
    transfersListMock.mockResolvedValue([
      {
        id: 'tr-topup',
        fromAccountId: 'deel',
        toAccountId: 'gal',
        amountOut: '2000.00',
        amountIn: '2000.00',
        occurredOn: '2999-12-31',
      },
    ])

    // Retry: fire only the remaining payment leg.
    await user.click(
      within(region).getByRole('button', { name: 'Schedule these transfers' }),
    )
    await waitFor(() => expect(createTransferMock).toHaveBeenCalledTimes(3))
    // The succeeded top-up (Deel → Galicia) is NOT re-created: exactly one Deel POST.
    const deelCalls = createTransferMock.mock.calls.filter(
      (c) => c[0].fromAccountId === 'deel',
    )
    expect(deelCalls).toHaveLength(1)
    // The payment leg SUCCEEDED exactly once on the retry (call 3), targeting the card.
    expect(createTransferMock.mock.calls[2][0].fromAccountId).toBe('gal')
    expect(createTransferMock.mock.calls[2][0].toAccountId).toBe('card-usd')
    expect(createTransferMock.mock.calls[2][0].amountOut).toBe('6000.00')
    // Total = 3: one top-up (ok), one payment (fail), one payment (retry ok). No leg
    // was ever duplicated — the succeeded top-up stayed sent across the signature
    // shift. (The panel may re-arm afterwards as the now-committed funds re-project
    // the plan short; the money-correctness lock — no duplicate — is what matters.)
    expect(createTransferMock).toHaveBeenCalledTimes(3)
  })

  test('skips the payment leg when no card account is attached, still fires the top-up', async () => {
    // Same funding, but NO card institution/account → the currency has no attached
    // card → the payment leg is skipped; only the top-up fires (don't invent a card).
    const funding = [
      nwAccount('gal', 'Galicia', 'bank', 'USD', '4000'),
      nwAccount('deel', 'Deel', 'wallet', 'USD', '3000'),
    ]
    accountsListMock.mockResolvedValue([
      acctLeaf('gal', 'Galicia', 'bank', 'USD', '4000'),
      acctLeaf('deel', 'Deel', 'wallet', 'USD', '3000'),
    ])
    institutionsListMock.mockResolvedValue([])
    netWorthMock.mockResolvedValue(netWorthWith(funding))
    const user = userEvent.setup()

    const region = await renderAndFindPlan()
    await user.click(
      await within(region).findByRole('button', { name: 'Schedule these transfers' }),
    )

    // Exactly ONE POST: the top-up. No payment leg (no destination card).
    await waitFor(() => expect(createTransferMock).toHaveBeenCalledTimes(1))
    const only = createTransferMock.mock.calls[0][0]
    expect(only.fromAccountId).toBe('deel')
    expect(only.toAccountId).toBe('gal')
    expect(only.note).toBe('Statement payment top-up')
    // No call targeted a card account / carried the payment note.
    const paymentCalls = createTransferMock.mock.calls.filter(
      (c) => c[0].note === 'Card payment',
    )
    expect(paymentCalls).toHaveLength(0)
  })

  test('retry after a mid-batch failure includes the payment leg without duplicating', async () => {
    // Galicia 4,000 (main) + Deel 3,000 + attached card. Legs: top-up (Deel 2,000)
    // then payment (Galicia 6,000). Attempt 1: top-up succeeds, payment fails.
    // Attempt 2: the payment leg fires once; the top-up is NOT re-fired.
    const funding = [
      nwAccount('gal', 'Galicia Bank', 'bank', 'USD', '4000'),
      nwAccount('deel', 'Deel', 'wallet', 'USD', '3000'),
    ]
    accountsListMock.mockResolvedValue([
      acctLeaf('gal', 'Galicia Bank', 'bank', 'USD', '4000'),
      acctLeaf('deel', 'Deel', 'wallet', 'USD', '3000'),
      usdCardAccount(),
    ])
    institutionsListMock.mockResolvedValue([cardInstitution()])
    netWorthMock.mockResolvedValue(netWorthWith(funding))
    createTransferMock
      .mockResolvedValueOnce({
        transfer: {
          id: 'tr-topup',
          fromAccountId: 'deel',
          toAccountId: 'gal',
          amountOut: '2000.00',
          amountIn: '2000.00',
          occurredOn: '2999-12-31',
        },
        feeTransactionIds: [],
      })
      .mockRejectedValueOnce(new Error('server 500'))
      .mockResolvedValueOnce({
        transfer: {
          id: 'tr-pay',
          fromAccountId: 'gal',
          toAccountId: 'card-usd',
          amountOut: '6000.00',
          amountIn: '6000.00',
          occurredOn: '2999-12-31',
        },
        feeTransactionIds: [],
      })
    const user = userEvent.setup()

    const region = await renderAndFindPlan()
    await user.click(
      await within(region).findByRole('button', { name: 'Schedule these transfers' }),
    )
    // Attempt 1: two POSTs (top-up ok, payment fails) then error.
    await waitFor(() => expect(createTransferMock).toHaveBeenCalledTimes(2))
    await within(region).findByRole('alert')

    // Retry (same plan): resume from the un-sent payment leg only.
    await user.click(
      within(region).getByRole('button', { name: 'Schedule these transfers' }),
    )
    await waitFor(() => expect(createTransferMock).toHaveBeenCalledTimes(3))
    // The third POST is the payment leg (Galicia → card, 6,000) — fired exactly once.
    expect(createTransferMock.mock.calls[2][0].fromAccountId).toBe('gal')
    expect(createTransferMock.mock.calls[2][0].toAccountId).toBe('card-usd')
    expect(createTransferMock.mock.calls[2][0].amountOut).toBe('6000.00')
    // The succeeded top-up (Deel) is NOT re-fired: exactly one Deel POST total —
    // the resume cursor advanced past it, so the retry never duplicates it.
    const deelCalls = createTransferMock.mock.calls.filter(
      (c) => c[0].fromAccountId === 'deel',
    )
    expect(deelCalls).toHaveLength(1)
    // The payment leg only SUCCEEDED once — total POSTs = 3 (top-up ok, payment
    // fail, payment ok), so exactly one top-up + two payment attempts (the failed
    // attempt + the retry). Crucially the retry did NOT re-fire the top-up.
    expect(createTransferMock).toHaveBeenCalledTimes(3)

    expect(await within(region).findByText('Transfers scheduled')).toBeInTheDocument()
  })

  test('the payment reserves the main account: a scheduled payment appears as pendingOut, reducing the projected availability', async () => {
    // The end-to-end reservation proof (ADR-195/196). Galicia 4,000 (main) + Deel
    // 3,000. A PRIOR card payment of 6,000 is already scheduled OUT of Galicia (as
    // the Slice B payment leg would create). Galicia's projected balance is
    // 4,000 − 6,000 = −2,000 (clamped into AVAILABLE), so the pool for a SECOND
    // card's plan is Deel's 3,000 plus Galicia's (negative) projection. AVAILABLE
    // therefore drops well below the raw 7,000 — proving the reservation is seen.
    const funding = [
      nwAccount('gal', 'Galicia Bank', 'bank', 'USD', '4000'),
      nwAccount('deel', 'Deel', 'wallet', 'USD', '3000'),
    ]
    accountsListMock.mockResolvedValue([
      acctLeaf('gal', 'Galicia Bank', 'bank', 'USD', '4000'),
      acctLeaf('deel', 'Deel', 'wallet', 'USD', '3000'),
    ])
    netWorthMock.mockResolvedValue(netWorthWith(funding))
    // A prior scheduled card payment: Galicia → an external card account (outside
    // the funding pool), future-dated → pendingOut(Galicia) = 6,000.
    transfersListMock.mockResolvedValue([
      {
        id: 'prior-payment',
        fromAccountId: 'gal',
        toAccountId: 'card-usd',
        amountOut: '6000.00',
        amountIn: '6000.00',
        occurredOn: '2999-12-30',
      },
    ])

    const region = await renderAndFindPlan()
    await waitFor(() => expect(transfersListMock).toHaveBeenCalled())
    // Projected AVAILABLE = Galicia (4,000 − 6,000 = −2,000) + Deel (3,000) = 1,000.
    // Without the reservation it would read the raw 7,000; the pendingOut proves it.
    await waitFor(() =>
      expect(within(region).getByText('USD 1.000')).toBeInTheDocument(),
    )
  })
})

/**
 * A two-leg USD funding set: Galicia 4,000 (main default) + Deel 1,200 +
 * Payoneer 900. Need 6,000 → shortfall 2,000. Greedy (largest balance first):
 * leg 1 = 1,200 from Deel, leg 2 = 800 from Payoneer. Exactly two legs, no
 * residual — so the batch has a distinct "first leg" and "second leg" for the
 * resume-on-retry assertions.
 */
function twoLegFunding() {
  return [
    nwAccount('gal', 'Galicia', 'bank', 'USD', '4000'),
    nwAccount('deel', 'Deel', 'wallet', 'USD', '1200'),
    nwAccount('payo', 'Payoneer', 'wallet', 'USD', '900'),
  ]
}

function twoLegAccounts() {
  return [
    acctLeaf('gal', 'Galicia', 'bank', 'USD', '4000'),
    acctLeaf('deel', 'Deel', 'wallet', 'USD', '1200'),
    acctLeaf('payo', 'Payoneer', 'wallet', 'USD', '900'),
  ]
}

describe('Schedule resume-on-retry (money-correctness, ADR-191)', () => {
  test('a mid-batch failure POSTs only the legs before it, then leaves state error', async () => {
    accountsListMock.mockResolvedValue(twoLegAccounts())
    netWorthMock.mockResolvedValue(netWorthWith(twoLegFunding()))
    // Leg 1 (Deel 1,200) succeeds; leg 2 (Payoneer 800) fails.
    createTransferMock
      .mockResolvedValueOnce({
        transfer: {
          id: 'tr-1',
          fromAccountId: 'deel',
          toAccountId: 'gal',
          amountOut: '1200.00',
          amountIn: '1200.00',
          occurredOn: '2999-12-31',
        },
        feeTransactionIds: [],
      })
      .mockRejectedValueOnce(new Error('server 500'))
    const user = userEvent.setup()

    const region = await renderAndFindPlan()
    await user.click(
      await within(region).findByRole('button', { name: 'Schedule these transfers' }),
    )

    // Both legs were attempted (1 success + 1 failure) — no more.
    await waitFor(() => expect(createTransferMock).toHaveBeenCalledTimes(2))
    expect(createTransferMock.mock.calls[0][0].fromAccountId).toBe('deel')
    expect(createTransferMock.mock.calls[0][0].amountOut).toBe('1200.00')
    expect(createTransferMock.mock.calls[1][0].fromAccountId).toBe('payo')
    expect(createTransferMock.mock.calls[1][0].amountOut).toBe('800.00')

    // The calm error surfaces; the confirmation does NOT appear.
    expect(await within(region).findByRole('alert')).toBeInTheDocument()
    expect(within(region).queryByText('Transfers scheduled')).toBeNull()
  })

  test('retry after a mid-batch failure fires ONLY the remaining leg (no duplicate of the succeeded one)', async () => {
    accountsListMock.mockResolvedValue(twoLegAccounts())
    netWorthMock.mockResolvedValue(netWorthWith(twoLegFunding()))
    // Attempt 1: leg 1 succeeds, leg 2 fails. Attempt 2: leg 2 succeeds.
    createTransferMock
      .mockResolvedValueOnce({
        transfer: {
          id: 'tr-1',
          fromAccountId: 'deel',
          toAccountId: 'gal',
          amountOut: '1200.00',
          amountIn: '1200.00',
          occurredOn: '2999-12-31',
        },
        feeTransactionIds: [],
      })
      .mockRejectedValueOnce(new Error('server 500'))
      .mockResolvedValueOnce({
        transfer: {
          id: 'tr-2',
          fromAccountId: 'payo',
          toAccountId: 'gal',
          amountOut: '800.00',
          amountIn: '800.00',
          occurredOn: '2999-12-31',
        },
        feeTransactionIds: [],
      })
    const user = userEvent.setup()

    const region = await renderAndFindPlan()
    const scheduleButton = await within(region).findByRole('button', {
      name: 'Schedule these transfers',
    })
    await user.click(scheduleButton)
    // First attempt: two POSTs (success + failure) then error.
    await waitFor(() => expect(createTransferMock).toHaveBeenCalledTimes(2))
    await within(region).findByRole('alert')

    // Retry (same plan/signature): resume from the un-sent leg only.
    await user.click(
      within(region).getByRole('button', { name: 'Schedule these transfers' }),
    )
    // Exactly ONE more POST (the third mock call): the Payoneer 800 leg. The
    // succeeded Deel 1,200 leg is NOT re-fired — no duplicate, no over-top.
    await waitFor(() => expect(createTransferMock).toHaveBeenCalledTimes(3))
    expect(createTransferMock.mock.calls[2][0].fromAccountId).toBe('payo')
    expect(createTransferMock.mock.calls[2][0].amountOut).toBe('800.00')
    // No third call re-POSTed Deel.
    const deelCalls = createTransferMock.mock.calls.filter(
      (call) => call[0].fromAccountId === 'deel',
    )
    expect(deelCalls).toHaveLength(1)

    // The batch is now complete → the calm confirmation replaces the button.
    expect(await within(region).findByText('Transfers scheduled')).toBeInTheDocument()
  })

  test('changing the plan between attempts resets the cursor and re-fires from the start', async () => {
    accountsListMock.mockResolvedValue(twoLegAccounts())
    netWorthMock.mockResolvedValue(netWorthWith(twoLegFunding()))
    // Attempt 1: leg 1 (Deel) succeeds, leg 2 (Payoneer) fails.
    createTransferMock
      .mockResolvedValueOnce({
        transfer: {
          id: 'tr-1',
          fromAccountId: 'deel',
          toAccountId: 'gal',
          amountOut: '1200.00',
          amountIn: '1200.00',
          occurredOn: '2999-12-31',
        },
        feeTransactionIds: [],
      })
      .mockRejectedValueOnce(new Error('server 500'))
      // Attempt 2 (new plan): all subsequent legs succeed.
      .mockResolvedValue({
        transfer: {
          id: 'tr-x',
          fromAccountId: 'deel',
          toAccountId: 'gal',
          amountOut: '3000.00',
          amountIn: '3000.00',
          occurredOn: '2999-12-31',
        },
        feeTransactionIds: [],
      })
    const user = userEvent.setup()

    const region = await renderAndFindPlan()
    await user.click(
      await within(region).findByRole('button', { name: 'Schedule these transfers' }),
    )
    await waitFor(() => expect(createTransferMock).toHaveBeenCalledTimes(2))
    await within(region).findByRole('alert')

    // Change the plan: switch the main pay-from account to Deel (1,200). Now the
    // shortfall is need 6,000 − Deel 1,200 = 4,800, pulled from Galicia (4,000)
    // + Payoneer (800) → a genuinely new batch (new signature) → cursor resets.
    await user.click(within(region).getByRole('combobox', { name: /USD pay from/ }))
    await user.click(await screen.findByRole('option', { name: /Deel · USD 1\.200/ }))
    await waitFor(() =>
      expect(
        within(region).getByText('Move USD 4.000 from Galicia → Deel'),
      ).toBeInTheDocument(),
    )

    const callsBeforeRetry = createTransferMock.mock.calls.length
    // Fire the new plan: it must start from leg 1 (Galicia 4,000), NOT skip ahead.
    await user.click(
      await within(region).findByRole('button', { name: 'Schedule these transfers' }),
    )
    await waitFor(() =>
      expect(createTransferMock.mock.calls.length).toBe(callsBeforeRetry + 2),
    )
    // The first POST of the new batch is the new leg 1 from Galicia (4,000),
    // proving the cursor reset (a stale cursor of 1 would have skipped it).
    const newBatch = createTransferMock.mock.calls.slice(callsBeforeRetry)
    expect(newBatch[0][0].fromAccountId).toBe('gal')
    expect(newBatch[0][0].amountOut).toBe('4000.00')
    expect(newBatch[1][0].fromAccountId).toBe('payo')
    expect(newBatch[1][0].amountOut).toBe('800.00')

    expect(await within(region).findByText('Transfers scheduled')).toBeInTheDocument()
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
