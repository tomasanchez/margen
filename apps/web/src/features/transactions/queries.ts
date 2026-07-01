/**
 * TanStack Query hooks for transactions, over the real backend API
 * (ADR-033/036). The mock async transactions store was removed (ADR-035); these
 * hooks now read and mutate through {@link transactionsClient}, which adapts the
 * backend DTO to the frontend {@link Transaction} shape.
 *
 * Home and Transactions both read the single `transactions` list, so a mutation
 * here keeps both screens consistent. Mutations invalidate the transactions list
 * (and the Home derived queries) on success so the cache re-reads the backend
 * (ADR-036). Mutation hooks return TanStack Query's full result, so callers can
 * surface `isError` / `error` for the calm failure UX (ADR-037).
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  transactionsClient,
  type TransactionUpdateInput,
} from '../../api/transactionsClient'
import type { NewTransactionInput, Transaction } from '../../mock/types'
import { homeQueryKeys } from '../home/queries'
import { accountsKeys } from '../accounts/queries'
import { useSettings } from '../settings/queries'
import { usePreferredRate } from '../budgets/queries'
import { captureFxForCreate } from './captureFx'

/** Stable query-key factory for the transactions domain. */
export const transactionsKeys = {
  all: ['transactions'] as const,
  list: () => [...transactionsKeys.all, 'list'] as const,
}

/**
 * Read the shared transactions list. This is the single source the screens read;
 * derived views (grouping, filtering, totals) are computed in the consuming
 * components from this data.
 */
export function useTransactions() {
  return useQuery<Transaction[]>({
    queryKey: transactionsKeys.list(),
    queryFn: () => transactionsClient.list(),
  })
}

/**
 * Invalidate every query whose data is derived from the transactions store, so
 * the list AND the Home cards (which the real backend would recompute from the
 * same source) re-read after a mutation.
 */
function useInvalidateTransactionDerived() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: transactionsKeys.all })
    void queryClient.invalidateQueries({ queryKey: homeQueryKeys.all })
    // Net worth = opening balances + transaction deltas (ADR-122) and uses the
    // latest USD row's MEP rate (ADR-133), so a transaction mutation can change
    // both the per-account balances and the conversion. Refresh accounts too.
    void queryClient.invalidateQueries({ queryKey: accountsKeys.all })
  }
}

/**
 * Add a transaction, then refresh the shared list + Home derived queries.
 *
 * Before the create, the input is augmented with a per-transaction FX snapshot
 * (ADR-148/149): the client captures the day's CURRENT preferred-source rate
 * (ADR-151) so the backend materializes `usd_amount` and budgets can sum it
 * directly (ADR-152). USD-account rows reuse their confirmed rate; ARS rows reuse
 * the already-CACHED preferred rate (`usePreferredRate`, the same query the
 * budgets surface keeps warm) so the snapshot doesn't hinge on a fresh, possibly
 * not-yet-landed submit-time fetch — the earlier cause of ARS rows getting a
 * `fxSource` but no `fxRate`. The capture never blocks the create — an
 * unavailable rate just omits the WHOLE snapshot (source + rate travel together;
 * the row is backfilled later, ADR-150). The preferred source is read
 * non-blockingly from settings (default `'bolsa'`/MEP).
 */
export function useAddTransaction() {
  const invalidate = useInvalidateTransactionDerived()
  const settingsQuery = useSettings()
  const preferredRateSource = settingsQuery.data?.preferredRateSource
  // The app already keeps the preferred-source rate warm (budgets + display
  // currency). Reuse it for the ARS snapshot so we don't depend on a fresh fetch.
  const preferredRateQuery = usePreferredRate()
  const cachedRate = preferredRateQuery.data
  return useMutation<Transaction, Error, NewTransactionInput>({
    mutationFn: async (input) => {
      const withSnapshot = await captureFxForCreate(input, preferredRateSource, {
        cachedRate,
      })
      return transactionsClient.create(withSnapshot)
    },
    onSuccess: invalidate,
  })
}

/** Update a transaction by id, then refresh the shared list + Home queries. */
export function useUpdateTransaction() {
  const invalidate = useInvalidateTransactionDerived()
  return useMutation<
    Transaction,
    Error,
    { id: string; patch: TransactionUpdateInput }
  >({
    mutationFn: ({ id, patch }) => transactionsClient.update(id, patch),
    onSuccess: invalidate,
  })
}

/** Delete a transaction by id, then refresh the shared list + Home queries. */
export function useDeleteTransaction() {
  const invalidate = useInvalidateTransactionDerived()
  return useMutation<void, Error, string>({
    mutationFn: (id) => transactionsClient.remove(id),
    onSuccess: invalidate,
  })
}
