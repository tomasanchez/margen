/**
 * In-memory mock async API for the still-mocked Margen slices (ADR-015, ADR-035).
 *
 * Transactions read/write through the real backend client
 * (`src/api/transactionsClient.ts`); the spending trend + category breakdown read
 * the real `/summaries` endpoint via `src/api/summariesClient.ts`
 * (ADR-042/043); and ALL Monotributo data now reads the real `/monotributo`
 * endpoint via `src/api/monotributoClient.ts` (ADR-049/052). What remains here is
 * the read-only seed for the one slice that still has no backend yet — the Home
 * insights — kept behind this async getter so #10 can swap it to a real client
 * without touching the component. The function is async and returns a structural
 * copy after a small simulated latency, exactly as the eventual client will.
 */

import { SEED_INSIGHTS } from './seed'
import type { Insight } from './types'

/** Simulated network latency (ms) so loading states are exercised. */
const LATENCY_MS = 240

/** Resolve `value` after the simulated latency, returning a structural copy. */
function withLatency<T>(value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), LATENCY_MS)
  })
}

/** Home insights list (read-only seed snapshot). */
export function getInsights(): Promise<Insight[]> {
  return withLatency(SEED_INSIGHTS.map((i) => ({ ...i })))
}

/** Grouped export so callers can import the still-mocked API as one object. */
export const mockApi = {
  getInsights,
} as const
