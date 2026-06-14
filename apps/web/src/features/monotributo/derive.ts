/**
 * Derive the page's display shapes from the real Monotributo snapshot
 * (ADR-046, ADR-049, ADR-052).
 *
 * The MeterHero / ProjectionBreakdown / header still speak the prototype's
 * {@link MonotributoProjection} shape, but the backend no longer hands one over —
 * it returns a trailing-12-month {@link MonotributoStanding} plus the A–K scale.
 * This module reconstructs the projection figures from the real standing using
 * the same linear-annualization rule the backend states (ADR-046), so the
 * components keep working unchanged while the numbers are real and the wording
 * comes from the API's own `projectionNote`. It also adapts the standing to the
 * legacy {@link MonotributoState} the Home card / hero consume.
 */

import {
  formatCurrency,
  formatMillionsCompact,
} from '../../lib/format'
import { ARCA_SCALE_URL } from '../../mock/seed'
import type {
  MonotributoProjection,
  MonotributoScaleRow,
  MonotributoStanding,
  MonotributoState,
} from '../../mock/types'

/** Fraction of the 12-month window elapsed with data, clamped to (0, 1]. */
function elapsedFraction(standing: MonotributoStanding): number {
  const start = Date.parse(standing.periodStart)
  const end = Date.parse(standing.periodEnd)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return 1
  }
  const fraction = (end - start) / (365 * 24 * 60 * 60 * 1000)
  // Never above 1 (a full window) and never 0 (so annualization is finite).
  return Math.min(Math.max(fraction, 1 / 12), 1)
}

/** Long month name for an ISO date, e.g. "2026-10-01" → "October". */
function longMonth(iso: string): string {
  const month = Number.parseInt(iso.slice(5, 7), 10)
  const names = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ]
  return names[month - 1] ?? iso
}

/** Short "Mon YYYY" label for an ISO date, e.g. "2025-06-01" → "Jun 2025". */
function shortMonthYear(iso: string): string {
  const month = Number.parseInt(iso.slice(5, 7), 10)
  const year = iso.slice(0, 4)
  const names = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ]
  const name = names[month - 1]
  return name ? `${name} ${year}` : iso
}

/** The scale row for a category letter, if present. */
function rowFor(
  scale: MonotributoScaleRow[],
  letter: string,
): MonotributoScaleRow | undefined {
  return scale.find((r) => r.letter === letter)
}

/**
 * Adapt the trailing-12-month standing to the legacy {@link MonotributoState}
 * the Home card and StatusHero / MetricCards consume. `margin` is the remaining
 * room before the ceiling; `projectedPaceLabel` carries the API's estimate note.
 */
export function standingToState(
  standing: MonotributoStanding,
): MonotributoState {
  return {
    category: standing.category,
    used: standing.used,
    annualLimit: standing.annualLimit,
    usedRatio: standing.ratio,
    margin: standing.remaining,
    projectedCategory: standing.projectedCategory,
    projectedPaceLabel: standing.projectionNote,
    status: standing.status,
  }
}

/**
 * Reconstruct the {@link MonotributoProjection} from the real standing + scale.
 *
 * `used` over the elapsed fraction of the window gives the linear-annualized
 * total (ADR-046); the projected category and its ceiling come from the scale.
 * The fee impact reads the current vs projected category's `cuotaServicios`
 * (services activity for MVP). Window-shaped labels (`nextRecategorization`,
 * `evaluates`) are derived from the period dates. The projection is explicitly
 * an estimate — the components label it as such and the standing's own
 * `projectionNote` is the source wording.
 */
export function deriveProjection(
  standing: MonotributoStanding,
  scale: MonotributoScaleRow[],
): MonotributoProjection {
  const fraction = elapsedFraction(standing)
  const projectedAnnual = Math.round(standing.used / fraction)
  const monthlyAverage = Math.round(standing.used / (fraction * 12))

  const currentRow = rowFor(scale, standing.category)
  const projectedRow = rowFor(scale, standing.projectedCategory)
  const currentCuota = currentRow?.cuotaServicios ?? 0
  const projectedCuota = projectedRow?.cuotaServicios ?? currentCuota
  const landsInCeiling = projectedRow?.annualCeiling ?? standing.annualLimit

  // Approximate the month the ceiling is reached at the current monthly pace,
  // counting forward from the window end; falls back to the window end month.
  const monthsToCeiling =
    monthlyAverage > 0
      ? Math.max(
          0,
          Math.round((standing.annualLimit - standing.used) / monthlyAverage),
        )
      : 0
  const ceilingDate = new Date(`${standing.periodEnd}T00:00:00Z`)
  if (!Number.isNaN(ceilingDate.getTime())) {
    ceilingDate.setUTCMonth(ceilingDate.getUTCMonth() + monthsToCeiling)
  }
  const ceilingMonth = Number.isNaN(ceilingDate.getTime())
    ? longMonth(standing.periodEnd)
    : longMonth(ceilingDate.toISOString().slice(0, 10))

  const projectedAnnualLabel = `≈ ${formatCurrency(projectedAnnual, 'ARS')}`

  const periodLabel = `${shortMonthYear(standing.periodStart)} – ${shortMonthYear(standing.periodEnd)}`

  return {
    invoicedToDate: standing.used,
    periodLabel,
    monthlyAverage,
    projectedAnnual,
    projectedAnnualLabel,
    currentCategory: standing.category,
    landsInCategory: standing.projectedCategory,
    landsInCeilingLabel: formatMillionsCompact(landsInCeiling),
    currentCuota,
    projectedCuota,
    ceilingMonth,
    marginMonths: monthsToCeiling,
    nextRecategorization: 'next review',
    evaluates: 'trailing 12 months',
    arcaUrl: ARCA_SCALE_URL,
  }
}
