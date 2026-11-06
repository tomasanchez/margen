/**
 * Unit tests for the pure cuota-schedule math (ADR-214/215/216).
 *
 * The preview must show EXACTLY the schedule the server stores: an even split
 * with the cents remainder on the last cuota, monthly due dates keeping the
 * first one's day clamped to each month's end. Also covers the per-cuota
 * override diffing (only changed fields are PATCHed), the plan-lock rule, and the
 * "N/M cuotas due" progress count.
 */

import { describe, expect, test } from 'vitest'
import {
  addMonthsClamped,
  applyOverrides,
  centsToDecimal,
  cuotaEditsFor,
  decimalToCents,
  dueCuotaCount,
  isIsoDate,
  isReceivableDate,
  planSchedule,
  scheduleLockReason,
  splitEvenlyCents,
  toCents,
  toInputAmount,
  todayIso,
} from './installments'
import { makeCuota, makeItem } from './__fixtures__/receivables'

describe('splitEvenlyCents (mirrors the backend split_evenly)', () => {
  test('puts the rounding remainder on the LAST cuota', () => {
    // 1000 / 3 → 333,33 · 333,33 · 333,34 (the ADR-216 example).
    expect(splitEvenlyCents(100_000, 3)).toEqual([33_333, 33_333, 33_334])
  })

  test('splits evenly when it divides exactly', () => {
    expect(splitEvenlyCents(6_000_000, 6)).toEqual(Array(6).fill(1_000_000))
  })

  test('always sums to the total', () => {
    const shares = splitEvenlyCents(1_234_567, 7)
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1_234_567)
    expect(shares.at(-1)).toBeGreaterThanOrEqual(shares[0])
  })
})

describe('addMonthsClamped (mirrors monthly_due_date)', () => {
  test('keeps the day of the month', () => {
    expect(addMonthsClamped('2026-08-15', 1)).toBe('2026-09-15')
  })

  test('rolls over the year', () => {
    expect(addMonthsClamped('2026-11-10', 2)).toBe('2027-01-10')
  })

  test('clamps to the month end without accumulating', () => {
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonthsClamped('2028-01-31', 1)).toBe('2028-02-29')
    // Derived from the ORIGINAL day: March is back on the 31st.
    expect(addMonthsClamped('2026-01-31', 2)).toBe('2026-03-31')
  })

  test('rejects an invalid date', () => {
    expect(addMonthsClamped('2026-02-30', 1)).toBeNull()
    expect(addMonthsClamped('', 1)).toBeNull()
  })
})

describe('planSchedule', () => {
  test('builds the even-split monthly schedule the server will store', () => {
    expect(planSchedule(100_000, 3, '2026-01-31')).toEqual([
      { index: 1, dueOn: '2026-01-31', amountCents: 33_333 },
      { index: 2, dueOn: '2026-02-28', amountCents: 33_333 },
      { index: 3, dueOn: '2026-03-31', amountCents: 33_334 },
    ])
  })

  test('is null for a plan the API rejects', () => {
    expect(planSchedule(100_000, 1, '2026-01-10')).toBeNull() // < 2 cuotas
    expect(planSchedule(100_000, 121, '2026-01-10')).toBeNull() // > 120
    expect(planSchedule(100_000, 2.5, '2026-01-10')).toBeNull() // not whole
    expect(planSchedule(1, 2, '2026-01-10')).toBeNull() // < 1 cent per cuota
    expect(planSchedule(100_000, 3, 'nope')).toBeNull() // bad first due date
    expect(planSchedule(100_000, 3, '1999-12-31')).toBeNull() // before 2000
    expect(planSchedule(100_000, 3, '2101-01-01')).toBeNull() // after 2100
  })
})

describe('cents helpers', () => {
  test('toCents uses the same 2-decimal string the forms send', () => {
    expect(toCents(1234.5)).toBe(123_450)
    expect(toCents(0.29)).toBe(29)
    expect(toCents(-15)).toBe(-1_500)
    expect(toCents(Number.NaN)).toBeNull()
  })

  test('centsToDecimal / decimalToCents round-trip a Decimal string', () => {
    expect(centsToDecimal(33_334)).toBe('333.34')
    expect(centsToDecimal(-150)).toBe('-1.50')
    expect(decimalToCents('10000.00')).toBe(1_000_000)
  })

  test('toInputAmount drops trailing zero cents for the inputs', () => {
    expect(toInputAmount('10000.00')).toBe('10000')
    expect(toInputAmount('333.30')).toBe('333.3')
    expect(toInputAmount('333.34')).toBe('333.34')
  })
})

describe('overrides → cuota edits (ADR-216)', () => {
  const base = planSchedule(300_000, 3, '2026-09-10') ?? []

  test('applyOverrides flags only the rows that actually differ', () => {
    const rows = applyOverrides(base, {
      2: { amountCents: 100_000, dueOn: '2026-10-10' }, // same as base
      3: { amountCents: 120_000, dueOn: '2026-11-10' }, // amount tweaked
    })
    expect(rows.map((row) => row.edited)).toEqual([false, false, true])
    expect(rows[2].amountCents).toBe(120_000)
  })

  test('cuotaEditsFor sends only the changed fields of each tweaked cuota', () => {
    expect(
      cuotaEditsFor(base, {
        1: { amountCents: 100_000, dueOn: '2026-09-15' },
        3: { amountCents: 120_000, dueOn: '2026-11-10' },
        9: { amountCents: 1 }, // past the plan's end → ignored
      }),
    ).toEqual([
      { index: 1, dueOn: '2026-09-15' },
      { index: 3, amount: '1200.00' },
    ])
  })
})

describe('scheduleLockReason (ADR-216)', () => {
  test('a clean item can change shape', () => {
    expect(
      scheduleLockReason(
        makeItem({ id: 'i', occurredOn: '2026-08-01', amount: '100.00' }),
      ),
    ).toBeNull()
  })

  test('payments lock the shape', () => {
    expect(
      scheduleLockReason(
        makeItem({
          id: 'i',
          occurredOn: '2026-08-01',
          amount: '100.00',
          allocated: '10.00',
        }),
      ),
    ).toBe('allocations')
  })

  test('a forgiven cuota locks the shape', () => {
    expect(
      scheduleLockReason(
        makeItem({
          id: 'i',
          occurredOn: '2026-08-01',
          amount: '200.00',
          installments: [
            makeCuota({ id: 'c1', index: 1, dueOn: '2026-09-01', amount: '100.00', status: 'pardoned' }),
            makeCuota({ id: 'c2', index: 2, dueOn: '2026-10-01', amount: '100.00', status: 'upcoming' }),
          ],
        }),
      ),
    ).toBe('pardons')
  })
})

describe('dueCuotaCount', () => {
  test('counts only cuotas the SERVER reports as due (never the local clock)', () => {
    const cuotas = [
      makeCuota({ id: 'c1', index: 1, dueOn: '2026-08-10', amount: '1.00', status: 'paid' }),
      makeCuota({ id: 'c2', index: 2, dueOn: '2026-09-10', amount: '1.00', status: 'due' }),
      makeCuota({ id: 'c3', index: 3, dueOn: '2026-10-10', amount: '1.00', status: 'pardoned' }),
      makeCuota({ id: 'c4', index: 4, dueOn: '2026-11-10', amount: '1.00', status: 'due' }),
      // Dated in the past by the browser's clock but still upcoming per the
      // server's "today" (e.g. across midnight UTC): not counted.
      makeCuota({ id: 'c5', index: 5, dueOn: '2000-01-01', amount: '1.00', status: 'upcoming' }),
    ]
    expect(dueCuotaCount(cuotas)).toBe(2)
  })
})

describe('dates', () => {
  test('todayIso uses LOCAL calendar parts', () => {
    expect(todayIso(new Date(2026, 10, 6, 23, 30))).toBe('2026-11-06')
  })

  test('isIsoDate accepts only real calendar dates', () => {
    expect(isIsoDate('2028-02-29')).toBe(true)
    expect(isIsoDate('2026-02-29')).toBe(false)
    expect(isIsoDate('06/11/2026')).toBe(false)
  })

  test('isReceivableDate also enforces the API range 2000-01-01..2100-12-31', () => {
    expect(isReceivableDate('2000-01-01')).toBe(true)
    expect(isReceivableDate('2100-12-31')).toBe(true)
    expect(isReceivableDate('1999-12-31')).toBe(false)
    expect(isReceivableDate('2101-01-01')).toBe(false)
  })
})
