import { useQuery } from '@tanstack/react-query'
import { fetchReadiness, type ReadinessResult } from './health'

/** Stable query key for the backend readiness check. */
export const readinessQueryKey = ['readiness'] as const

/** How often the indicator re-polls so the connection state stays live. */
const READINESS_REFETCH_INTERVAL_MS = 12_000

/**
 * Live backend connection state, backed by GET /readiness (ADR-006).
 *
 * Polls on an interval so the connection-status indicator reflects the current
 * reachability of the API + database without a manual refresh. Consumers map
 * the returned status flags onto connecting / connected / error UI states.
 */
export function useReadiness() {
  return useQuery<ReadinessResult>({
    queryKey: readinessQueryKey,
    queryFn: ({ signal }) => fetchReadiness(signal),
    refetchInterval: READINESS_REFETCH_INTERVAL_MS,
    // Keep the indicator polling even while the tab is backgrounded so it is
    // accurate the moment the user returns.
    refetchIntervalInBackground: true,
  })
}
