/**
 * Unit tests for the client-driven FX snapshot fill engine (ADR-148/149/150).
 *
 * The historical-rate lookup + the snapshot PUT are mocked so no real network is
 * hit. Asserts the contract: rows already carrying a snapshot are skipped
 * (idempotent); each candidate's `occurred_on` historical rate is stamped via
 * PUT (resumable, one PUT per row); progress is reported after each row and a
 * final summary returned; a row whose rate can't be resolved or whose PUT fails
 * is counted as `failed` and skipped (never guessed); and an abort stops the run.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  countUnconverted,
  fillSnapshots,
  needsSnapshot,
} from './fillSnapshots'
import { fetchHistoricalRate } from '../../api/fxClient'
import { transactionsClient } from '../../api/transactionsClient'
import type { Transaction } from '../../mock/types'

vi.mock('../../api/fxClient', () => ({ fetchHistoricalRate: vi.fn() }))
vi.mock('../../api/transactionsClient', () => ({
  transactionsClient: { setFxSnapshot: vi.fn() },
}))

const mockRate = vi.mocked(fetchHistoricalRate)
const mockSnapshot = vi.mocked(transactionsClient.setFxSnapshot)

beforeEach(() => {
  mockRate.mockResolvedValue(1200)
  mockSnapshot.mockResolvedValue({} as Transaction)
})
afterEach(() => {
  vi.clearAllMocks()
})

/** A minimal transaction with an optional snapshot tag. */
function tx(id: string, occurredOn: string, fxSource?: string): Transaction {
  return {
    id,
    occurredOn,
    dispDate: 'Jan 01',
    month: 'January',
    name: id,
    category: 'Food',
    bank: 'Galicia',
    currency: 'ARS',
    type: 'expense',
    kind: 'expense',
    amountNum: 1000,
    ...(fxSource ? { fxSource } : {}),
  }
}

describe('needsSnapshot / countUnconverted', () => {
  test('a row with no fxSource needs a snapshot; one with a source does not', () => {
    expect(needsSnapshot(tx('a', '2025-01-01'))).toBe(true)
    expect(needsSnapshot(tx('b', '2025-01-01', 'bolsa'))).toBe(false)
    expect(needsSnapshot(tx('c', '2025-01-01', ''))).toBe(true)
  })

  test('counts only the rows lacking a snapshot', () => {
    expect(
      countUnconverted([
        tx('a', '2025-01-01'),
        tx('b', '2025-01-02', 'bolsa'),
        tx('c', '2025-01-03'),
      ]),
    ).toBe(2)
  })
})

describe('fillSnapshots', () => {
  test('stamps each unconverted row at its occurred_on rate and skips stamped rows', async () => {
    const rows = [
      tx('a', '2025-02-09'),
      tx('b', '2025-03-15', 'bolsa'), // already stamped — skipped
      tx('c', '2025-04-20'),
    ]
    const result = await fillSnapshots(rows, { casa: 'bolsa' })

    expect(result).toEqual({ total: 2, done: 2, failed: 0 })
    expect(mockSnapshot).toHaveBeenCalledTimes(2)
    expect(mockSnapshot).toHaveBeenCalledWith('a', {
      fxRate: '1200',
      fxSource: 'backfill',
    })
    // The historical lookup uses each row's own date.
    expect(mockRate).toHaveBeenCalledWith('bolsa', '2025-02-09', undefined)
    expect(mockRate).toHaveBeenCalledWith('bolsa', '2025-04-20', undefined)
    expect(mockRate).not.toHaveBeenCalledWith('bolsa', '2025-03-15', undefined)
  })

  test('reports progress after each row, including the initial 0 / total', async () => {
    const onProgress = vi.fn()
    await fillSnapshots([tx('a', '2025-01-01'), tx('b', '2025-01-02')], {
      casa: 'bolsa',
      onProgress,
    })
    const seen = onProgress.mock.calls.map((c) => c[0])
    expect(seen[0]).toEqual({ total: 2, done: 0, failed: 0 })
    expect(seen.at(-1)).toEqual({ total: 2, done: 2, failed: 0 })
  })

  test('counts a row as failed when its rate cannot be resolved (no guess)', async () => {
    mockRate.mockResolvedValueOnce(null)
    const result = await fillSnapshots(
      [tx('a', '2025-01-01'), tx('b', '2025-01-02')],
      { casa: 'bolsa' },
    )
    expect(result).toEqual({ total: 2, done: 1, failed: 1 })
    // The unresolved row was never PUT.
    expect(mockSnapshot).toHaveBeenCalledTimes(1)
  })

  test('counts a row as failed when its PUT throws, and continues', async () => {
    mockSnapshot.mockRejectedValueOnce(new Error('boom'))
    const result = await fillSnapshots(
      [tx('a', '2025-01-01'), tx('b', '2025-01-02')],
      { casa: 'bolsa' },
    )
    expect(result).toEqual({ total: 2, done: 1, failed: 1 })
  })

  test('uses the provided fxSource tag and casa', async () => {
    await fillSnapshots([tx('a', '2025-01-01')], {
      casa: 'oficial',
      fxSource: 'import',
    })
    expect(mockRate).toHaveBeenCalledWith('oficial', '2025-01-01', undefined)
    expect(mockSnapshot).toHaveBeenCalledWith('a', {
      fxRate: '1200',
      fxSource: 'import',
    })
  })

  test('stops early when the abort signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await fillSnapshots([tx('a', '2025-01-01')], {
      casa: 'bolsa',
      signal: controller.signal,
    })
    expect(result.done).toBe(0)
    expect(mockSnapshot).not.toHaveBeenCalled()
  })
})
