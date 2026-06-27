/**
 * TanStack Query hooks for accounts + net worth (ADR-122/123/130/133, ADR-036).
 *
 * Reads/mutates through {@link accountsClient}, which adapts the backend DTO to
 * the frontend {@link Account} shape. The accounts list and the net-worth read
 * are separate queries; a create/update invalidates BOTH (a new opening balance
 * changes net worth) plus the transactions-derived queries are unaffected here.
 *
 * Net worth also depends on the transactions store (balances = opening +
 * transaction deltas, ADR-122) and on the latest USD row's MEP rate (ADR-133), so
 * a transaction mutation should refresh net worth too. That is wired from the
 * transactions invalidation (it invalidates `accounts` net-worth there); here we
 * own the account-write path. Mutation hooks return TanStack Query's full result
 * so callers can surface `isError` / `error` for the calm failure UX (ADR-037).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  accountsClient,
  type AccountUpdateInput,
  type NewAccountInput,
  type NetWorth,
} from '../../api/accountsClient'
import type { Account } from '../../mock/types'

/** Stable query-key factory for the accounts domain. */
export const accountsKeys = {
  all: ['accounts'] as const,
  list: () => [...accountsKeys.all, 'list'] as const,
  netWorth: () => [...accountsKeys.all, 'net-worth'] as const,
}

/** Read the owner-scoped accounts list (the source the page + selector read). */
export function useAccounts() {
  return useQuery<Account[]>({
    queryKey: accountsKeys.list(),
    queryFn: () => accountsClient.list(),
  })
}

/** Read the net-worth read model (total + per-account breakdown, ADR-123/133). */
export function useNetWorth() {
  return useQuery<NetWorth>({
    queryKey: accountsKeys.netWorth(),
    queryFn: () => accountsClient.netWorth(),
  })
}

/** Invalidate every accounts query (list + net worth) after an account write. */
function useInvalidateAccounts() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: accountsKeys.all })
  }
}

/** Create an account, then refresh the list + net worth. */
export function useCreateAccount() {
  const invalidate = useInvalidateAccounts()
  return useMutation<Account, Error, NewAccountInput>({
    mutationFn: (input) => accountsClient.create(input),
    onSuccess: invalidate,
  })
}

/** Update an account by id, then refresh the list + net worth. */
export function useUpdateAccount() {
  const invalidate = useInvalidateAccounts()
  return useMutation<Account, Error, { id: string; input: AccountUpdateInput }>({
    mutationFn: ({ id, input }) => accountsClient.update(id, input),
    onSuccess: invalidate,
  })
}
