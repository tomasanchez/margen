/**
 * TanStack Query hooks for the Settings feature (ADR-054, ADR-057).
 *
 * One query owns the `GET /api/v1/settings` row via {@link fetchSettings}; a
 * mutation applies a partial `PATCH /api/v1/settings` via {@link updateSettings}
 * and, on success, invalidates the dependent screens so they react immediately:
 * the Home cards + summaries (display currency, ADR-056), and the Monotributo
 * snapshot + Home Monotributo card (the configured category, ADR-054/057). The
 * settings query itself is also invalidated so the controls reflect the saved
 * value.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  fetchSettings,
  updateSettings,
  type Settings,
  type SettingsPatch,
} from '../../api/settingsClient'
import { homeQueryKeys } from '../home/queries'
import { monotributoQueryKeys } from '../monotributo/queries'

/** Stable query-key factory for the Settings domain. */
export const settingsQueryKeys = {
  all: ['settings'] as const,
  detail: () => [...settingsQueryKeys.all] as const,
}

/**
 * The app settings (preferred display currency, FX default, Monotributo
 * category + activity type). Long-lived data, so a generous stale window keeps
 * it from refetching on every screen that reads it (Home, Add/Edit, Settings,
 * Monotributo).
 */
export function useSettings() {
  return useQuery<Settings>({
    queryKey: settingsQueryKeys.detail(),
    queryFn: () => fetchSettings(),
    staleTime: 5 * 60 * 1000,
  })
}

/**
 * Read whether the optional Monotributo module is enabled for the current user
 * (ADR-126). Mirrors the display-currency provider's read pattern (ADR-056): a
 * thin selector over the single {@link useSettings} query so every gate (nav
 * item, Home card, route) reads ONE source of truth.
 *
 * To avoid a flash-then-hide flicker, the flag is treated as DISABLED until
 * settings have resolved: `enabled` is only `true` once the query has loaded a
 * row with `monotributoEnabled === true`. `settled` tells callers whether the
 * settings query has produced a value yet (loaded or errored), so a route guard
 * can wait for a definitive answer before deciding to block — while nav/cards
 * simply treat "not yet settled" as hidden.
 */
export function useMonotributoEnabled(): {
  enabled: boolean
  settled: boolean
} {
  const settingsQuery = useSettings()
  // Settled once the query is no longer pending (success or error). On error we
  // fall back to hidden — a calm degradation that never flashes the module.
  const settled = !settingsQuery.isPending
  const enabled = settingsQuery.data?.monotributoEnabled === true
  return { enabled, settled }
}

/**
 * Apply a partial settings update, then invalidate every dependent query so the
 * dependent screens reflect the change at once: the settings query itself, the
 * Home domain (cards + summaries currency, ADR-056), and the Monotributo domain
 * (the configured category, ADR-054/057). Returns the full mutation result so
 * callers can reflect `isPending` (a saving state) and surface a 422 inline
 * (ADR-057).
 */
export function useUpdateSettings() {
  const queryClient = useQueryClient()
  return useMutation<Settings, Error, SettingsPatch>({
    mutationFn: (patch) => updateSettings(patch),
    onSuccess: (next) => {
      // Seed the cache with the server's truth so reads are immediate, then
      // invalidate the dependents that derive behavior from settings.
      queryClient.setQueryData(settingsQueryKeys.detail(), next)
      void queryClient.invalidateQueries({ queryKey: homeQueryKeys.all })
      void queryClient.invalidateQueries({
        queryKey: monotributoQueryKeys.all,
      })
      void queryClient.invalidateQueries({
        queryKey: homeQueryKeys.monotributo(),
      })
    },
  })
}
