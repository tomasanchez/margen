/**
 * TanStack Query hooks for transactions, over the in-memory mock API (ADR-015).
 *
 * The mock API holds the single shared transactions store; Home and
 * Transactions both read through these hooks, so a mutation here updates the
 * data both screens see. Mutations invalidate the transactions list (and the
 * Home derived queries) so the cache re-reads the mutated store.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  addTransaction,
  deleteTransaction,
  listTransactions,
  updateTransaction,
} from '../../mock/api'
import type {
  NewTransactionInput,
  Transaction,
  TransactionPatch,
} from '../../mock/types'
import { homeQueryKeys } from '../home/queries'

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
    queryFn: () => listTransactions(),
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
  }
}

/** Add a transaction, then refresh the shared list + Home derived queries. */
export function useAddTransaction() {
  const invalidate = useInvalidateTransactionDerived()
  return useMutation<Transaction, Error, NewTransactionInput>({
    mutationFn: (input) => addTransaction(input),
    onSuccess: invalidate,
  })
}

/** Update a transaction by id, then refresh the shared list + Home queries. */
export function useUpdateTransaction() {
  const invalidate = useInvalidateTransactionDerived()
  return useMutation<
    Transaction,
    Error,
    { id: number; patch: TransactionPatch }
  >({
    mutationFn: ({ id, patch }) => updateTransaction(id, patch),
    onSuccess: invalidate,
  })
}

/** Delete a transaction by id, then refresh the shared list + Home queries. */
export function useDeleteTransaction() {
  const invalidate = useInvalidateTransactionDerived()
  return useMutation<number, Error, number>({
    mutationFn: (id) => deleteTransaction(id),
    onSuccess: invalidate,
  })
}
