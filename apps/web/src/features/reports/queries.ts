/**
 * TanStack Query hooks for the Reports domain (ADR-163, ADR-164, ADR-036).
 *
 * The Reports page composes FOUR reads (ADR-163): the summaries reader (spending
 * trend + category breakdown), the budgets reader (budget vs actual), and — the
 * only net-new query here — the net-worth history series (ADR-164). Those first
 * three reuse their existing hooks (`useSummary`, `useBudgets`); this module owns
 * only the reports-specific net-worth-history read so its cache is independent.
 *
 * The history query is `months`-keyed so a window change refetches; it never
 * mutates, so it carries a generous stale window. The backend returns NATIVE
 * per-currency subtotals (no FX) — conversion to the display currency happens in
 * the chart via the SAME live rate the net-worth snapshot uses (ADR-164), so the
 * "current" point matches the Home net-worth card.
 */

import { useQuery } from '@tanstack/react-query'
import {
  fetchNetWorthHistory,
  fetchReportsOverview,
  type NetWorthHistory,
  type ReportsOverview,
  type ReportsRange,
} from '../../api/reportsClient'
import type { Currency } from '../../mock/types'

/** Stable query-key factory for the Reports domain. */
export const reportsKeys = {
  all: ['reports'] as const,
  /** Net-worth history is per-`months` window (ADR-164). */
  netWorthHistory: (months: number) =>
    [...reportsKeys.all, 'net-worth-history', months] as const,
  /**
   * The range-based overview is keyed by BOTH the window and the denomination
   * currency (ADR-169): a single cache key covers the whole page, so switching
   * either re-fetches all panels together, which is semantically correct.
   */
  overview: (range: ReportsRange, currency: Currency) =>
    [...reportsKeys.all, 'overview', range, currency] as const,
}

/**
 * Read the range-based Reports overview (ADR-167/169): the KPI strip (current +
 * previous windows for deltas), the per-month cash-flow series, the per-category
 * trends, and the FX summary — every figure ALREADY denominated in `currency`
 * (ADR-168), so no client-side conversion. Keyed by `range` + `currency` so
 * either changing refetches; read-only, so a generous stale window avoids a
 * refetch on a Reports re-render.
 */
export function useReportsOverview(range: ReportsRange, currency: Currency) {
  return useQuery<ReportsOverview>({
    queryKey: reportsKeys.overview(range, currency),
    queryFn: () => fetchReportsOverview(range, currency),
    staleTime: 5 * 60 * 1000,
  })
}

/**
 * Read the monthly net-worth history for the last `months` months (ADR-164):
 * cumulative month-END native per-currency subtotals, oldest → newest. Keyed by
 * the window so switching it refetches; read-only, so a generous stale window
 * avoids a refetch on a Reports re-render.
 */
export function useNetWorthHistory(months = 12) {
  return useQuery<NetWorthHistory>({
    queryKey: reportsKeys.netWorthHistory(months),
    queryFn: () => fetchNetWorthHistory(months),
    staleTime: 5 * 60 * 1000,
  })
}
