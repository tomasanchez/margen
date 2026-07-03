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
import type {
  Currency,
  FxRateType,
  NewTransactionInput,
  TransferFeeInput,
} from '../../mock/types'

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
 * Options for {@link captureFxForCreate}.
 */
export interface CaptureFxOptions {
  /**
   * A preferred-source rate already CACHED by the app (ADR-151), e.g. the
   * `usePreferredRate` query the budgets surface + display-currency provider keep
   * warm. When present and positive it is used for an ARS row's snapshot INSTEAD
   * of a fresh submit-time fetch — which can be empty / not-yet-landed and was
   * why some ARS rows ended up tagged with a source but no rate. A fresh fetch is
   * still the fallback when no cached rate is supplied.
   */
  readonly cachedRate?: number | null
  readonly signal?: AbortSignal
}

/**
 * Augment a create input with an FX snapshot (`fxRate` + `fxSource`, ADR-148).
 *
 * - USD rows reuse their confirmed `rate` as the snapshot rate (tagged from the
 *   chosen source) — no fetch.
 * - ARS rows use the app's already-CACHED preferred-source rate when available
 *   (`options.cachedRate`, ADR-151), else fetch the day's CURRENT rate. Either
 *   way `fxRate` + `fxSource` are stamped TOGETHER, so a row is NEVER tagged with
 *   a source and no rate. A failed/absent rate returns the input UNCHANGED (no
 *   snapshot; the row is backfilled later, ADR-150).
 *
 * Idempotent on inputs that already carry an `fxRate`: such an input is returned
 * unchanged so callers can pre-stamp without a double fetch.
 */
export async function captureFxForCreate(
  input: NewTransactionInput,
  source: PreferredRateSource | undefined,
  options: CaptureFxOptions = {},
): Promise<NewTransactionInput> {
  // Already stamped (e.g. a future pre-fill path) — leave it be.
  if (input.fxRate != null) return input

  // A REIMBURSEMENT never carries an FX snapshot of its own (ADR-161): its USD
  // value is derived server-side from the LINKED EXPENSE's rate. Stamping one
  // here would be dropped by the backend anyway and could confuse the boundary —
  // return the input UNCHANGED so no rate/source travels with the payback.
  if (input.kind === 'reimbursement') return input

  // ARS INCOME is never snapshotted (ADR-156): the user doesn't convert those
  // pesos to USD at receipt, so a frozen per-date `usd_amount` would be
  // misleading. Its USD-equivalent, if ever shown, is computed DYNAMICALLY at the
  // live rate — never stored. Return the input UNCHANGED so `usd_amount` stays
  // null. NOTE: this is DIFFERENT from an ARS EXPENSE, which KEEPS its per-date
  // snapshot for accurate historical USD spend (handled by the ARS branch below).
  if (input.kind === 'income' && input.currency === 'ARS') return input

  // USD-account flow (ADR-029): reuse the confirmed rate as the snapshot.
  if (input.currency === 'USD' && typeof input.rate === 'number' && input.rate > 0) {
    return {
      ...input,
      fxRate: toRateString(input.rate),
      fxSource: sourceForFxRateType(input.fxRateType),
    }
  }

  // ARS row: prefer the app's already-cached preferred-source rate (never a
  // fresh network round-trip that might not have landed); fall back to a fetch
  // only when no cached rate is on hand. Never throws — a null degrades to "no
  // snapshot" (created without one; backfilled later). fxRate + fxSource are
  // always set together so the row can't be a source-without-rate.
  const casa = casaForSource(source)
  const cached = options.cachedRate
  const rate =
    typeof cached === 'number' && Number.isFinite(cached) && cached > 0
      ? cached
      : await fetchCurrentRate(casa, options.signal)
  if (rate == null || !Number.isFinite(rate) || rate <= 0) return input
  return {
    ...input,
    fxRate: toRateString(rate),
    fxSource: casa,
  }
}

/**
 * Augment a transfer FEE with an FX snapshot (`rate` + `fxSource`, ADR-148),
 * mirroring how a NORMAL expense is snapshotted on create (bug fix): a fee is a
 * `kind=expense` on its account (ADR-135), so it must carry the day's
 * preferred-source rate exactly like the Add/Edit flow — otherwise an ARS fee
 * lands with no `usd_amount` (an ARS figure but a blank USD value).
 *
 * Reuses {@link captureFxForCreate} by shaping the fee as a minimal ARS/USD
 * EXPENSE input so the SAME rate decision applies (respect the preferred source;
 * a USD fee stays native; an unavailable rate degrades to no snapshot rather than
 * a guess, ADR-149/150). Only `rate` + `fxSource` are lifted back onto the fee —
 * they always travel together, so a fee can never be tagged source-without-rate.
 *
 * @param fee     The fee line to snapshot (its native `amount`/`accountId`/`label`).
 * @param currency The fee ACCOUNT's currency (ARS captures a rate; USD stays native).
 * @param source  The persisted preferred rate source (ADR-151); default `'bolsa'`/MEP.
 * @param options Same {@link CaptureFxOptions} as the create path (cached rate, signal).
 */
export async function captureFxForFee(
  fee: TransferFeeInput,
  currency: Currency,
  source: PreferredRateSource | undefined,
  options: CaptureFxOptions = {},
): Promise<TransferFeeInput> {
  // Already snapshotted (idempotent) — leave it be.
  if (fee.rate != null) return fee

  // A USD fee is ALREADY in dollars: its `usd_amount` is the amount itself, so
  // there is no ARS→USD rate to capture. (The create-path capture reuses a
  // CONFIRMED `input.rate` for USD rows; a fee carries none, so we skip here
  // rather than let it fall through and wrongly stamp an ARS rate.) It stays
  // native — the ARS-fee bug this fixes never applied to USD fees.
  if (currency === 'USD') return fee

  // Shape the ARS fee as a minimal EXPENSE and reuse the create-path capture so
  // the rate decision (preferred source, no-guess) never drifts from the Add flow.
  const asExpense: NewTransactionInput = {
    occurredOn: '',
    dispDate: '',
    name: fee.label,
    category: 'Fees',
    currency,
    type: 'expense',
    kind: 'expense',
    amountNum: 0,
  }
  const captured = await captureFxForCreate(asExpense, source, options)
  if (captured.fxRate == null) return fee
  return {
    ...fee,
    rate: captured.fxRate,
    ...(captured.fxSource != null ? { fxSource: captured.fxSource } : {}),
  }
}
