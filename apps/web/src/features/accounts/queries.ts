/**
 * TanStack Query hooks for institutions + accounts + net worth
 * (ADR-122/123/130/133/134, ADR-036).
 *
 * Reads/mutates through {@link accountsClient}, which adapts the backend DTOs to
 * the frontend {@link Institution} / {@link Account} shapes. ADR-134 splits the
 * model into institutions (the provider rows) and per-currency account leaves.
 * The institutions list, the accounts list, and the net-worth read are separate
 * queries; ANY write (institution or account) invalidates the whole `accounts`
 * key family — a new institution unlocks an Add-account flow, and a new opening
 * balance / account changes net worth.
 *
 * Net worth also depends on the transactions store (balances = opening +
 * transaction deltas, ADR-122) and on the latest USD row's MEP rate (ADR-133), so
 * a transaction mutation refreshes net worth too (wired from the transactions
 * invalidation, which invalidates `accountsKeys.all`). Mutation hooks return
 * TanStack Query's full result so callers can surface `isError` / `error` for the
 * calm failure UX (ADR-037).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  accountsClient,
  type AccountUpdateInput,
  type InstitutionUpdateInput,
  type NewAccountInput,
  type NewInstitutionInput,
  type NetWorth,
} from '../../api/accountsClient'
import type { Account, Institution } from '../../mock/types'

/** Stable query-key factory for the accounts domain. */
export const accountsKeys = {
  all: ['accounts'] as const,
  institutions: () => [...accountsKeys.all, 'institutions'] as const,
  list: () => [...accountsKeys.all, 'list'] as const,
  netWorth: () => [...accountsKeys.all, 'net-worth'] as const,
}

/** Read the owner-scoped institutions list (the provider rows, ADR-134). */
export function useInstitutions() {
  return useQuery<Institution[]>({
    queryKey: accountsKeys.institutions(),
    queryFn: () => accountsClient.listInstitutions(),
  })
}

/** Read the owner-scoped accounts list (the per-currency leaves + the selector). */
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

/** Invalidate every accounts query (institutions + list + net worth) after a write. */
function useInvalidateAccounts() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: accountsKeys.all })
  }
}

/** Create an institution, then refresh the whole accounts family. */
export function useCreateInstitution() {
  const invalidate = useInvalidateAccounts()
  return useMutation<Institution, Error, NewInstitutionInput>({
    mutationFn: (input) => accountsClient.createInstitution(input),
    onSuccess: invalidate,
  })
}

/** Update an institution by id, then refresh the whole accounts family. */
export function useUpdateInstitution() {
  const invalidate = useInvalidateAccounts()
  return useMutation<
    Institution,
    Error,
    { id: string; input: InstitutionUpdateInput }
  >({
    mutationFn: ({ id, input }) => accountsClient.updateInstitution(id, input),
    onSuccess: invalidate,
  })
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
