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

/** A specific calendar month. `month` is 0-based (0 = January) like `Date`. */
export interface ViewingMonth {
  year: number
  /** 0-based month index (0 = January, 11 = December). */
  month: number
}

const MONTH_NAMES = [
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
] as const

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

/** The full-name month label, e.g. `{ year: 2026, month: 5 }` → "June 2026". */
export function formatViewingMonth(value: ViewingMonth): string {
  return `${MONTH_NAMES[value.month]} ${value.year}`
}

/** The full month name only, e.g. "June" (matches the legacy `MonthName` union). */
export function monthName(value: ViewingMonth): string {
  return MONTH_NAMES[value.month]
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
