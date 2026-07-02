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

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  fetchNetWorthHistory,
  fetchReportsOverview,
  type NetWorthHistory,
  type ReportsOverview,
  type ReportsRange,
} from '../../api/reportsClient'
import { fetchForecast, type ForecastSeries } from '../../api/forecastClient'
import { useDisplayCurrency } from '../settings/displayCurrencyContext'
import { rangeToHorizon } from './reportsFormat'
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
  /**
   * The cash-flow forecast is keyed by BOTH the forward horizon and the
   * denomination currency (ADR-176/178): switching either refetches the panel,
   * independently of the overview cache so one failing query never blanks the
   * other (ADR-037/178).
   */
  forecast: (horizon: number, currency: Currency) =>
    [...reportsKeys.all, 'forecast', horizon, currency] as const,
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

/**
 * Read the schedule/commitment-driven cash-flow forecast (ADR-176/177/178): the
 * forward committed-outflow series over `horizon` months plus the committed
 * streams (subscriptions, installment tails, the monotributo cuota) — every figure
 * ALREADY denominated in `currency` (ADR-168), so no client-side conversion. Keyed
 * by `horizon` + `currency` so either changing refetches; read-only, so a generous
 * stale window avoids a refetch on a Reports re-render. This is a SECOND async call
 * on the Reports page — it owns its own cache so a failure surfaces a calm error in
 * the forecast panel only, never blanking the overview panels (ADR-037/178).
 */
export function useForecast(horizon: number, currency: Currency) {
  return useQuery<ForecastSeries>({
    queryKey: reportsKeys.forecast(horizon, currency),
    queryFn: () => fetchForecast(horizon, currency),
    staleTime: 5 * 60 * 1000,
  })
}

/**
 * The forward monthly monotributo cuota from the forecast (ADR-177), or null when
 * the forecast is absent / has no tax leg. Lets the Reports page feed the
 * Monotributo trajectory card its forward cuota from the SAME forecast query the
 * forecast panel uses (TanStack Query dedupes by the `horizon`+`currency` key), so
 * no second fetch. The `tax` commitment is AFIP-ARS (native ARS, ADR-177); its
 * per-occurrence `amount` is the fixed monthly cuota regardless of how many months
 * it lands in, so the first tax line's amount is the figure.
 */
export function useForwardMonotributoCuota(range: ReportsRange): number | null {
  const { effectiveCurrency } = useDisplayCurrency()
  const horizon = rangeToHorizon(range)
  const forecastQuery = useForecast(horizon, effectiveCurrency)
  return useMemo(() => {
    const tax = forecastQuery.data?.commitments.find(
      (line) => line.source === 'tax' || line.arsFixed,
    )
    return tax != null && tax.amount > 0 ? tax.amount : null
  }, [forecastQuery.data])
}
