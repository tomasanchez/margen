/**
 * Unit tests for the per-transaction FX-snapshot capture on create
 * (ADR-148/149/151).
 *
 * `fetchCurrentRate` is mocked so no real network is hit. Asserts the contract:
 *
 *  - USD rows reuse their confirmed `rate` as the snapshot `fxRate` and tag
 *    `fxSource` from the chosen `fxRateType` — no fetch;
 *  - ARS rows fetch the day's current preferred-source rate and stamp
 *    `fxRate` + `fxSource` (the resolved `casa`);
 *  - a failed/absent current rate returns the input UNCHANGED (no snapshot —
 *    the row is backfilled later, never guessed, ADR-150);
 *  - an input already carrying `fxRate` is returned unchanged (idempotent).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { captureFxForCreate, captureFxForFee, casaForSource } from './captureFx'
import { fetchCurrentRate } from '../../api/fxClient'
import type { NewTransactionInput, TransferFeeInput } from '../../mock/types'

vi.mock('../../api/fxClient', () => ({ fetchCurrentRate: vi.fn() }))
const mockCurrent = vi.mocked(fetchCurrentRate)

beforeEach(() => {
  mockCurrent.mockResolvedValue(1245)
})
afterEach(() => {
  vi.clearAllMocks()
})

/** A minimal ARS expense input. */
function arsExpense(over: Partial<NewTransactionInput> = {}): NewTransactionInput {
  return {
    occurredOn: '2025-02-09',
    dispDate: 'Feb 09',
    name: 'Groceries',
    category: 'Food',
    currency: 'ARS',
    type: 'expense',
    kind: 'expense',
    amountNum: 56502,
    ...over,
  }
}

/** A minimal ARS income input (never FX-snapshotted, ADR-156). */
function arsIncome(over: Partial<NewTransactionInput> = {}): NewTransactionInput {
  return {
    occurredOn: '2025-02-09',
    dispDate: 'Feb 09',
    name: 'Salary',
    category: 'Income',
    currency: 'ARS',
    type: 'income',
    kind: 'income',
    amountNum: 900000,
    ...over,
  }
}

/** A minimal USD expense input carrying a confirmed rate (ADR-029). */
function usdExpense(over: Partial<NewTransactionInput> = {}): NewTransactionInput {
  return {
    occurredOn: '2025-02-09',
    dispDate: 'Feb 09',
    name: 'Server',
    category: 'Other',
    currency: 'USD',
    type: 'expense',
    kind: 'expense',
    amountNum: 622500,
    usd: 500,
    rate: 1245,
    fxRateType: 'MEP',
    ...over,
  }
}

describe('casaForSource', () => {
  test('maps oficial → oficial and everything else → bolsa', () => {
    expect(casaForSource('oficial')).toBe('oficial')
    expect(casaForSource('bolsa')).toBe('bolsa')
    expect(casaForSource(undefined)).toBe('bolsa')
  })
})

describe('captureFxForCreate — USD rows', () => {
  test('reuses the confirmed rate as fxRate and tags fxSource from MEP (no fetch)', async () => {
    const result = await captureFxForCreate(usdExpense(), 'bolsa')
    expect(result.fxRate).toBe('1245')
    expect(result.fxSource).toBe('bolsa')
    expect(mockCurrent).not.toHaveBeenCalled()
  })

  test('tags fxSource oficial for an official confirmation', async () => {
    const result = await captureFxForCreate(
      usdExpense({ rate: 1045, fxRateType: 'official' }),
      'bolsa',
    )
    expect(result.fxRate).toBe('1045')
    expect(result.fxSource).toBe('oficial')
  })

  test('tags fxSource manual for a hand-entered rate', async () => {
    const result = await captureFxForCreate(
      usdExpense({ rate: 1300, fxRateType: 'manual' }),
      'bolsa',
    )
    expect(result.fxRate).toBe('1300')
    expect(result.fxSource).toBe('manual')
  })

  test('honors an OVERRIDDEN rate as the snapshot, not the live source (#88)', async () => {
    // The user prefilled the current preferred-source rate then OVERRODE it for
    // this transaction (it cleared at a different rate). The chosen rate — carried
    // on `input.rate` with `fxRateType: 'manual'` — is authoritative: it becomes
    // the snapshot `fxRate`, and the live current-rate fetch is NEVER consulted
    // (ADR-149, capture stays client-side; #88 editable-rate override).
    const result = await captureFxForCreate(
      usdExpense({ rate: 1180.5, fxRateType: 'manual' }),
      'bolsa',
    )
    expect(result.fxRate).toBe('1180.5')
    expect(result.fxSource).toBe('manual')
    expect(mockCurrent).not.toHaveBeenCalled()
  })
})

describe('captureFxForCreate — ARS rows', () => {
  test('fetches the current preferred-source rate and stamps fxRate + fxSource', async () => {
    mockCurrent.mockResolvedValue(1250)
    const result = await captureFxForCreate(arsExpense(), 'bolsa')
    expect(mockCurrent).toHaveBeenCalledWith('bolsa', undefined)
    expect(result.fxRate).toBe('1250')
    expect(result.fxSource).toBe('bolsa')
  })

  test('uses the oficial casa when the preferred source is oficial', async () => {
    mockCurrent.mockResolvedValue(1050)
    const result = await captureFxForCreate(arsExpense(), 'oficial')
    expect(mockCurrent).toHaveBeenCalledWith('oficial', undefined)
    expect(result.fxSource).toBe('oficial')
  })

  test('returns the input UNCHANGED when the current rate is unavailable (no guess)', async () => {
    mockCurrent.mockResolvedValue(null)
    const input = arsExpense()
    const result = await captureFxForCreate(input, 'bolsa')
    expect(result.fxRate).toBeUndefined()
    expect(result.fxSource).toBeUndefined()
    expect(result).toEqual(input)
  })

  test('returns the input unchanged for a non-positive rate', async () => {
    mockCurrent.mockResolvedValue(0)
    const result = await captureFxForCreate(arsExpense(), 'bolsa')
    expect(result.fxRate).toBeUndefined()
  })
})

describe('captureFxForCreate — ARS income is never snapshotted (ADR-156)', () => {
  test('an ARS income create does NOT stamp fxRate/fxSource (usd stays null, no fetch)', async () => {
    const input = arsIncome()
    const result = await captureFxForCreate(input, 'bolsa', { cachedRate: 1233 })
    // No snapshot: the user doesn't convert those pesos to USD at receipt, so a
    // frozen usd_amount would be misleading — its USD-equivalent is computed
    // dynamically if ever shown, never stored. The input passes through unchanged.
    expect(result.fxRate).toBeUndefined()
    expect(result.fxSource).toBeUndefined()
    expect(result.usd).toBeUndefined()
    expect(result).toEqual(input)
    expect(mockCurrent).not.toHaveBeenCalled()
  })

  test('an ARS EXPENSE create still stamps its per-date snapshot (unchanged)', async () => {
    // The contrast case: ARS expense keeps its historical USD snapshot for
    // accurate historical spend.
    const result = await captureFxForCreate(arsExpense(), 'bolsa', {
      cachedRate: 1233,
    })
    expect(result.fxRate).toBe('1233')
    expect(result.fxSource).toBe('bolsa')
  })

  test('a USD income stays native (no fetch; the ARS-income skip does not apply)', async () => {
    // USD income carries its own amount as its USD value; the skip is ARS-only.
    const result = await captureFxForCreate(
      arsIncome({ currency: 'USD', rate: 1000, fxRateType: 'MEP' }),
      'bolsa',
    )
    expect(result.fxRate).toBe('1000')
    expect(result.fxSource).toBe('bolsa')
    expect(mockCurrent).not.toHaveBeenCalled()
  })
})

describe('captureFxForCreate — cached preferred rate (reliability fix)', () => {
  test('reuses a positive cached rate for the ARS snapshot WITHOUT a fresh fetch', async () => {
    // The app already keeps the preferred-source rate warm (usePreferredRate);
    // reusing it avoids depending on a fresh, possibly-not-landed submit-time
    // fetch — the earlier cause of ARS rows tagged with a source but no rate.
    const result = await captureFxForCreate(arsExpense(), 'bolsa', {
      cachedRate: 1233,
    })
    expect(result.fxRate).toBe('1233')
    expect(result.fxSource).toBe('bolsa')
    expect(mockCurrent).not.toHaveBeenCalled()
  })

  test('falls back to a fetch when the cached rate is null/non-positive', async () => {
    mockCurrent.mockResolvedValue(1240)
    const result = await captureFxForCreate(arsExpense(), 'bolsa', {
      cachedRate: null,
    })
    expect(mockCurrent).toHaveBeenCalledWith('bolsa', undefined)
    expect(result.fxRate).toBe('1240')
    expect(result.fxSource).toBe('bolsa')
  })
})

describe('captureFxForCreate — idempotency', () => {
  test('returns an already-stamped input unchanged (no second fetch)', async () => {
    const input = arsExpense({ fxRate: '1240', fxSource: 'backfill' })
    const result = await captureFxForCreate(input, 'bolsa')
    expect(result).toBe(input)
    expect(mockCurrent).not.toHaveBeenCalled()
  })
})

/** A minimal transfer fee line (raw, pre-snapshot). */
function fee(over: Partial<TransferFeeInput> = {}): TransferFeeInput {
  return { accountId: 'acc-1', amount: '15.00', label: 'Wire fee', ...over }
}

describe('captureFxForFee — transfer fees carry a snapshot like a normal expense', () => {
  test('an ARS fee captures the day rate + source (fixes the blank-USD fee bug)', async () => {
    // The bug: an ARS fee used to land with no rate/source, so its usd_amount was
    // blank. A fee is an EXPENSE, so it must capture the day's preferred rate.
    const result = await captureFxForFee(fee(), 'ARS', 'bolsa', {
      cachedRate: 1250,
    })
    expect(result.rate).toBe('1250')
    expect(result.fxSource).toBe('bolsa')
    expect(mockCurrent).not.toHaveBeenCalled()
  })

  test('an ARS fee falls back to a fetch when no cached rate is on hand', async () => {
    mockCurrent.mockResolvedValue(1240)
    const result = await captureFxForFee(fee(), 'ARS', 'bolsa')
    expect(mockCurrent).toHaveBeenCalledWith('bolsa', undefined)
    expect(result.rate).toBe('1240')
    expect(result.fxSource).toBe('bolsa')
  })

  test('uses the oficial casa when the preferred source is oficial', async () => {
    const result = await captureFxForFee(fee(), 'ARS', 'oficial', {
      cachedRate: 1050,
    })
    expect(result.rate).toBe('1050')
    expect(result.fxSource).toBe('oficial')
  })

  test('a USD fee stays NATIVE — no snapshot, no fetch (already USD)', async () => {
    const input = fee({ accountId: 'acc-usd', amount: '5.00', label: 'USD fee' })
    const result = await captureFxForFee(input, 'USD', 'bolsa', {
      cachedRate: 1250,
    })
    expect(result.rate).toBeUndefined()
    expect(result.fxSource).toBeUndefined()
    expect(result).toEqual(input)
    expect(mockCurrent).not.toHaveBeenCalled()
  })

  test('an unavailable rate leaves the ARS fee UNCHANGED (no guess, backfilled later)', async () => {
    mockCurrent.mockResolvedValue(null)
    const input = fee()
    const result = await captureFxForFee(input, 'ARS', 'bolsa')
    expect(result.rate).toBeUndefined()
    expect(result.fxSource).toBeUndefined()
    expect(result).toEqual(input)
  })

  test('an already-snapshotted fee is returned unchanged (idempotent, no fetch)', async () => {
    const input = fee({ rate: '1200', fxSource: 'manual' })
    const result = await captureFxForFee(input, 'ARS', 'bolsa', {
      cachedRate: 1250,
    })
    expect(result).toBe(input)
    expect(mockCurrent).not.toHaveBeenCalled()
  })
})
