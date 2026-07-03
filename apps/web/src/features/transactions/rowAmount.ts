/**
 * Pure resolver for how a transaction row reads in the PREFERRED display currency
 * (ADR-056/148/161). Split out of `TransactionRow.tsx` so the component file only
 * exports components (Fast Refresh) while this stays a plain, unit-testable
 * function the desktop AND mobile rows share — the currency logic never drifts
 * between the two breakpoints.
 */

import type { Currency, Transaction } from '../../mock/types'

/** Everything the row needs to render its <Amount> in the effective currency. */
export interface RowAmountView {
  /** Magnitude to render (sign comes from `type`). */
  value: number
  /** Currency actually rendered — may be ARS even when USD is preferred (fallback). */
  currency: Currency
  /** Original USD amount for the FX subline (USD-account rows in ARS mode only). */
  fxUsd?: number
  /** MEP rate for the FX subline (USD-account rows in ARS mode only). */
  fxRate?: number
  /** FX source for the subline (USD-account rows in ARS mode only). */
  fxSource?: Transaction['fxRateType']
}

/**
 * Resolve how a transaction reads in the PREFERRED display currency (ADR-056),
 * mirroring Home/budgets. The ledger no longer hardcodes ARS on the <Amount>:
 *
 *  - Effective ARS (USD not preferred, or no live rate): NATIVE amount, with the
 *    familiar FX subline on USD-account rows (unchanged behavior).
 *  - Effective USD:
 *     - a row WITH a per-tx snapshot shows that HISTORICALLY-accurate USD — NOT a
 *       re-derivation at the live rate. The frontend carries that materialized
 *       `usd_amount` as {@link Transaction.usd} (the contract aliases the stored
 *       `usd_amount` to the JSON `usd` — ADR-148), so ONE branch covers every
 *       snapshotted row: USD-account rows, ARS expenses, and transfer fees (#1). A
 *       snapshot is present iff `usd` is a finite number (equivalently `fxSource`
 *       set).
 *     - a row WITHOUT a snapshot falls back to a LIVE-rate conversion
 *       (`amount ÷ rate`) when a rate exists, else stays NATIVE ARS. Never
 *       NaN/blank. This includes ARS income (ADR-156), legacy rows, a fee/row
 *       whose rate was unavailable at capture, AND reimbursements: a reimbursement
 *       ledger row carries its OWN `usd_amount = null` (ADR-161) — it has no
 *       snapshot of its own — so it displays via this live-rate fallback just like
 *       ARS income (it does NOT inherit the linked expense's rate here).
 *
 * Pure + unit-testable: the caller passes the effective currency + live rate.
 */
export function resolveRowAmount(
  t: Transaction,
  effectiveCurrency: Currency,
  liveRate: number | null,
): RowAmountView {
  const isUsdRow = t.currency === 'USD'

  // ARS-effective: native, with the USD-row FX subline preserved as before.
  if (effectiveCurrency !== 'USD') {
    return {
      value: t.amountNum,
      currency: 'ARS',
      ...(isUsdRow
        ? { fxUsd: t.usd, fxRate: t.rate, fxSource: t.fxRateType }
        : {}),
    }
  }

  // USD-effective. A snapshotted row (USD-account rows, ARS expenses, transfer
  // fees — ADR-148) shows its materialized per-tx USD (the JSON `usd`),
  // historically accurate and NEVER re-derived at the live rate. Reimbursements
  // carry no own snapshot (usd_amount null, ADR-161) so they miss this branch and
  // fall through to the live-rate fallback below.
  if (typeof t.usd === 'number' && Number.isFinite(t.usd)) {
    return { value: t.usd, currency: 'USD' }
  }

  // No snapshot: convert at the LIVE rate when we have one; else stay native ARS.
  if (liveRate != null && Number.isFinite(liveRate) && liveRate > 0) {
    return { value: t.amountNum / liveRate, currency: 'USD' }
  }
  return { value: t.amountNum, currency: 'ARS' }
}
