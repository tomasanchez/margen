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
  type NetWorthHistory,
} from '../../api/reportsClient'

/** Stable query-key factory for the Reports domain. */
export const reportsKeys = {
  all: ['reports'] as const,
  /** Net-worth history is per-`months` window (ADR-164). */
  netWorthHistory: (months: number) =>
    [...reportsKeys.all, 'net-worth-history', months] as const,
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
