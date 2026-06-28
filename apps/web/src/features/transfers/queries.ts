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
import type { NewTransferInput, Transfer } from '../../mock/types'
import { accountsKeys } from '../accounts/queries'
import { transactionsKeys } from '../transactions/queries'
import { homeQueryKeys } from '../home/queries'

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

/** Create a transfer (+ optional fee lines), then refresh balances + expenses. */
export function useCreateTransfer() {
  const invalidate = useInvalidateTransferDerived()
  return useMutation<CreatedTransfer, Error, NewTransferInput>({
    mutationFn: (input) => transfersClient.create(input),
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
