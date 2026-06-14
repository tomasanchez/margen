/**
 * In-memory mock async API for the still-mocked Margen slices (ADR-015, ADR-035).
 *
 * Transactions read/write through the real backend client
 * (`src/api/transactionsClient.ts`); the spending trend + category breakdown now
 * read the real `/summaries` endpoint via `src/api/summariesClient.ts`
 * (ADR-042/043). What remains here is the read-only seed for the slices that
 * still have no backend yet — the Home insights and ALL Monotributo data — kept
 * behind these async getters so #8/#10 can swap each to a real client without
 * touching the components. Every function is async and returns a structural copy
 * after a small simulated latency, exactly as the eventual clients will.
 */

import {
  SEED_INSIGHTS,
  SEED_MONOTRIBUTO,
  SEED_MONOTRIBUTO_INVOICES,
  SEED_MONOTRIBUTO_PROJECTION,
  SEED_MONOTRIBUTO_SCALE,
} from './seed'
import type {
  Insight,
  MonotributoInvoice,
  MonotributoProjection,
  MonotributoScaleRow,
  MonotributoState,
} from './types'

/** Simulated network latency (ms) so loading states are exercised. */
const LATENCY_MS = 240

/** Resolve `value` after the simulated latency, returning a structural copy. */
function withLatency<T>(value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), LATENCY_MS)
  })
}

/** Current Monotributo standing (read-only seed snapshot). */
export function getMonotributo(): Promise<MonotributoState> {
  return withLatency({ ...SEED_MONOTRIBUTO })
}

/** Official AFIP/ARCA 2026 category scale A–K (read-only reference data). */
export function getMonotributoScale(): Promise<MonotributoScaleRow[]> {
  return withLatency(SEED_MONOTRIBUTO_SCALE.map((r) => ({ ...r })))
}

/** Fiscal-period invoices behind the annual total (read-only seed snapshot). */
export function getMonotributoInvoices(): Promise<MonotributoInvoice[]> {
  return withLatency(SEED_MONOTRIBUTO_INVOICES.map((i) => ({ ...i })))
}

/** Linear pace projection figures (read-only seed snapshot). */
export function getMonotributoProjection(): Promise<MonotributoProjection> {
  return withLatency({ ...SEED_MONOTRIBUTO_PROJECTION })
}

/** Home insights list (read-only seed snapshot). */
export function getInsights(): Promise<Insight[]> {
  return withLatency(SEED_INSIGHTS.map((i) => ({ ...i })))
}

/** Grouped export so callers can import the still-mocked API as one object. */
export const mockApi = {
  getMonotributo,
  getMonotributoScale,
  getMonotributoInvoices,
  getMonotributoProjection,
  getInsights,
} as const
