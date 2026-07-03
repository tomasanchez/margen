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

/** Overridable slice of a transaction the snapshot predicate reads. */
type TxOverrides = Partial<
  Pick<Transaction, 'fxSource' | 'type' | 'kind' | 'currency'>
>

/**
 * A minimal transaction. Defaults to an ARS EXPENSE (the genuine backfill target);
 * `overrides` shapes it into an ARS income, a reimbursement, a stamped row, etc.
 */
function tx(id: string, occurredOn: string, overrides: TxOverrides = {}): Transaction {
  const { fxSource, type = 'expense', kind = type, currency = 'ARS' } = overrides
  return {
    id,
    occurredOn,
    dispDate: 'Jan 01',
    month: 'January',
    name: id,
    category: 'Food',
    bank: 'Galicia',
    currency,
    type,
    kind,
    amountNum: 1000,
    ...(fxSource ? { fxSource } : {}),
  }
}

/** An ARS inflow that must stay dynamic/inherited (ADR-156/161). */
function arsIncome(id: string, occurredOn: string): Transaction {
  return tx(id, occurredOn, { type: 'income', kind: 'income', currency: 'ARS' })
}

/** A reimbursement: serializes as `type: 'income'`, ARS, no snapshot (ADR-161). */
function reimbursement(id: string, occurredOn: string): Transaction {
  return tx(id, occurredOn, {
    type: 'income',
    kind: 'reimbursement',
    currency: 'ARS',
  })
}

describe('needsSnapshot / countUnconverted', () => {
  test('an ARS expense with no fxSource is a candidate; one with a source is not', () => {
    expect(needsSnapshot(tx('a', '2025-01-01'))).toBe(true)
    expect(needsSnapshot(tx('b', '2025-01-01', { fxSource: 'bolsa' }))).toBe(false)
    expect(needsSnapshot(tx('c', '2025-01-01', { fxSource: '' }))).toBe(true)
  })

  test('an ARS income is never a candidate — it converts dynamically (ADR-156)', () => {
    expect(needsSnapshot(arsIncome('inc', '2025-01-01'))).toBe(false)
  })

  test('a reimbursement (ARS, type income) is never a candidate — it inherits the linked expense rate (ADR-161)', () => {
    expect(needsSnapshot(reimbursement('reimb', '2025-01-01'))).toBe(false)
  })

  test('an already-stamped ARS income stays a non-candidate (idempotent, unchanged)', () => {
    const stamped = tx('inc', '2025-01-01', {
      type: 'income',
      kind: 'income',
      currency: 'ARS',
      fxSource: 'bolsa',
    })
    expect(needsSnapshot(stamped)).toBe(false)
  })

  test('counts only the backfillable expenses, excluding ARS inflows', () => {
    expect(
      countUnconverted([
        tx('a', '2025-01-01'), // ARS expense, no snapshot → candidate
        tx('b', '2025-01-02', { fxSource: 'bolsa' }), // stamped → skip
        tx('c', '2025-01-03'), // ARS expense, no snapshot → candidate
        arsIncome('inc', '2025-01-04'), // ARS income → skip (ADR-156)
        reimbursement('reimb', '2025-01-05'), // reimbursement → skip (ADR-161)
      ]),
    ).toBe(2)
  })
})

describe('fillSnapshots', () => {
  test('stamps each unconverted row at its occurred_on rate and skips stamped rows', async () => {
    const rows = [
      tx('a', '2025-02-09'),
      tx('b', '2025-03-15', { fxSource: 'bolsa' }), // already stamped — skipped
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

  test('skips ARS income + reimbursements, stamping only the backfillable expenses', async () => {
    const rows = [
      tx('exp', '2025-02-09'), // ARS expense → stamped
      arsIncome('inc', '2025-03-10'), // ARS income → skipped (ADR-156)
      reimbursement('reimb', '2025-03-11'), // reimbursement → skipped (ADR-161)
    ]
    const result = await fillSnapshots(rows, { casa: 'bolsa' })

    expect(result).toEqual({ total: 1, done: 1, failed: 0 })
    expect(mockSnapshot).toHaveBeenCalledTimes(1)
    expect(mockSnapshot).toHaveBeenCalledWith('exp', {
      fxRate: '1200',
      fxSource: 'backfill',
    })
    // The ARS inflows are never priced nor PUT.
    expect(mockRate).not.toHaveBeenCalledWith('bolsa', '2025-03-10', undefined)
    expect(mockRate).not.toHaveBeenCalledWith('bolsa', '2025-03-11', undefined)
    expect(mockSnapshot).not.toHaveBeenCalledWith('inc', expect.anything())
    expect(mockSnapshot).not.toHaveBeenCalledWith('reimb', expect.anything())
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
