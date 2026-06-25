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
import { localizedMonth } from '../../i18n/locale'
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

/**
 * A `Date` anchored at day 1 (UTC) of an ISO date's month, used purely as input
 * to `Intl.DateTimeFormat`. Day 1 + UTC formatting avoids any timezone
 * day-rollover affecting the month/year fields we format. Returns `null` for an
 * unparseable ISO so callers can fall back to the raw string.
 */
function monthDateUTC(iso: string): Date | null {
  const year = Number.parseInt(iso.slice(0, 4), 10)
  const month = Number.parseInt(iso.slice(5, 7), 10)
  // Guard the month range: an out-of-range value (e.g. "2026-13-01") would
  // otherwise roll over via Date.UTC (month 12 → Jan next year) and silently
  // mislabel the period. Returning null lets callers fall back to the raw ISO.
  if (Number.isNaN(year) || Number.isNaN(month) || month < 1 || month > 12) {
    return null
  }
  return new Date(Date.UTC(year, month - 1, 1))
}

/**
 * Long month name for an ISO date, localized off the active UI language
 * (ADR-102) and capitalized, e.g. "2026-10-01" → "October" (en) / "Octubre"
 * (es). The locale is read at call time so labels track a language switch; UTC
 * formatting keeps the month stable regardless of the runtime timezone. English
 * output is identical to the prior hardcoded table.
 */
function longMonth(iso: string): string {
  const date = monthDateUTC(iso)
  if (!date) return iso
  return localizedMonth(date, { style: 'long', utc: true })
}

/**
 * Short "Mon YYYY" label for an ISO date, localized off the active UI language
 * (ADR-102), e.g. "2025-06-01" → "Jun 2025" (en) / "Jun 2025" (es). The short
 * month name comes from `Intl` (capitalized so the Spanish "jun" reads "Jun"),
 * and the year is appended literally to keep a stable "month year" shape across
 * locales. English output is identical to the prior hardcoded table.
 */
function shortMonthYear(iso: string): string {
  const date = monthDateUTC(iso)
  if (!date) return iso
  return `${localizedMonth(date, { style: 'short', utc: true })} ${iso.slice(0, 4)}`
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
 * (services activity for MVP). The projection is explicitly an estimate — the
 * components label it as such and the standing's own `projectionNote` is the
 * source wording.
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
    arcaUrl: ARCA_SCALE_URL,
  }
}
