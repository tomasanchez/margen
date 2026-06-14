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
