/**
 * Pure conversion of the native net-worth history into a single display-currency
 * series (ADR-164).
 *
 * The net-worth-history endpoint returns each month's cumulative NATIVE per-
 * currency subtotals (`arsTotal` + `usdTotal`) and performs no FX (ADR-164). The
 * Reports net-worth chart converts each month to ONE figure in the user's
 * preferred display currency, at the SAME live rate the Home net-worth snapshot
 * uses ({@link convertAtMep} / the preferred-rate source) — so the chart's
 * "current" point lines up with the snapshot card (ADR-123/164).
 *
 * Kept free of React so it's unit-testable in isolation. Degrade (ADR-037): when
 * the OTHER currency is present but no usable live rate exists, the point's value
 * is `null` (the chart drops it / shows a calm "no rate" note) — we never
 * fabricate a rate. When there is no other-currency balance in a month, that
 * month converts trivially (no rate needed).
 */

import type { Currency } from '../../mock/types'
import { convertAtMep, usableMep } from '../accounts/grouping'
import type { NetWorthHistoryPoint } from '../../api/reportsClient'

/** One chart point: the raw month token plus its converted display-currency value. */
export interface NetWorthSeriesPoint {
  /** Calendar month as `YYYY-MM` (the chart localizes the axis label). */
  month: string
  /**
   * Net worth in the display currency for the month, or `null` when an
   * other-currency balance couldn't be converted (no usable rate — degrade).
   */
  value: number | null
}

/**
 * Convert one native history point to the display currency at the live `mep`
 * (ARS per USD). Sums the display-currency native part with the OTHER currency's
 * part converted at the rate. Returns `null` for the value when the other part
 * exists but no usable rate does (degrade — never fabricate a rate, ADR-164).
 */
export function convertHistoryPoint(
  point: NetWorthHistoryPoint,
  displayCurrency: Currency,
  mep: number | null,
): NetWorthSeriesPoint {
  const rate = usableMep(mep)
  const displayNative =
    displayCurrency === 'USD' ? point.usdTotal : point.arsTotal
  const otherNative =
    displayCurrency === 'USD' ? point.arsTotal : point.usdTotal
  const otherCurrency: Currency = displayCurrency === 'USD' ? 'ARS' : 'USD'
  // Only the OTHER currency's balance needs the rate; when it's zero there is
  // nothing to convert, so the month renders even without a rate.
  if (otherNative === 0) {
    return { month: point.month, value: displayNative }
  }
  const convertedOther = convertAtMep(
    otherNative,
    otherCurrency,
    displayCurrency,
    rate,
  )
  return {
    month: point.month,
    value: convertedOther == null ? null : displayNative + convertedOther,
  }
}

/**
 * Convert the whole native history series to the display currency at the single
 * live `mep`. Preserves order (oldest → newest); each point degrades to a `null`
 * value independently when only its cross-currency part is unconvertible.
 */
export function convertNetWorthSeries(
  months: NetWorthHistoryPoint[],
  displayCurrency: Currency,
  mep: number | null,
): NetWorthSeriesPoint[] {
  return months.map((point) =>
    convertHistoryPoint(point, displayCurrency, mep),
  )
}

/**
 * Whether the series has at least one month with a real (non-null) converted
 * value — drives whether the chart can render at all vs. showing the calm "no
 * rate yet" degrade note (ADR-037).
 */
export function hasAnyConvertedValue(
  series: NetWorthSeriesPoint[],
): boolean {
  return series.some((point) => point.value != null)
}
