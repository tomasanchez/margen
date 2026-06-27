/**
 * The shared "viewing month" value model (ADR-040).
 *
 * The month navigator (top bar) and Home both speak this small `{ year, month }`
 * value (`month` is 0-based, JS-Date style) so navigation can cross year
 * boundaries precisely and Home can filter real transactions by year+month from
 * their `occurredOn` ISO date. Kept in a non-component module so both the
 * {@link MonthSwitcher} presentations and the {@link MonthProvider} import one
 * source of truth without tripping the react-refresh "components-only export"
 * rule.
 */

import { localizedMonth } from '../i18n/locale'

/** A specific calendar month. `month` is 0-based (0 = January) like `Date`. */
export interface ViewingMonth {
  year: number
  /** 0-based month index (0 = January, 11 = December). */
  month: number
}

/**
 * A `Date` anchored at day 1 of the viewing month, used purely as input to
 * `Intl.DateTimeFormat`. Day 1 avoids any timezone day-rollover affecting the
 * month/year fields we format.
 */
function monthDate(value: ViewingMonth): Date {
  return new Date(value.year, value.month, 1)
}

/** The current real calendar month, resolved at runtime (the default view). */
export function currentViewingMonth(now: Date = new Date()): ViewingMonth {
  return { year: now.getFullYear(), month: now.getMonth() }
}

/** Two viewing months are equal when both year and month match. */
export function isSameViewingMonth(a: ViewingMonth, b: ViewingMonth): boolean {
  return a.year === b.year && a.month === b.month
}

/**
 * Step a viewing month by `delta` calendar months, crossing year boundaries.
 * `delta` of -1 is the previous month, +1 the next.
 */
export function addMonths(value: ViewingMonth, delta: number): ViewingMonth {
  const total = value.year * 12 + value.month + delta
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 }
}

/**
 * The full-name month + year label in the active UI language (ADR-102), e.g.
 * `{ year: 2026, month: 5 }` → "June 2026" (en) / "Julio 2026" (es). The month
 * name is formatted alone, capitalized (locale-aware), and composed with a plain
 * space before the year — this drops the Spanish "de" and lowercase that
 * `{ month: 'long', year: 'numeric' }` would emit ("julio de 2026") while
 * leaving English byte-identical. The locale is read at call time so it tracks a
 * language switch.
 */
export function formatViewingMonth(value: ViewingMonth): string {
  return `${monthName(value)} ${value.year}`
}

/**
 * The full month name only in the active UI language (ADR-102), capitalized,
 * e.g. "June" (en) / "Julio" (es). The locale is read at call time.
 */
export function monthName(value: ViewingMonth): string {
  return localizedMonth(monthDate(value), { style: 'long' })
}

/**
 * A descending window of recent months for the compact picker: `count` months
 * ending at `anchor` (inclusive), newest first. Defaults to the current month
 * plus the previous eleven (a rolling year).
 */
export function recentMonthsWindow(
  anchor: ViewingMonth,
  count = 12,
): ViewingMonth[] {
  return Array.from({ length: count }, (_, i) => addMonths(anchor, -i))
}

/**
 * How many months back the Home navigator can reach below the current month
 * (ADR-041). The reachable window is the current month plus the previous
 * {@link MONTH_NAVIGATOR_FLOOR_OFFSET} months — 7 months total. Older months are
 * found via Transactions (the redirect), not the Home navigator.
 */
export const MONTH_NAVIGATOR_FLOOR_OFFSET = 6

/**
 * The newest month the navigator can reach: the client's current real month. No
 * future months exist (consistent with the no-future-date rule on the form).
 */
export function upperBoundMonth(now: Date = new Date()): ViewingMonth {
  return currentViewingMonth(now)
}

/**
 * The oldest month the navigator can reach: exactly
 * {@link MONTH_NAVIGATOR_FLOOR_OFFSET} months before the current month. Going
 * below this floor redirects to Transactions instead of stepping further.
 */
export function lowerBoundMonth(now: Date = new Date()): ViewingMonth {
  return addMonths(currentViewingMonth(now), -MONTH_NAVIGATOR_FLOOR_OFFSET)
}

/** Compare two viewing months: <0 if `a` is earlier, >0 if later, 0 if equal. */
export function compareViewingMonths(a: ViewingMonth, b: ViewingMonth): number {
  return a.year * 12 + a.month - (b.year * 12 + b.month)
}

/** True when the viewing month is at (or beyond) the navigator's newest month. */
export function isAtUpperBound(
  value: ViewingMonth,
  now: Date = new Date(),
): boolean {
  return compareViewingMonths(value, upperBoundMonth(now)) >= 0
}

/** True when the viewing month is at (or below) the navigator's 6-months-ago floor. */
export function isAtLowerBound(
  value: ViewingMonth,
  now: Date = new Date(),
): boolean {
  return compareViewingMonths(value, lowerBoundMonth(now)) <= 0
}

/**
 * Clamp a viewing month into the reachable `[lowerBound, upperBound]` window.
 * Defensive: keeps the shared state in range even if something sets it outside
 * (e.g. a stale value or a future restore).
 */
export function clampViewingMonth(
  value: ViewingMonth,
  now: Date = new Date(),
): ViewingMonth {
  const upper = upperBoundMonth(now)
  const lower = lowerBoundMonth(now)
  if (compareViewingMonths(value, upper) > 0) return upper
  if (compareViewingMonths(value, lower) < 0) return lower
  return value
}

/**
 * The bounded month list for the compact picker (ADR-041): the current month
 * down to the 6-months-ago floor, newest first — no future, no older entries.
 */
export function boundedMonthsWindow(now: Date = new Date()): ViewingMonth[] {
  return recentMonthsWindow(
    upperBoundMonth(now),
    MONTH_NAVIGATOR_FLOOR_OFFSET + 1,
  )
}

/**
 * Sentinel for "no month scope" — the Transactions page's month filter is
 * either a specific {@link ViewingMonth} or this `'all'` ("All time") escape
 * hatch that shows every transaction regardless of year+month. The global Home
 * navigator (ADR-040/041) is always bounded to a real month, so it never uses
 * this; only the per-screen Transactions picker does.
 */
export const ALL_MONTHS = 'all' as const

/**
 * Sentinel for the rolling "Last 12 months" range — the first day of the month
 * twelve months before "today" through today, inclusive. Matches the backend's
 * Monotributo trailing window (`monotributo.py::trailing_window`:
 * `add_months(today, -12)` first-of-month → today). The Home Monotributo
 * drill-in opens Transactions at this window so the visible invoices line up
 * with the annual total the card reports.
 */
export const LAST_12_MONTHS = 'last12' as const

/**
 * Sentinel for the "This year" range — January 1 of the current calendar year
 * through today, inclusive (year-to-date).
 */
export const THIS_YEAR = 'thisYear' as const

/**
 * The Transactions month filter: a specific {@link ViewingMonth}, or one of the
 * three named-range sentinels — `'all'` ("All time", no scope), `'last12'`
 * (rolling Last-12-months), `'thisYear'` (current calendar year to date). The
 * global Home navigator (ADR-040/041) is always bounded to a real month, so it
 * only ever uses a {@link ViewingMonth}; only the per-screen Transactions picker
 * uses the sentinels.
 */
export type MonthSelection =
  | ViewingMonth
  | typeof ALL_MONTHS
  | typeof LAST_12_MONTHS
  | typeof THIS_YEAR

/**
 * Newest-first month options for the Transactions month picker (ADR-040: the
 * ledger keeps its OWN per-screen month, NOT the Home navigator's 6-month
 * floor). Spans every month that actually has data — from the latest down to
 * the earliest `occurredOn` present — so the user can reach any historical
 * month; the "All time" sentinel is the catch-all. Falls back to the current
 * month when the list is empty, so the default selection always has an option.
 */
export function monthsWithData(
  occurredOns: readonly string[],
  now: Date = new Date(),
): ViewingMonth[] {
  const seen = new Set<number>()
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const iso of occurredOns) {
    const year = Number.parseInt(iso.slice(0, 4), 10)
    const month = Number.parseInt(iso.slice(5, 7), 10) - 1
    if (Number.isNaN(year) || Number.isNaN(month)) continue
    const ord = year * 12 + month
    seen.add(ord)
    if (ord < min) min = ord
    if (ord > max) max = ord
  }

  if (seen.size === 0) return [currentViewingMonth(now)]

  // Span the full contiguous range (newest first) so months with no rows are
  // still reachable between two that do — a calm, complete picker.
  const months: ViewingMonth[] = []
  for (let ord = max; ord >= min; ord -= 1) {
    months.push({ year: Math.floor(ord / 12), month: ((ord % 12) + 12) % 12 })
  }
  return months
}
