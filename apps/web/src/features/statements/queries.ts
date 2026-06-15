/**
 * TanStack Query hooks for the statement import flow (ADR-078, ADR-080).
 *
 * Importing a statement creates N transactions on the backend, so on success we
 * invalidate the same derived queries the transaction mutations do
 * (transactions list + Home cards) — the newly imported expenses then appear on
 * Home and the Transactions screen without a manual reload (ADR-036). The hook
 * returns TanStack Query's full mutation result so the flow can surface
 * `isPending` / `isError` for the calm confirm/failure UX (ADR-037/080).
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  statementsClient,
  type StatementImportRequest,
  type StatementImportResult,
} from '../../api/statementsClient'
import { transactionsKeys } from '../transactions/queries'
import { homeQueryKeys } from '../home/queries'

/**
 * Import the reviewed statement selection, then refresh the shared transactions
 * list + Home derived queries so the created expenses appear everywhere.
 */
export function useImportStatement() {
  const queryClient = useQueryClient()
  return useMutation<StatementImportResult, Error, StatementImportRequest>({
    mutationFn: (payload) => statementsClient.importStatement(payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: transactionsKeys.all })
      void queryClient.invalidateQueries({ queryKey: homeQueryKeys.all })
    },
  })
}
