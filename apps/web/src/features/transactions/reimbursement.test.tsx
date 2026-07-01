/**
 * Reimbursement (payback) feature checks (ADR-158…162).
 *
 * A reimbursement is a payback a friend sends the owner for a shared expense the
 * owner fronted. It is recorded as `kind='reimbursement'`, `type='income'`,
 * linked to the source EXPENSE via `offsetsTransactionId`, and carries NO FX of
 * its own (its USD value inherits the linked expense's rate — ADR-161). These
 * tests cover:
 *
 *   1. The create payload the Add flow assembles when opened from an expense's
 *      "Add reimbursement" action — kind + offsetsTransactionId, no FX fields.
 *   2. A reimbursement row reading as a payback (the "reimbursement" chip), not a
 *      plain income row.
 *
 * English-pinned (ADR-105). The HTTP client + FX adapters are mocked so nothing
 * touches a real backend / network (ADR-038/044).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider } from '@mui/material/styles'
import { renderWithProviders } from '../../test/renderWithProviders'
import { darkTheme } from '../../theme'
import { useAddTransaction } from './addContext'
import { buildReimbursementPrefill } from './filtering'
import { TransactionRow } from './TransactionRow'
import type { Transaction } from '../../mock/types'

const { createMock, fxMock, currentRateMock, fetchSettingsMock, monotributoMock } =
  vi.hoisted(() => ({
    createMock: vi.fn(),
    fxMock: vi.fn(),
    currentRateMock: vi.fn(),
    fetchSettingsMock: vi.fn(),
    monotributoMock: vi.fn(),
  }))

vi.mock('../../api/transactionsClient', async () => {
  const actual = await vi.importActual<
    typeof import('../../api/transactionsClient')
  >('../../api/transactionsClient')
  return {
    ...actual,
    transactionsClient: {
      list: vi.fn(() => Promise.resolve([])),
      create: createMock,
      update: vi.fn(),
      remove: vi.fn(),
    },
  }
})

vi.mock('../../api/fxClient', () => ({
  fetchSuggestedRates: fxMock,
  fetchCurrentRate: currentRateMock,
}))

vi.mock('../../api/monotributoClient', () => ({
  fetchMonotributo: monotributoMock,
}))

vi.mock('../../api/settingsClient', async () => {
  const actual = await vi.importActual<
    typeof import('../../api/settingsClient')
  >('../../api/settingsClient')
  return { ...actual, fetchSettings: fetchSettingsMock }
})

vi.mock('@tanstack/react-router', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-router')>(
      '@tanstack/react-router',
    )
  return { ...actual, useNavigate: () => vi.fn() }
})

/** The expense a payback offsets. */
const EXPENSE: Transaction = {
  id: 'exp-dinner-1',
  occurredOn: '2026-06-12',
  dispDate: 'Jun 12',
  month: 'June',
  name: 'Sushiclub dinner',
  category: 'Social',
  bank: 'Transfer',
  currency: 'ARS',
  type: 'expense',
  kind: 'expense',
  amountNum: 40000,
}

beforeEach(() => {
  // A deliberately-large live rate so a regression that stamps FX on a
  // reimbursement is unmistakable (the payload must carry NO rate at all).
  fxMock.mockResolvedValue({ mep: 9999, official: 9999 })
  currentRateMock.mockResolvedValue(9999)
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
      annualLimit: 1,
      used: 0,
      remaining: 1,
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
})

afterEach(() => {
  vi.clearAllMocks()
})

/** A trigger that opens the Add flow with the reimbursement prefill for EXPENSE. */
function OpenReimburseTrigger() {
  const { openAdd } = useAddTransaction()
  return (
    <button type="button" onClick={() => openAdd(buildReimbursementPrefill(EXPENSE))}>
      reimburse
    </button>
  )
}

async function openReimburseDialog() {
  const user = userEvent.setup()
  renderWithProviders(<OpenReimburseTrigger />, { withAddProvider: true })
  await user.click(screen.getByRole('button', { name: 'reimburse' }))
  const dialog = await screen.findByRole('dialog')
  return { user, dialog }
}

describe('Reimbursement create payload (ADR-158/159/161)', () => {
  test('sends kind=reimbursement + offsetsTransactionId and NO FX fields', async () => {
    createMock.mockResolvedValueOnce({})
    const { user, dialog } = await openReimburseDialog()
    const form = within(dialog)

    // The flow opens as a payback, not a plain add.
    expect(
      form.getByRole('heading', { name: 'Record a payback' }),
    ).toBeInTheDocument()
    // It names the expense being paid back, so the link is obvious.
    expect(form.getByText('Sushiclub dinner')).toBeInTheDocument()

    // Enter only the ARS amount the friend paid back, then save.
    await user.type(form.getByLabelText(/^Amount in /), '15000')
    await user.click(form.getByRole('button', { name: /^Save$/ }))

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    const [input] = createMock.mock.calls[0]
    expect(input.kind).toBe('reimbursement')
    expect(input.type).toBe('income')
    expect(input.currency).toBe('ARS')
    expect(input.offsetsTransactionId).toBe('exp-dinner-1')
    expect(input.amountNum).toBe(15000)
    // No FX snapshot travels with a reimbursement — its USD value inherits the
    // linked expense's rate server-side (ADR-161).
    expect(input.fxRate).toBeUndefined()
    expect(input.fxSource).toBeUndefined()
    expect(input.usd).toBeUndefined()
    expect(input.rate).toBeUndefined()
  })

  test('the payback flow hides the currency toggle and the FX rate field', async () => {
    const { dialog } = await openReimburseDialog()
    const form = within(dialog)

    // ARS-only (ADR-160): no currency toggle, no per-transaction USD rate field.
    expect(form.queryByRole('button', { name: 'USD' })).not.toBeInTheDocument()
    expect(
      form.queryByLabelText('USD rate for this transaction (ARS per USD)'),
    ).not.toBeInTheDocument()
    // Not a plain income row: no Monotributo toggle either (ADR-158/162).
    expect(
      form.queryByText('Counts toward Monotributo'),
    ).not.toBeInTheDocument()
  })
})

describe('Reimbursement row label (list)', () => {
  test('a reimbursement row reads as a payback (reimbursement chip), not plain income', () => {
    const reimbursement: Transaction = {
      id: 'reimb-1',
      occurredOn: '2026-06-20',
      dispDate: 'Jun 20',
      month: 'June',
      name: 'Reimbursement',
      category: 'Income',
      bank: 'Transfer',
      currency: 'ARS',
      type: 'income',
      kind: 'reimbursement',
      offsetsTransactionId: 'exp-dinner-1',
      amountNum: 15000,
    }
    render(
      <ThemeProvider theme={darkTheme}>
        <TransactionRow
          transaction={reimbursement}
          onEdit={() => {}}
          onDelete={() => {}}
        />
      </ThemeProvider>,
    )
    expect(screen.getByText('reimbursement')).toBeInTheDocument()
  })

  test('an EXPENSE row exposes the "Add reimbursement" action; income does not', () => {
    const onReimburse = vi.fn()
    const { rerender } = render(
      <ThemeProvider theme={darkTheme}>
        <TransactionRow
          transaction={EXPENSE}
          onEdit={() => {}}
          onDelete={() => {}}
          onReimburse={onReimburse}
        />
      </ThemeProvider>,
    )
    // The expense row offers linking a payback to it (ADR-158/159).
    expect(
      screen.getByLabelText('Add a reimbursement for Sushiclub dinner'),
    ).toBeInTheDocument()

    // An income row (even with a handler) offers no such action — you only pay
    // back an expense.
    const income: Transaction = {
      ...EXPENSE,
      id: 'inc-x',
      name: 'Salary',
      category: 'Income',
      type: 'income',
      kind: 'income',
    }
    rerender(
      <ThemeProvider theme={darkTheme}>
        <TransactionRow
          transaction={income}
          onEdit={() => {}}
          onDelete={() => {}}
          onReimburse={onReimburse}
        />
      </ThemeProvider>,
    )
    expect(
      screen.queryByLabelText(/Add a reimbursement for/),
    ).not.toBeInTheDocument()
  })

  test('a plain income row shows no reimbursement chip', () => {
    const income: Transaction = {
      id: 'inc-1',
      occurredOn: '2026-06-20',
      dispDate: 'Jun 20',
      month: 'June',
      name: 'Salary',
      category: 'Income',
      bank: 'Transfer',
      currency: 'ARS',
      type: 'income',
      kind: 'income',
      amountNum: 500000,
    }
    render(
      <ThemeProvider theme={darkTheme}>
        <TransactionRow transaction={income} onEdit={() => {}} onDelete={() => {}} />
      </ThemeProvider>,
    )
    expect(screen.queryByText('reimbursement')).not.toBeInTheDocument()
  })
})
