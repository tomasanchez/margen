/**
 * In-memory mock async API for the still-mocked Margen slices (ADR-015, ADR-035).
 *
 * Transactions now read/write through the real backend client
 * (`src/api/transactionsClient.ts`); the in-memory transactions store and its
 * seed were removed in #14 (ADR-035). What remains here is the read-only seed
 * for the slices that have no backend yet — the spending trend, the category
 * breakdown, the Home insights, and ALL Monotributo data — kept behind these
 * async getters so #6/#8/#10 can swap each to a real client without touching the
 * components. Every function is async and returns a structural copy after a small
 * simulated latency, exactly as the eventual clients will.
 */

import {
  SEED_CATEGORY_BREAKDOWN,
  SEED_INSIGHTS,
  SEED_MONOTRIBUTO,
  SEED_MONOTRIBUTO_INVOICES,
  SEED_MONOTRIBUTO_PROJECTION,
  SEED_MONOTRIBUTO_SCALE,
  SEED_TREND,
} from './seed'
import type {
  CategorySpend,
  Insight,
  MonotributoInvoice,
  MonotributoProjection,
  MonotributoScaleRow,
  MonotributoState,
  TrendPoint,
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

/** 6-month spending trend (read-only seed snapshot). */
export function getTrend(): Promise<TrendPoint[]> {
  return withLatency(SEED_TREND.map((p) => ({ ...p })))
}

/** Category breakdown for the current month (read-only seed snapshot). */
export function getCategoryBreakdown(): Promise<CategorySpend[]> {
  return withLatency(SEED_CATEGORY_BREAKDOWN.map((c) => ({ ...c })))
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
  getTrend,
  getCategoryBreakdown,
  getInsights,
} as const
