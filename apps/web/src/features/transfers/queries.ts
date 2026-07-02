/**
 * TanStack Query hooks for account-to-account Transfers (ADR-135, ADR-036).
 *
 * Reads/mutates through {@link transfersClient}, which adapts the backend DTO to
 * the frontend {@link Transfer} shape. Creating a transfer moves balances between
 * accounts (so net worth + per-account balances change) AND — when fees are
 * attached — creates `kind=expense`, category `"Fees"` transactions. So a create
 * invalidates the transfers list, the whole `accounts` key family (net worth +
 * balances, ADR-122/123), the transactions list, and the Home derived queries
 * (fees show up in expense totals / the category breakdown). A delete only
 * touches balances/net worth + the transfers list — it does NOT remove the fee
 * expenses (ADR-135), but invalidating transactions is harmless and keeps any
 * derived counts honest.
 *
 * Mutation hooks return TanStack Query's full result so callers can surface
 * `isError` / `error` for the calm failure UX (ADR-037).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  transfersClient,
  type CreatedTransfer,
} from '../../api/transfersClient'
import type {
  Currency,
  NewTransferInput,
  Transfer,
  TransferFeeInput,
} from '../../mock/types'
import { accountsKeys, useAccounts } from '../accounts/queries'
import { transactionsKeys } from '../transactions/queries'
import { homeQueryKeys } from '../home/queries'
import { useSettings } from '../settings/queries'
import { usePreferredRate } from '../budgets/queries'
import { captureFxForFee } from '../transactions/captureFx'

/** Stable query-key factory for the transfers domain. */
export const transfersKeys = {
  all: ['transfers'] as const,
  list: () => [...transfersKeys.all, 'list'] as const,
}

/** Read the owner-scoped transfers list (newest-first, ADR-135). */
export function useTransfers() {
  return useQuery<Transfer[]>({
    queryKey: transfersKeys.list(),
    queryFn: () => transfersClient.list(),
  })
}

/**
 * Invalidate everything a transfer mutation can change: the transfers list, the
 * accounts family (net worth + balances), the transactions list, and the Home
 * derived queries (fees are expense rows). See the module note for why.
 */
function useInvalidateTransferDerived() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: transfersKeys.all })
    void queryClient.invalidateQueries({ queryKey: accountsKeys.all })
    void queryClient.invalidateQueries({ queryKey: transactionsKeys.all })
    void queryClient.invalidateQueries({ queryKey: homeQueryKeys.all })
  }
}

/**
 * Create a transfer (+ optional fee lines), then refresh balances + expenses.
 *
 * A fee is a `kind=expense` on its account (ADR-135), so — like the Add/Edit
 * transaction flow — each fee is stamped with an FX snapshot (`rate` +
 * `fxSource`) BEFORE the POST (ADR-148/149): the client captures the day's
 * preferred-source rate (ADR-151) so the backend materializes the fee expense's
 * `usd_amount = amount ÷ rate`. Without this an ARS fee landed with no USD value
 * (the bug). Capture reuses {@link captureFxForFee}/`captureFxForCreate` so the
 * rate decision never drifts (USD fees stay native; an unavailable rate degrades
 * to no snapshot rather than a guess — the row is backfilled later, ADR-150). The
 * fee ACCOUNT's currency comes from the loaded accounts; the preferred source +
 * the already-warm preferred rate come from settings/`usePreferredRate` (the same
 * cached rate the Add flow reuses).
 */
export function useCreateTransfer() {
  const invalidate = useInvalidateTransferDerived()
  const accountsQuery = useAccounts()
  const settingsQuery = useSettings()
  const preferredRateSource = settingsQuery.data?.preferredRateSource
  const preferredRateQuery = usePreferredRate()
  const cachedRate = preferredRateQuery.data
  return useMutation<CreatedTransfer, Error, NewTransferInput>({
    mutationFn: async (input) => {
      if (!input.fees || input.fees.length === 0) {
        return transfersClient.create(input)
      }
      // Resolve each fee ACCOUNT's currency so an ARS fee captures a rate while a
      // USD fee stays native. Default to ARS when the account isn't found (the
      // common fee case) — capture then degrades safely if no rate is available.
      const currencyByAccount = new Map<string, Currency>()
      for (const account of accountsQuery.data ?? []) {
        currencyByAccount.set(account.id, account.currency)
      }
      const fees: TransferFeeInput[] = await Promise.all(
        input.fees.map((fee) =>
          captureFxForFee(
            fee,
            currencyByAccount.get(fee.accountId) ?? 'ARS',
            preferredRateSource,
            { cachedRate },
          ),
        ),
      )
      return transfersClient.create({ ...input, fees })
    },
    onSuccess: invalidate,
  })
}

/** Delete a transfer by id, then refresh the list + balances/net worth. */
export function useDeleteTransfer() {
  const invalidate = useInvalidateTransferDerived()
  return useMutation<void, Error, string>({
    mutationFn: (id) => transfersClient.remove(id),
    onSuccess: invalidate,
  })
}
