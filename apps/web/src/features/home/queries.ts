/**
 * TanStack Query hooks for the Home screen, over the in-memory mock API
 * (ADR-015).
 *
 * Monotributo / trend / breakdown / insights are read-only seed snapshots in
 * the prototype (ADR-020 hardcodes the figures). They are keyed under the
 * `home` namespace and invalidated alongside transaction mutations so that, in
 * the eventual backend where these are recomputed from transactions, the wiring
 * already matches. The Transactions list itself lives in the transactions
 * feature so both screens share that one source.
 */

import { useQuery } from '@tanstack/react-query'
import {
  getCategoryBreakdown,
  getInsights,
  getMonotributo,
  getTrend,
} from '../../mock/api'
import type {
  CategorySpend,
  Insight,
  MonotributoState,
  TrendPoint,
} from '../../mock/types'

/** Stable query-key factory for the Home domain. */
export const homeQueryKeys = {
  all: ['home'] as const,
  monotributo: () => [...homeQueryKeys.all, 'monotributo'] as const,
  trend: () => [...homeQueryKeys.all, 'trend'] as const,
  categoryBreakdown: () =>
    [...homeQueryKeys.all, 'categoryBreakdown'] as const,
  insights: () => [...homeQueryKeys.all, 'insights'] as const,
}

/** Current Monotributo standing for the meter + status pill. */
export function useMonotributo() {
  return useQuery<MonotributoState>({
    queryKey: homeQueryKeys.monotributo(),
    queryFn: () => getMonotributo(),
  })
}

/** 6-month spending trend for the trend bars. */
export function useTrend() {
  return useQuery<TrendPoint[]>({
    queryKey: homeQueryKeys.trend(),
    queryFn: () => getTrend(),
  })
}

/** Category breakdown ("Where it went") for the current month. */
export function useCategoryBreakdown() {
  return useQuery<CategorySpend[]>({
    queryKey: homeQueryKeys.categoryBreakdown(),
    queryFn: () => getCategoryBreakdown(),
  })
}

/** Home insights list. */
export function useInsights() {
  return useQuery<Insight[]>({
    queryKey: homeQueryKeys.insights(),
    queryFn: () => getInsights(),
  })
}
