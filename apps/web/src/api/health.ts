import { config } from '../config'

/**
 * Backend readiness state, as surfaced by the API's GET /readiness endpoint.
 *
 * Per ADR-006, readiness confirms full-stack health (API process + database
 * reachable via SELECT 1), which is the truthful signal for a "connected"
 * indicator. The endpoint responds 200 with `{ "data": { "status": "Ready" } }`.
 */
export interface ReadinessResult {
  status: string
}

interface ReadinessResponse {
  data?: {
    status?: string
  }
}

/**
 * Fetch the backend readiness status.
 *
 * The base URL is read exclusively from {@link config.apiBaseUrl}
 * (`VITE_API_BASE_URL`, ADR-007) — never hardcoded. Throws on any non-2xx
 * response so TanStack Query treats it as an error (driving the "unreachable"
 * indicator state).
 */
export async function fetchReadiness(
  signal?: AbortSignal,
): Promise<ReadinessResult> {
  const response = await fetch(`${config.apiBaseUrl}/readiness`, { signal })

  if (!response.ok) {
    throw new Error(
      `Readiness check failed: ${response.status} ${response.statusText}`,
    )
  }

  const body = (await response.json()) as ReadinessResponse
  const status = body.data?.status

  if (!status) {
    throw new Error('Readiness response missing data.status')
  }

  return { status }
}
