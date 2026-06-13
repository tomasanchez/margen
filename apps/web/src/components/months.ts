/**
 * Months present in the mock data (ADR-015/020), newest first. The month
 * controls step/pick through these for now; a later task wires the selection
 * into the screens so they filter by month. Index 0 is the default
 * ("June 2026"). Kept in its own module so both the {@link MonthSwitcher}
 * presentations and the shell's shared state import one source of truth without
 * tripping the react-refresh "components-only export" rule.
 */
export const MONTHS = ['June 2026', 'May 2026', 'April 2026'] as const

export type MonthLabel = (typeof MONTHS)[number]
