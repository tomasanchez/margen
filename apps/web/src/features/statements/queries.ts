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
import { transactionsClient } from '../../api/transactionsClient'
import { transactionsKeys } from '../transactions/queries'
import { homeQueryKeys } from '../home/queries'
import { useSettings } from '../settings/queries'
import { casaForSource } from '../transactions/captureFx'
import { fillSnapshots } from '../fx/fillSnapshots'

/**
 * Import the reviewed statement selection, then refresh the shared transactions
 * list + Home derived queries so the created expenses appear everywhere.
 *
 * Statement rows are parsed + created server-side WITHOUT an FX snapshot (the
 * server has no FX feed, ADR-149). After a successful import this hook runs a
 * client-side RATE-FILL step (ADR-149/150): it re-reads the transactions, finds
 * the just-created rows still lacking a snapshot, and stamps each with the rate
 * in effect on its (backdated) `occurred_on`, using the preferred source
 * (ADR-151). The fill is best-effort — a failure leaves the rows unconverted
 * (surfaced in budgets, ADR-152) for a later backfill (ADR-150), and never fails
 * the import itself. A final invalidate refreshes everything once the snapshots
 * land.
 */
export function useImportStatement() {
  const queryClient = useQueryClient()
  const settingsQuery = useSettings()
  const casa = casaForSource(settingsQuery.data?.preferredRateSource)
  return useMutation<StatementImportResult, Error, StatementImportRequest>({
    mutationFn: async (payload) => {
      const result = await statementsClient.importStatement(payload)
      // Rate-fill the just-created rows (ADR-149). Best-effort: never throw out
      // of the import on a fill failure — the rows simply stay unconverted.
      try {
        const created = new Set(result.createdTransactionIds)
        const all = await transactionsClient.list()
        const imported = all.filter((tx) => created.has(tx.id))
        if (imported.length > 0) {
          await fillSnapshots(imported, { casa })
        }
      } catch {
        // Leave the rows unconverted; the historical backfill (#80) clears them.
      }
      return result
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: transactionsKeys.all })
      void queryClient.invalidateQueries({ queryKey: homeQueryKeys.all })
    },
  })
}
