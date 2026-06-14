/**
 * TanStack Query hooks for the Home screen.
 *
 * The spending trend and "Where it went" category breakdown are now REAL: they
 * come from `GET /api/v1/summaries?month=YYYY-MM` via {@link fetchSummary} and
 * react to the selected viewing month (ADR-042/ADR-043). Insights and the
 * Monotributo card stay on the read-only in-memory mock seed until their own
 * issues ship (ADR-035); they are keyed under the `home` namespace and
 * invalidated alongside transaction mutations so the wiring already matches the
 * eventual backend.
 */

import { useQuery } from '@tanstack/react-query'
import { fetchSummary, type Summary } from '../../api/summariesClient'
import { getInsights, getMonotributo } from '../../mock/api'
import type { Insight, MonotributoState } from '../../mock/types'
import type { ViewingMonth } from '../../components/months'

/** Stable query-key factory for the Home domain. */
export const homeQueryKeys = {
  all: ['home'] as const,
  monotributo: () => [...homeQueryKeys.all, 'monotributo'] as const,
  /** Summary is per-month, so the `YYYY-MM` is part of the key (month-reactive). */
  summary: (month: string) => [...homeQueryKeys.all, 'summary', month] as const,
  insights: () => [...homeQueryKeys.all, 'insights'] as const,
}

/** Format a viewing month to the backend's `YYYY-MM` query value. */
export function toYearMonth(value: ViewingMonth): string {
  const month = String(value.month + 1).padStart(2, '0')
  return `${value.year}-${month}`
}

/** Current Monotributo standing for the meter + status pill (mock seed). */
export function useMonotributo() {
  return useQuery<MonotributoState>({
    queryKey: homeQueryKeys.monotributo(),
    queryFn: () => getMonotributo(),
  })
}

/**
 * Real monthly summary (spending trend + category breakdown) for the selected
 * viewing month. The query key includes the `YYYY-MM`, so navigating the month
 * navigator refetches and re-renders both cards (ADR-040/ADR-043).
 */
export function useSummary(viewingMonth: ViewingMonth) {
  const month = toYearMonth(viewingMonth)
  return useQuery<Summary>({
    queryKey: homeQueryKeys.summary(month),
    queryFn: () => fetchSummary(month),
  })
}

/** Home insights list (mock seed). */
export function useInsights() {
  return useQuery<Insight[]>({
    queryKey: homeQueryKeys.insights(),
    queryFn: () => getInsights(),
  })
}
