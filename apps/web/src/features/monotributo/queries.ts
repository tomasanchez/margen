/**
 * TanStack Query hooks for the Monotributo feature, over the real backend
 * (ADR-046, ADR-049, ADR-052).
 *
 * One query owns the whole `GET /api/v1/monotributo` snapshot (current + prior
 * standing, the A–K scale, and the included invoices) via {@link fetchMonotributo};
 * the page derives the meter standing, scale, invoices, and projection from it
 * with the `select`-style helpers below. A mutation updates the configured
 * category through {@link updateMonotributoCategory} and invalidates the snapshot
 * (and the Home Monotributo card, which reads the same standing) on success so
 * the figures refetch.
 *
 * The mock async Monotributo getters (ADR-015) are removed in favor of this
 * client; the still-mock Home insights keep their own seam (ADR-035).
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  fetchMonotributo,
  updateMonotributoCategory,
} from '../../api/monotributoClient'
import type { MonotributoSnapshot } from '../../mock/types'
import { homeQueryKeys } from '../home/queries'

/** Stable query-key factory for the Monotributo domain. */
export const monotributoQueryKeys = {
  all: ['monotributo'] as const,
  snapshot: () => [...monotributoQueryKeys.all, 'snapshot'] as const,
}

/**
 * The whole Monotributo snapshot — current + prior trailing-12-month standing,
 * the A–K scale, and the included invoices. The page derives every section from
 * this one query so a category change refetches everything at once.
 */
export function useMonotributoSnapshot() {
  return useQuery<MonotributoSnapshot>({
    queryKey: monotributoQueryKeys.snapshot(),
    queryFn: () => fetchMonotributo(),
    staleTime: 5 * 60 * 1000,
  })
}

/**
 * Update the configured Monotributo category (and optionally activity type),
 * then invalidate the snapshot + the Home Monotributo card so both refetch the
 * real standing. Returns the full mutation result so the page can reflect
 * `isPending` (disable the control) and surface a 422 inline (ADR-049).
 */
export function useUpdateMonotributoCategory() {
  const queryClient = useQueryClient()
  return useMutation<
    { currentCategory: string; activityType: string },
    Error,
    { currentCategory: string; activityType?: string }
  >({
    mutationFn: ({ currentCategory, activityType }) =>
      updateMonotributoCategory(currentCategory, activityType),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: monotributoQueryKeys.all,
      })
      void queryClient.invalidateQueries({
        queryKey: homeQueryKeys.monotributo(),
      })
    },
  })
}
