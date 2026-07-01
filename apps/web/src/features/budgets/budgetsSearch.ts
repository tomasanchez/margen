/**
 * URL search-param plumbing for the `/budgets` screen (ADR-040/125, mirroring
 * ADR-116 on Transactions). The Budgets page owns its OWN month (the global Home
 * navigator drives Home only), but that month now lives in the URL rather than
 * local `useState`: `?month=YYYY-MM`. Reload, browser back/forward, and
 * deep-links therefore restore the exact month for free.
 *
 * Two pure, unit-testable directions:
 *  - {@link validateBudgetsSearch} narrows raw params to a {@link BudgetsSearch}
 *    (a strict `YYYY-MM` token or nothing);
 *  - {@link searchToBudgetMonth} derives the live {@link ViewingMonth}, defaulting
 *    to the current calendar month when `month` is absent/invalid;
 *  - {@link monthToBudgetsSearch} encodes a month back, OMITTING the current-month
 *    default so the URL stays short (absence of `month` IS the current month).
 *
 * Kept free of React so `router.tsx` can import the validator and the page/route
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
 * Validated `/budgets` search params. Only `month` is carried; absent means
 * "the current month" (the per-screen default, ADR-040). The token is a strict
 * `YYYY-MM` — the range sentinels the Transactions filter accepts (`all` /
 * `last12` / `thisYear`) are NOT valid here (a budget is always one calendar
 * month), so they are dropped.
 */
export interface BudgetsSearch {
  month?: string
}

/**
 * Validate (and narrow) the raw `/budgets` search params. A `month` that parses
 * to a specific {@link ViewingMonth} (a `YYYY-MM` token) is kept; anything else
 * (a range sentinel, a malformed value, a missing param) is omitted so the page
 * falls back to the current month rather than throwing.
 */
export function validateBudgetsSearch(
  search: Record<string, unknown>,
): BudgetsSearch {
  const raw = search.month
  if (typeof raw !== 'string') return {}
  const parsed = parseMonthToken(raw)
  // Only a specific calendar month is valid for budgets — reject the ranges.
  if (parsed == null || typeof parsed === 'string') return {}
  return { month: raw }
}

/**
 * Derive the live viewing month from the validated params. An absent/invalid
 * `month` resolves to the CURRENT calendar month (`now` injectable for tests).
 */
export function searchToBudgetMonth(
  search: BudgetsSearch,
  now: Date = new Date(),
): ViewingMonth {
  if (search.month === undefined) return currentViewingMonth(now)
  const parsed = parseMonthToken(search.month)
  if (parsed == null || typeof parsed === 'string') return currentViewingMonth(now)
  return parsed
}

/**
 * Encode a viewing month back into `/budgets` search params, OMITTING the
 * current-month default (absence of `month` already means the current month, so
 * writing it would be redundant). Any other month serializes to `YYYY-MM`.
 */
export function monthToBudgetsSearch(
  month: ViewingMonth,
  now: Date = new Date(),
): BudgetsSearch {
  if (isSameViewingMonth(month, currentViewingMonth(now))) return {}
  return { month: serializeMonth(month) }
}
