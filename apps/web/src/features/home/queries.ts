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
import { fetchMonotributo } from '../../api/monotributoClient'
import { getInsights } from '../../mock/api'
import { standingToState } from '../monotributo/derive'
import type {
  Insight,
  MonotributoSnapshot,
  MonotributoState,
} from '../../mock/types'
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

/**
 * Current Monotributo standing for the Home card + status pill, from the real
 * `GET /api/v1/monotributo` endpoint (ADR-046/049). The card consumes the legacy
 * {@link MonotributoState}, so the snapshot's live `current` standing is adapted
 * via `select`. Kept under the `home` namespace and invalidated alongside a
 * category change so the card refetches; the dedicated page query
 * (`useMonotributoSnapshot`) owns the richer prior-period + scale data.
 */
export function useMonotributo() {
  return useQuery<MonotributoSnapshot, Error, MonotributoState>({
    queryKey: homeQueryKeys.monotributo(),
    queryFn: () => fetchMonotributo(),
    select: (snapshot) => standingToState(snapshot.current),
    staleTime: 5 * 60 * 1000,
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
