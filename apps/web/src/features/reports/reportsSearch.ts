/**
 * URL search-param plumbing for the redesigned `/reports` screen (ADR-167,
 * mirroring the Budgets month pattern, ADR-040/125). The whole page is scoped to
 * a preset analytics WINDOW — 3M / 6M / 12M / YTD — that drives every panel; that
 * window lives in the URL as `?range=6M` so reload, back/forward, and deep-links
 * restore it. (The month-based `?month=YYYY-MM` scoping of the old page is
 * dropped — ADR-167.)
 *
 * Three pure, unit-testable directions mirror `budgetsSearch.ts`:
 *  - {@link validateReportsSearch} narrows raw params to a {@link ReportsSearch}
 *    (a valid range token or nothing);
 *  - {@link searchToReportRange} derives the live {@link ReportsRange}, defaulting
 *    to `6M` when `range` is absent/invalid (ADR-169);
 *  - {@link rangeToReportsSearch} encodes a range back, OMITTING the default `6M`
 *    so the URL stays short (absence of `range` IS the default window).
 *
 * Kept free of React so `router.tsx` can import the validator and the route
 * bridge can import the derivations without a component-export cycle.
 */

import type { ReportsRange } from '../../api/reportsClient'

/** The default analytics window when none is in the URL (ADR-169). */
export const DEFAULT_REPORTS_RANGE: ReportsRange = '6M'

/** The valid range tokens, in the order the segmented picker shows them. */
export const REPORTS_RANGES: readonly ReportsRange[] = [
  '3M',
  '6M',
  '12M',
  'YTD',
] as const

/** Type guard: is `value` one of the four valid range presets? */
export function isReportsRange(value: unknown): value is ReportsRange {
  return (
    typeof value === 'string' &&
    (REPORTS_RANGES as readonly string[]).includes(value)
  )
}

/**
 * Validated `/reports` search params. Only `range` is carried; absent means "the
 * default 6M window". Anything that is not one of the four presets is dropped so
 * the page falls back to the default rather than throwing.
 */
export interface ReportsSearch {
  range?: ReportsRange
}

/**
 * Validate (and narrow) the raw `/reports` search params. A `range` that is one
 * of the four presets is kept; anything else (a stale `month` param, a malformed
 * value, a missing param) is omitted so the page falls back to the default.
 */
export function validateReportsSearch(
  search: Record<string, unknown>,
): ReportsSearch {
  return isReportsRange(search.range) ? { range: search.range } : {}
}

/**
 * Derive the live range from the validated params. An absent/invalid `range`
 * resolves to the default {@link DEFAULT_REPORTS_RANGE} (`6M`).
 */
export function searchToReportRange(search: ReportsSearch): ReportsRange {
  return isReportsRange(search.range) ? search.range : DEFAULT_REPORTS_RANGE
}

/**
 * Encode a range back into `/reports` search params, OMITTING the default `6M`
 * (absence already means the default window, so writing it would be redundant).
 * Any other preset serializes to `?range=<token>`.
 */
export function rangeToReportsSearch(range: ReportsRange): ReportsSearch {
  return range === DEFAULT_REPORTS_RANGE ? {} : { range }
}
