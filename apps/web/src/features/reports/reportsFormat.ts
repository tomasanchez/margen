/**
 * Pure presentation helpers shared across the redesigned Reports panels
 * (ADR-167). Kept React-free and unit-testable: KPI delta computation, the
 * "good vs bad" chip decision, sparkline point projection, and the range/label
 * derivations. Money FORMATTING itself stays in `lib/format.ts` (the single
 * source of truth); this module only computes the numbers those helpers render.
 */

import type { CategoryTrend, ReportsRange } from '../../api/reportsClient'

/** How many trailing months each range preset spans (YTD ≈ 6 for labelling). */
const RANGE_MONTHS: Record<ReportsRange, number> = {
  '3M': 3,
  '6M': 6,
  '12M': 12,
  YTD: 6,
}

/** The number of months a range covers, for the "previous {n} months" label. */
export function rangeMonths(range: ReportsRange): number {
  return RANGE_MONTHS[range]
}

/**
 * A signed percent CHANGE from `previous` to `current`, as a whole-ish percent
 * (e.g. current 120 vs previous 100 → 20). Returns null when there is no base
 * (previous is 0 / non-finite), so the caller can render a "—" rather than a
 * misleading ∞% jump.
 */
export function pctChange(
  current: number,
  previous: number,
): number | null {
  if (!Number.isFinite(previous) || previous === 0) return null
  return ((current - previous) / Math.abs(previous)) * 100
}

/**
 * Direction of a KPI delta for the chip decision. `good` maps to the positive
 * (green) treatment; otherwise the amber "watch" treatment. `higherIsBetter`
 * flips the meaning for expenses (a rise is NOT good). A null/flat delta is
 * treated as neutral-good so a 0% change never looks like a warning.
 */
export function deltaIsGood(
  delta: number | null,
  higherIsBetter: boolean,
): boolean {
  if (delta == null || delta === 0) return true
  return higherIsBetter ? delta > 0 : delta < 0
}

/** The three trend directions a category / delta can take. */
export type TrendDirection = 'up' | 'down' | 'flat'

/**
 * Direction of a category's vs-previous delta (a PERCENTAGE from the backend,
 * e.g. −6). Null (no base) reads as flat. Used to pick the sparkline colour and
 * the delta chip treatment (green for a DOWN spend, amber for UP — ADR-167).
 */
export function trendDirection(deltaPct: number | null): TrendDirection {
  if (deltaPct == null || deltaPct === 0) return 'flat'
  return deltaPct > 0 ? 'up' : 'down'
}

/**
 * Project a numeric series onto a `0..width` × `0..height` SVG polyline
 * `points` string, oldest→newest, flat when the series is constant (drawn at the
 * vertical middle). Mirrors the concept's inline sparkline. A single point (or
 * empty series) yields an empty string so the caller can omit the polyline.
 */
export function sparklinePoints(
  series: number[],
  width = 100,
  height = 28,
): string {
  if (series.length < 2) return ''
  const min = Math.min(...series)
  const max = Math.max(...series)
  const range = max - min || 1
  return series
    .map((value, index) => {
      const x = (index / (series.length - 1)) * width
      // Invert Y: SVG's origin is top-left, so a bigger value sits higher.
      const y = height - ((value - min) / range) * height
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

/** Convenience: build a category's sparkline from its trailing-6 series. */
export function categorySparkline(trend: CategoryTrend): string {
  return sparklinePoints(trend.series)
}
