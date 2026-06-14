/**
 * TanStack Query hooks for the Monotributo feature, over the real backend
 * (ADR-046, ADR-049, ADR-052).
 *
 * One query owns the whole `GET /api/v1/monotributo` snapshot (current + prior
 * standing, the A–K scale, and the included invoices) via {@link fetchMonotributo};
 * the page derives the meter standing, scale, invoices, and projection from it
 * with the `select`-style helpers below. A mutation updates the configured
 * category — now through `PATCH /api/v1/settings` (ADR-054/057; the separate
 * `PATCH /monotributo/config` endpoint was removed) — and invalidates the
 * snapshot, the Home Monotributo card (which reads the same standing), and the
 * settings query on success so the figures and the Settings page refetch.
 *
 * The mock async Monotributo getters (ADR-015) are removed in favor of this
 * client; the still-mock Home insights keep their own seam (ADR-035).
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { fetchMonotributo } from '../../api/monotributoClient'
import { updateSettings, type Settings } from '../../api/settingsClient'
import type { MonotributoSnapshot } from '../../mock/types'
import { homeQueryKeys } from '../home/queries'
import { settingsQueryKeys } from '../settings/queries'

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
 * Update the configured Monotributo category (and optionally activity type)
 * through `PATCH /api/v1/settings` (ADR-054/057), then invalidate the snapshot,
 * the Home Monotributo card, and the settings query so all consumers refetch the
 * real standing and the Settings page agrees. Returns the full mutation result
 * so the page can reflect `isPending` (disable the control) and surface a 422
 * inline (ADR-049/057). The mutation input keeps the legacy `currentCategory` /
 * `activityType` shape so the page's control is unchanged; it is mapped to the
 * settings payload here.
 */
export function useUpdateMonotributoCategory() {
  const queryClient = useQueryClient()
  return useMutation<
    Settings,
    Error,
    { currentCategory: string; activityType?: string }
  >({
    mutationFn: ({ currentCategory, activityType }) =>
      updateSettings({
        monotributoCurrentCategory: currentCategory,
        ...(activityType !== undefined
          ? { monotributoActivityType: activityType }
          : {}),
      }),
    onSuccess: (next) => {
      // Keep the settings cache in sync with the server's truth, then refetch
      // the dependent standing on Home + the Monotributo page.
      queryClient.setQueryData(settingsQueryKeys.detail(), next)
      void queryClient.invalidateQueries({
        queryKey: monotributoQueryKeys.all,
      })
      void queryClient.invalidateQueries({
        queryKey: homeQueryKeys.monotributo(),
      })
    },
  })
}
