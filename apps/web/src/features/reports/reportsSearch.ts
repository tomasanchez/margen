/**
 * URL search-param plumbing for the `/reports` screen (mirroring the Budgets
 * pattern, ADR-040/116/125). The category-breakdown, budget-vs-actual, and
 * summary-CSV export are all scoped to a month; that month lives in the URL as
 * `?month=YYYY-MM` so reload, back/forward, and deep-links restore it. (The
 * spending-trend and net-worth charts are trailing windows, unaffected by it.)
 *
 * Two pure, unit-testable directions mirror `budgetsSearch.ts`:
 *  - {@link validateReportsSearch} narrows raw params to a {@link ReportsSearch}
 *    (a strict `YYYY-MM` token or nothing);
 *  - {@link searchToReportMonth} derives the live {@link ViewingMonth}, defaulting
 *    to the current calendar month when `month` is absent/invalid;
 *  - {@link monthToReportsSearch} encodes a month back, OMITTING the current-month
 *    default so the URL stays short.
 *
 * Kept free of React so `router.tsx` can import the validator and the route
 * bridge can import the derivations without a component-export cycle.
 */

import {
  currentViewingMonth,
  isSameViewingMonth,
  parseMonthToken,
  serializeMonth,
  type ViewingMonth,
} from '../../components/months'

/**
 * Validated `/reports` search params. Only `month` is carried; absent means "the
 * current month". The token is a strict `YYYY-MM` — the Transactions range
 * sentinels (`all` / `last12` / `thisYear`) are NOT valid here (a report month is
 * always one calendar month), so they are dropped.
 */
export interface ReportsSearch {
  month?: string
}

/**
 * Validate (and narrow) the raw `/reports` search params. A `month` that parses
 * to a specific {@link ViewingMonth} (a `YYYY-MM` token) is kept; anything else
 * (a range sentinel, a malformed value, a missing param) is omitted so the page
 * falls back to the current month rather than throwing.
 */
export function validateReportsSearch(
  search: Record<string, unknown>,
): ReportsSearch {
  const raw = search.month
  if (typeof raw !== 'string') return {}
  const parsed = parseMonthToken(raw)
  if (parsed == null || typeof parsed === 'string') return {}
  return { month: raw }
}

/**
 * Derive the live viewing month from the validated params. An absent/invalid
 * `month` resolves to the CURRENT calendar month (`now` injectable for tests).
 */
export function searchToReportMonth(
  search: ReportsSearch,
  now: Date = new Date(),
): ViewingMonth {
  if (search.month === undefined) return currentViewingMonth(now)
  const parsed = parseMonthToken(search.month)
  if (parsed == null || typeof parsed === 'string') return currentViewingMonth(now)
  return parsed
}

/**
 * Encode a viewing month back into `/reports` search params, OMITTING the
 * current-month default (absence of `month` already means the current month).
 */
export function monthToReportsSearch(
  month: ViewingMonth,
  now: Date = new Date(),
): ReportsSearch {
  if (isSameViewingMonth(month, currentViewingMonth(now))) return {}
  return { month: serializeMonth(month) }
}
