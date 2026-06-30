/**
 * Per-transaction FX-snapshot capture on create (ADR-148/149/151).
 *
 * Every transaction created going forward carries an FX snapshot so its USD
 * equivalent (`usd_amount`) materializes server-side and budgets can sum it
 * directly (ADR-152) without ever re-deriving USD at a later, drifted rate.
 *
 * FX stays strictly CLIENT-SIDE (ADR-149): the client supplies `fxRate`
 * (ARS per 1 USD, Decimal string) + `fxSource` (provenance); the backend only
 * does the `amount ÷ rate` arithmetic. The rate comes from the persisted
 * preferred source (ADR-151), fetched at the day's CURRENT rate for a manual
 * add.
 *
 * Two paths:
 *
 *  - USD-account rows (ADR-029) already carry `usd` + `rate` (ARS per USD) from
 *    the suggest-confirm flow (ADR-044/045). We REUSE that rate as the snapshot
 *    `fxRate` and tag `fxSource` from the chosen `fxRateType`, so the snapshot is
 *    consistent with the entry the user confirmed — no second fetch.
 *  - ARS rows have no USD figure; we fetch the day's CURRENT preferred-source
 *    rate and stamp `fxRate` + `fxSource` so `usd_amount` still materializes.
 *
 * Never blocks the create: if the current rate can't be fetched (network /
 * unavailable), the input is returned UNCHANGED — the row is created without a
 * snapshot and is picked up later by the historical backfill (ADR-150),
 * surfaced as an "unconverted" note (ADR-152). We never guess a rate.
 */

import { fetchCurrentRate, type FxCasa } from '../../api/fxClient'
import type { PreferredRateSource } from '../../api/settingsClient'
import type { FxRateType, NewTransactionInput } from '../../mock/types'

/** Map the persisted `preferredRateSource` to the dolarapi `casa` (ADR-151). */
export function casaForSource(source: PreferredRateSource | undefined): FxCasa {
  return source === 'oficial' ? 'oficial' : 'bolsa'
}

/**
 * The `fxSource` provenance tag for a USD row, derived from the confirmed FX
 * rate family (ADR-044): a manual override is `'manual'`; an Official suggestion
 * is `'oficial'`; everything else (MEP / configured default) is `'bolsa'`. This
 * is the same vocabulary the backfill + budgets use (ADR-148/151).
 */
function sourceForFxRateType(fxRateType: FxRateType | undefined): string {
  if (fxRateType === 'manual') return 'manual'
  if (fxRateType === 'official') return 'oficial'
  return 'bolsa'
}

/** Round a positive number to a Decimal string with up to 6 dp (the snapshot scale). */
function toRateString(rate: number): string {
  // The backend stores fx_rate at NUMERIC(18,6); trim to 6 dp and drop trailing
  // zeros so the string stays tidy without losing precision.
  return Number.parseFloat(rate.toFixed(6)).toString()
}

/**
 * Augment a create input with an FX snapshot (`fxRate` + `fxSource`, ADR-148).
 *
 * - USD rows reuse their confirmed `rate` as the snapshot rate (tagged from the
 *   chosen source) — no fetch.
 * - ARS rows fetch the day's CURRENT preferred-source rate (ADR-151) and stamp
 *   it. A failed/absent fetch returns the input UNCHANGED (no snapshot; the row
 *   is backfilled later, ADR-150).
 *
 * Idempotent on inputs that already carry an `fxRate`: such an input is returned
 * unchanged so callers can pre-stamp without a double fetch.
 */
export async function captureFxForCreate(
  input: NewTransactionInput,
  source: PreferredRateSource | undefined,
  signal?: AbortSignal,
): Promise<NewTransactionInput> {
  // Already stamped (e.g. a future pre-fill path) — leave it be.
  if (input.fxRate != null) return input

  // USD-account flow (ADR-029): reuse the confirmed rate as the snapshot.
  if (input.currency === 'USD' && typeof input.rate === 'number' && input.rate > 0) {
    return {
      ...input,
      fxRate: toRateString(input.rate),
      fxSource: sourceForFxRateType(input.fxRateType),
    }
  }

  // ARS row: fetch the day's current preferred-source rate. Never throws — a
  // null degrades to "no snapshot" (created without one; backfilled later).
  const casa = casaForSource(source)
  const rate = await fetchCurrentRate(casa, signal)
  if (rate == null || !Number.isFinite(rate) || rate <= 0) return input
  return {
    ...input,
    fxRate: toRateString(rate),
    fxSource: casa,
  }
}
