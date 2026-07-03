/**
 * Client-driven FX snapshot fill engine (ADR-148/149/150).
 *
 * The shared core behind BOTH the one-time historical backfill (ADR-150) and the
 * statement-import rate-fill (ADR-149): given a set of transactions, it stamps a
 * per-row FX snapshot (`fx_rate` + `fx_source`) using the rate that was in effect
 * on each row's `occurred_on` date, via the client-side historical FX source
 * (ADR-150). The backend materializes `usd_amount` from the supplied rate
 * (ADR-149); FX stays strictly client-side.
 *
 * Properties (ADR-150):
 *
 *  - IDEMPOTENT — rows already carrying a snapshot (`fxSource` present) are
 *    skipped; a second pass only touches rows still missing one.
 *  - RESUMABLE — each row is PUT independently; an interruption leaves the
 *    already-stamped rows done and the rest pickable on a re-run.
 *  - BATCHED — historical rate lookups are cached by `(casa, date)` inside
 *    `fxClient`, so a month of rows sharing a date hits the network once.
 *  - PROGRESS-AWARE — an `onProgress` callback fires after each row so the UI can
 *    show "N / M" and a final summary.
 *  - CALM ON FAILURE — a row whose rate can't be resolved, or whose PUT fails, is
 *    counted as `failed` and skipped (never guessed); the run continues.
 */

import {
  fetchHistoricalRate,
  type FxCasa,
} from '../../api/fxClient'
import { transactionsClient } from '../../api/transactionsClient'
import type { Transaction } from '../../mock/types'

/** Provenance tag stamped on a backfilled row (ADR-150). */
export const BACKFILL_SOURCE = 'backfill'

/** Live progress + final summary of a snapshot-fill run. */
export interface FillProgress {
  /** Rows considered (already-snapshotted rows are excluded before counting). */
  total: number
  /** Rows successfully stamped so far. */
  done: number
  /** Rows skipped because their rate couldn't be resolved / the PUT failed. */
  failed: number
}

/** Options for a {@link fillSnapshots} run. */
export interface FillSnapshotsOptions {
  /** The preferred rate source as a `casa` (ADR-151); defaults to `'bolsa'` (MEP). */
  casa: FxCasa
  /** Provenance tag written on each stamped row; defaults to {@link BACKFILL_SOURCE}. */
  fxSource?: string
  /** Fires after each row with the running progress (for the "N / M" readout). */
  onProgress?: (progress: FillProgress) => void
  /** Optional abort signal so the UI can cancel a long run. */
  signal?: AbortSignal
}

/**
 * Whether a transaction still needs an FX snapshot (ADR-148/150/152). A row is a
 * backfill candidate when it carries no `fxSource` AND it is a row that is meant
 * to hold a stored snapshot at all.
 *
 * ARS INFLOWS are excluded BY DESIGN, even though they carry no `fxSource`:
 *
 *  - ARS income converts DYNAMICALLY at the live rate and never gets a stored
 *    snapshot (ADR-156) — freezing a historical rate onto it would fabricate a
 *    USD figure the owner explicitly rejected.
 *  - A reimbursement (which serializes as `type: 'income'`, `kind:
 *    'reimbursement'`, ARS) carries NO snapshot of its own — its USD value is
 *    INHERITED from the linked expense's rate at query time (ADR-161).
 *
 * Both present as an inflow (`type === 'income'`) denominated in ARS, so a single
 * ARS-inflow guard covers both. The genuine backfill target is an EXPENSE lacking
 * a snapshot (an ARS expense with no `fxSource`, ADR-150); those still return
 * true. USD-native rows are unaffected by this guard.
 */
export function needsSnapshot(tx: Transaction): boolean {
  const hasSnapshot = tx.fxSource != null && tx.fxSource !== ''
  if (hasSnapshot) return false
  // ARS inflows (income + reimbursements) are dynamic/inherited by design — never
  // stamp a frozen snapshot on them (ADR-156/161).
  const isArsInflow = tx.type === 'income' && tx.currency === 'ARS'
  return !isArsInflow
}

/** Count how many of `transactions` still lack a snapshot (the "unconverted" count). */
export function countUnconverted(transactions: Transaction[]): number {
  let count = 0
  for (const tx of transactions) if (needsSnapshot(tx)) count++
  return count
}

/**
 * Stamp an FX snapshot on every transaction in `transactions` that still lacks
 * one (ADR-148/149/150). For each candidate it looks up the historical rate for
 * the row's `occurred_on` (falling back to the current rate when the date is
 * unavailable, ADR-150), then PUTs the snapshot; `usd_amount` is materialized
 * server-side. Resolves with the final {@link FillProgress}. Never throws — a row
 * that can't be resolved or whose PUT fails is counted as `failed` and skipped.
 */
export async function fillSnapshots(
  transactions: Transaction[],
  options: FillSnapshotsOptions,
): Promise<FillProgress> {
  const { casa, fxSource = BACKFILL_SOURCE, onProgress, signal } = options
  const candidates = transactions.filter(needsSnapshot)
  const progress: FillProgress = {
    total: candidates.length,
    done: 0,
    failed: 0,
  }
  // Report the starting state (0 / total) so the UI can show the bar immediately.
  onProgress?.({ ...progress })

  for (const tx of candidates) {
    if (signal?.aborted) break
    try {
      const rate = await fetchHistoricalRate(casa, tx.occurredOn, signal)
      if (rate == null || !Number.isFinite(rate) || rate <= 0) {
        progress.failed += 1
      } else {
        await transactionsClient.setFxSnapshot(tx.id, {
          fxRate: rateToString(rate),
          fxSource,
        })
        progress.done += 1
      }
    } catch {
      // Network / PUT failure on this row — skip it (resumable on a re-run).
      progress.failed += 1
    }
    onProgress?.({ ...progress })
  }

  return progress
}

/** Trim a rate to the snapshot scale (NUMERIC(18,6)) without trailing zeros. */
function rateToString(rate: number): string {
  return Number.parseFloat(rate.toFixed(6)).toString()
}
