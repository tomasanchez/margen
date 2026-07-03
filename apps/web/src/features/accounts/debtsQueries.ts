/**
 * TanStack Query hooks for the manual Debts aggregate (ADR-187, ADR-036).
 *
 * Reads/mutates through {@link debtsClient}, which adapts the backend DTO to the
 * frontend {@link Debt} shape. A debt's `currentBalance` feeds the net-worth
 * `liabilities.other` leg (ADR-187), so ANY write invalidates BOTH the debts list
 * AND the whole `accounts` key family (the net-worth read owns that key, ADR-122)
 * — otherwise the "other debts" leg on the net-worth card would go stale.
 *
 * Mutation hooks return TanStack Query's full result so callers can surface
 * `isError` / `error` for the calm failure UX (ADR-037).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { debtsClient, type Debt, type DebtFormInput } from '../../api/debtsClient'
import { accountsKeys } from './queries'

/** Stable query-key factory for the debts domain. */
export const debtsKeys = {
  all: ['debts'] as const,
  list: () => [...debtsKeys.all, 'list'] as const,
}

/** Read the owner-scoped debts list (newest-first, ADR-187). */
export function useDebts() {
  return useQuery<Debt[]>({
    queryKey: debtsKeys.list(),
    queryFn: () => debtsClient.list(),
  })
}

/**
 * Invalidate the debts list AND the accounts family after a write. The net-worth
 * `liabilities.other` leg is derived from debts (ADR-187), so a debt change must
 * refresh net worth too — not just the debts list.
 */
function useInvalidateDebts() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: debtsKeys.all })
    void queryClient.invalidateQueries({ queryKey: accountsKeys.all })
  }
}

/** Create a debt, then refresh the debts list + net worth. */
export function useCreateDebt() {
  const invalidate = useInvalidateDebts()
  return useMutation<Debt, Error, DebtFormInput>({
    mutationFn: (input) => debtsClient.create(input),
    onSuccess: invalidate,
  })
}

/** Update a debt by id, then refresh the debts list + net worth. */
export function useUpdateDebt() {
  const invalidate = useInvalidateDebts()
  return useMutation<Debt, Error, { id: string; input: DebtFormInput }>({
    mutationFn: ({ id, input }) => debtsClient.update(id, input),
    onSuccess: invalidate,
  })
}

/** Delete a debt by id, then refresh the debts list + net worth. */
export function useDeleteDebt() {
  const invalidate = useInvalidateDebts()
  return useMutation<void, Error, string>({
    mutationFn: (id) => debtsClient.remove(id),
    onSuccess: invalidate,
  })
}
