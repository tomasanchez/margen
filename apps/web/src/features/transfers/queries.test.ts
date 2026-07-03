/**
 * Unit tests for {@link useCreateTransfer}'s per-fee FX-snapshot capture
 * (ADR-135, ADR-148/149/150/151).
 *
 * A transfer fee is a `kind=expense` on its account, so — like the Add flow — the
 * create mutation captures the day's preferred-source rate BEFORE the POST so the
 * backend materializes the fee's `usd_amount`. The rate decision hinges on the fee
 * ACCOUNT's currency, and this suite pins the AUTHORITATIVE-currency contract:
 *
 *  - a warm-cache ARS fee still captures (rate + fxSource forwarded);
 *  - a USD fee stays native (no snapshot);
 *  - a fee whose account currency is UNKNOWN — because the accounts query has NOT
 *    resolved, or because the account is absent from the resolved set — is sent
 *    SNAPSHOT-LESS (no rate/fxSource), NOT defaulted to ARS. A wrong-currency
 *    snapshot (an ARS-per-USD rate on a real USD fee → a bogus ~$0 usd_amount the
 *    ADR-150 backfill can't fix) is worse than none; a snapshot-less fee is
 *    null-USD and eligible for the backfill later.
 *
 * The network boundaries (`transfersClient`, `accountsClient`, `settingsClient`,
 * `fxClient`) are mocked so the real hooks run end to end without a network.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { useCreateTransfer } from './queries'
import { transfersClient } from '../../api/transfersClient'
import { accountsClient } from '../../api/accountsClient'
import { fetchSettings } from '../../api/settingsClient'
import { fetchCurrentRate } from '../../api/fxClient'
import type { Account, NewTransferInput } from '../../mock/types'
import type { Settings } from '../../api/settingsClient'

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
  return { ...actual, accountsClient: { ...actual.accountsClient, list: vi.fn() } }
})

vi.mock('../../api/settingsClient', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/settingsClient')>()
  return { ...actual, fetchSettings: vi.fn() }
})

vi.mock('../../api/fxClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/fxClient')>()
  return { ...actual, fetchCurrentRate: vi.fn() }
})

const mockCreate = vi.mocked(transfersClient.create)
const mockAccountsList = vi.mocked(accountsClient.list)
const mockFetchSettings = vi.mocked(fetchSettings)
const mockFetchRate = vi.mocked(fetchCurrentRate)

const SETTINGS: Settings = {
  preferredDisplayCurrency: 'ARS',
  fxDefaultRateType: 'MEP',
  preferredRateSource: 'bolsa',
  monotributoCurrentCategory: 'A',
  monotributoActivityType: 'services',
  monotributoEnabled: false,
}

const ARS_ACCOUNT: Account = {
  id: 'acc-ars',
  institutionId: 'inst-1',
  institutionName: 'Galicia',
  type: 'bank',
  currency: 'ARS',
  openingBalance: '150000.00',
}

const USD_ACCOUNT: Account = {
  id: 'acc-usd',
  institutionId: 'inst-3',
  institutionName: 'Deel',
  type: 'wallet',
  currency: 'USD',
  openingBalance: '1200.00',
}

/** A transfer input carrying a single fee on the given account. */
function transferWithFee(accountId: string): NewTransferInput {
  return {
    fromAccountId: 'acc-ars',
    toAccountId: 'acc-ars-2',
    amountOut: '1000.00',
    amountIn: '1000.00',
    occurredOn: '2026-06-20',
    fees: [{ accountId, amount: '15.00', label: 'Wire fee' }],
  }
}

/** A fresh QueryClient + provider wrapper (retries off for deterministic states). */
function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  return { queryClient, wrapper }
}

beforeEach(() => {
  mockCreate.mockResolvedValue({
    transfer: {
      id: 'tr-1',
      fromAccountId: 'acc-ars',
      toAccountId: 'acc-ars-2',
      amountOut: '1000.00',
      amountIn: '1000.00',
      occurredOn: '2026-06-20',
    },
    feeTransactionIds: [],
  })
  mockFetchSettings.mockResolvedValue(SETTINGS)
  mockFetchRate.mockResolvedValue(1250)
})
afterEach(() => vi.clearAllMocks())

describe('useCreateTransfer — authoritative per-fee FX capture (ADR-148/150)', () => {
  test('a warm-cache ARS fee still captures a rate + source', async () => {
    mockAccountsList.mockResolvedValue([ARS_ACCOUNT])
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useCreateTransfer(), { wrapper })

    // Let the accounts + settings + rate queries resolve before mutating so the
    // accounts cache is warm (isSuccess) and the currency is known.
    await waitFor(() => expect(mockFetchRate).toHaveBeenCalled())

    await result.current.mutateAsync(transferWithFee('acc-ars'))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))

    const body = mockCreate.mock.calls[0][0]
    expect(body.fees).toEqual([
      {
        accountId: 'acc-ars',
        amount: '15.00',
        label: 'Wire fee',
        rate: '1250',
        fxSource: 'bolsa',
      },
    ])
  })

  test('a USD fee stays native (no snapshot, no rate captured)', async () => {
    mockAccountsList.mockResolvedValue([ARS_ACCOUNT, USD_ACCOUNT])
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useCreateTransfer(), { wrapper })
    await waitFor(() => expect(mockAccountsList).toHaveBeenCalled())

    await result.current.mutateAsync(transferWithFee('acc-usd'))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))

    const body = mockCreate.mock.calls[0][0]
    // No rate/fxSource — a USD fee is already in dollars.
    expect(body.fees).toEqual([
      { accountId: 'acc-usd', amount: '15.00', label: 'Wire fee' },
    ])
  })

  test('a fee whose account is ABSENT from the resolved set is sent snapshot-less (no ARS guess)', async () => {
    // Accounts resolved, but the fee references an account NOT in the set. We must
    // NOT default it to ARS (which would stamp an ARS-per-USD rate on a possible
    // USD fee → a bogus usd_amount). Send it snapshot-less for the ADR-150 backfill.
    mockAccountsList.mockResolvedValue([ARS_ACCOUNT])
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useCreateTransfer(), { wrapper })
    await waitFor(() => expect(mockAccountsList).toHaveBeenCalled())

    await result.current.mutateAsync(transferWithFee('acc-unknown'))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))

    const body = mockCreate.mock.calls[0][0]
    expect(body.fees).toEqual([
      { accountId: 'acc-unknown', amount: '15.00', label: 'Wire fee' },
    ])
    expect(body.fees?.[0]).not.toHaveProperty('rate')
    expect(body.fees?.[0]).not.toHaveProperty('fxSource')
  })

  test('an ARS fee is sent snapshot-less when the accounts query has NOT resolved', async () => {
    // The accounts list never resolves (errors), so the query is not `isSuccess`.
    // Even an ARS fee must NOT capture here — the currency cannot be trusted, so we
    // send it snapshot-less rather than guess. The transfer itself still POSTs.
    mockAccountsList.mockRejectedValue(new Error('accounts unavailable'))
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useCreateTransfer(), { wrapper })
    await waitFor(() => expect(mockAccountsList).toHaveBeenCalled())

    await result.current.mutateAsync(transferWithFee('acc-ars'))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))

    const body = mockCreate.mock.calls[0][0]
    expect(body.fees).toEqual([
      { accountId: 'acc-ars', amount: '15.00', label: 'Wire fee' },
    ])
    expect(body.fees?.[0]).not.toHaveProperty('rate')
    expect(body.fees?.[0]).not.toHaveProperty('fxSource')
  })
})
