/**
 * TanStack Query hooks for the Home screen.
 *
 * The spending trend and "Where it went" category breakdown are now REAL: they
 * come from `GET /api/v1/summaries?month=YYYY-MM` via {@link fetchSummary} and
 * react to the selected viewing month (ADR-042/ADR-043). The Insights card is
 * also real and month-reactive, from `GET /api/v1/insights?month=YYYY-MM` via
 * {@link fetchInsights} (ADR-061/062). The Monotributo card reads its own real
 * `/monotributo` endpoint. Everything is keyed under the `home` namespace and
 * invalidated alongside transaction mutations so the cards stay fresh.
 */

import { useQuery } from '@tanstack/react-query'
import { fetchSummary, type Summary } from '../../api/summariesClient'
import { fetchInsights, type MonthlyInsights } from '../../api/insightsClient'
import { fetchMonotributo } from '../../api/monotributoClient'
import { fetchSuggestedRates, type SuggestedRates } from '../../api/fxClient'
import { standingToState } from '../monotributo/derive'
import type { MonotributoSnapshot, MonotributoState } from '../../mock/types'
import type { ViewingMonth } from '../../components/months'

/** Stable query-key factory for the Home domain. */
export const homeQueryKeys = {
  all: ['home'] as const,
  monotributo: () => [...homeQueryKeys.all, 'monotributo'] as const,
  /** Summary is per-month, so the `YYYY-MM` is part of the key (month-reactive). */
  summary: (month: string) => [...homeQueryKeys.all, 'summary', month] as const,
  /** Insights are per-month too, so the `YYYY-MM` is part of the key. */
  insights: (month: string) =>
    [...homeQueryKeys.all, 'insights', month] as const,
}

/**
 * Stable query key for the live FX rates. NOT under the `home` namespace — the
 * rates are a global FX concern (ADR-044) that the net-worth card converts with
 * (ADR-133 amendment: net worth now converts via the LIVE selected rate from
 * `fxClient`, not the last-transaction rate), and other features may share it.
 */
export const fxQueryKeys = {
  all: ['fx'] as const,
  rates: () => [...fxQueryKeys.all, 'rates'] as const,
}

/**
 * The live suggested FX rates (ARS per USD) from dolarapi.com via
 * {@link fetchSuggestedRates} (ADR-044) — both the MEP/Bolsa and the Official
 * source, each independently `null` on failure. Cached for a few minutes so a
 * Home re-render doesn't refetch, and the request is cancellable via the query
 * `signal`. The consumer (net-worth card) lets the user pick a source and must
 * NOT fabricate a rate: a `null` for the selected source degrades to native
 * amounts (ADR-037/133).
 */
export function useFxRates() {
  return useQuery<SuggestedRates>({
    queryKey: fxQueryKeys.rates(),
    queryFn: ({ signal }) => fetchSuggestedRates(signal),
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  })
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

/**
 * Real monthly insights (the structured facts behind the calm Insights card)
 * for the selected viewing month, from `GET /api/v1/insights?month=YYYY-MM`
 * (ADR-061/062). Mirrors {@link useSummary}: the query key includes the
 * `YYYY-MM`, so navigating the month navigator refetches and the card re-renders
 * with the new month's facts.
 */
export function useInsights(viewingMonth: ViewingMonth) {
  const month = toYearMonth(viewingMonth)
  return useQuery<MonthlyInsights>({
    queryKey: homeQueryKeys.insights(month),
    queryFn: () => fetchInsights(month),
  })
}
