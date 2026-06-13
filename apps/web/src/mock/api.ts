/**
 * In-memory mock async API for the Margen prototype (ADR-015).
 *
 * This module mirrors the eventual backend contract: every function is async
 * and returns Promises after a small simulated latency, so the TanStack Query
 * hooks behave exactly as they will against a real API. Swapping this module
 * for a real client later is the only change required.
 *
 * State is IN-MEMORY ONLY — a single mutable copy of the seed, seeded once per
 * page load. There is NO localStorage; reloading resets to the seed. Home and
 * Transactions both read from this same `transactions` store.
 */

import {
  SEED_CATEGORY_BREAKDOWN,
  SEED_INSIGHTS,
  SEED_MONOTRIBUTO,
  SEED_MONOTRIBUTO_INVOICES,
  SEED_MONOTRIBUTO_PROJECTION,
  SEED_MONOTRIBUTO_SCALE,
  SEED_TRANSACTIONS,
  SEED_TREND,
} from './seed'
import type {
  CategorySpend,
  Insight,
  MonotributoInvoice,
  MonotributoProjection,
  MonotributoScaleRow,
  MonotributoState,
  NewTransactionInput,
  Transaction,
  TransactionPatch,
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

/**
 * The single mutable transactions store. Seeded once from SEED_TRANSACTIONS via
 * a shallow copy of each row (the seed itself stays immutable).
 */
let transactions: Transaction[] = SEED_TRANSACTIONS.map((t) => ({ ...t }))

/**
 * Monotonically increasing id counter. Starts above the highest seeded id so new
 * transactions never collide with seeded ones — no Math.random / Date.now needed.
 */
let nextId = transactions.reduce((max, t) => Math.max(max, t.id), 0) + 1

/**
 * TEST-ONLY: re-seed the in-memory store to its initial state.
 *
 * The store is a module singleton seeded once per load and mutated by
 * add/delete/update; that is correct runtime behavior (reload resets it), but it
 * lets mutation-based tests leak into each other. Tests call this in a
 * `beforeEach` to restore isolation. It does NOT change runtime behavior — no
 * production code path invokes it.
 */
export function __resetMockStore(): void {
  transactions = SEED_TRANSACTIONS.map((t) => ({ ...t }))
  nextId = transactions.reduce((max, t) => Math.max(max, t.id), 0) + 1
}

/** Return a defensive copy of the transactions store (newest seeded order). */
export function listTransactions(): Promise<Transaction[]> {
  return withLatency(transactions.map((t) => ({ ...t })))
}

/**
 * Append a new transaction to the store and return the created row.
 * Defaults `month` to the current prototype month (June) when not supplied.
 */
export function addTransaction(
  input: NewTransactionInput,
): Promise<Transaction> {
  const created: Transaction = {
    id: nextId++,
    month: input.month ?? 'June',
    dispDate: input.dispDate,
    name: input.name,
    category: input.category,
    bank: input.bank,
    currency: input.currency,
    type: input.type,
    kind: input.kind,
    amountNum: input.amountNum,
    ...(input.usd !== undefined ? { usd: input.usd } : {}),
    ...(input.rate !== undefined ? { rate: input.rate } : {}),
    ...(input.recurring !== undefined ? { recurring: input.recurring } : {}),
  }
  transactions.unshift(created)
  return withLatency({ ...created })
}

/**
 * Apply a partial patch to the transaction with `id`. Resolves to the updated
 * row, or rejects if no such transaction exists.
 */
export function updateTransaction(
  id: number,
  patch: TransactionPatch,
): Promise<Transaction> {
  const index = transactions.findIndex((t) => t.id === id)
  if (index === -1) {
    return Promise.reject(new Error(`Transaction ${id} not found`))
  }
  const updated: Transaction = { ...transactions[index], ...patch, id }
  transactions[index] = updated
  return withLatency({ ...updated })
}

/**
 * Remove the transaction with `id`. Resolves to the deleted id, or rejects if
 * no such transaction exists.
 */
export function deleteTransaction(id: number): Promise<number> {
  const index = transactions.findIndex((t) => t.id === id)
  if (index === -1) {
    return Promise.reject(new Error(`Transaction ${id} not found`))
  }
  transactions.splice(index, 1)
  return withLatency(id)
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

/** Grouped export so callers can import the API as one object if preferred. */
export const mockApi = {
  listTransactions,
  addTransaction,
  updateTransaction,
  deleteTransaction,
  getMonotributo,
  getMonotributoScale,
  getMonotributoInvoices,
  getMonotributoProjection,
  getTrend,
  getCategoryBreakdown,
  getInsights,
} as const
