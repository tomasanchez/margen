/**
 * Unit tests for the per-currency payment plan (ADR-188/189).
 *
 * The plan is evaluated PER CURRENCY in native units and never sums or converts
 * across ARS + USD (ADR-133/188). These cover the pure planner:
 *   - sufficient (main account covers the need → no transfers);
 *   - shortfall with a greedy exact-to-zero suggestion across multiple sources;
 *   - a residual gap when the combined balances can't reach zero;
 *   - per-currency isolation (an ARS shortfall + a USD surplus never mix);
 *   - card-type accounts are excluded from AVAILABLE + the transfer sources;
 *   - the main-account selection is honored (else the largest-balance default);
 *   - the pending-due date helper (today ≤ due ⇒ pending, else null).
 * English-pinned (ADR-105); no i18n / React here.
 */

import { describe, expect, test } from 'vitest'
import {
  computePaymentPlan,
  isPlanSchedulable,
  pendingDueDate,
  scheduleOccurredOn,
  type FundingAccount,
  type PlanLine,
} from './paymentPlan'

/** A minimal funding account. */
function acct(overrides: Partial<FundingAccount>): FundingAccount {
  return {
    id: 'a-1',
    institutionName: 'Galicia',
    type: 'bank',
    currency: 'ARS',
    balance: 0,
    ...overrides,
  }
}

/** An ARS line contributing `amount`; a USD line contributing `usdAmount`. */
function arsLine(amount: number): PlanLine {
  return { currency: 'ARS', amount }
}
function usdLine(usdAmount: number): PlanLine {
  return { currency: 'USD', amount: 0, usdAmount }
}

describe('computePaymentPlan — sufficiency (ADR-188)', () => {
  test('main account alone covers the need → sufficient, no transfers', () => {
    const plan = computePaymentPlan(
      [arsLine(50_000), arsLine(30_000)],
      [acct({ id: 'gal', institutionName: 'Galicia', balance: 100_000 })],
    )
    const ars = plan.currencies.find((c) => c.currency === 'ARS')
    expect(ars).toBeDefined()
    expect(ars?.need).toBe(80_000)
    expect(ars?.available).toBe(100_000)
    expect(ars?.main?.id).toBe('gal')
    expect(ars?.sufficient).toBe(true)
    expect(ars?.transfers).toEqual([])
    expect(ars?.residualGap).toBe(0)
  })

  test('need exactly equal to the main balance is sufficient (≥)', () => {
    const plan = computePaymentPlan(
      [arsLine(100_000)],
      [acct({ id: 'gal', balance: 100_000 })],
    )
    expect(plan.currencies[0]?.sufficient).toBe(true)
  })
})

describe('computePaymentPlan — greedy exact-to-zero (ADR-189)', () => {
  test('tops the main up from other accounts, largest first, min(remaining, balance)', () => {
    // Need 6,000 USD. Main (Galicia) has 10 → shortfall 5,990. Sources DESC:
    // Deel 4,000 (pull 4,000), Payoneer 3,000 (pull 1,990 to zero the shortfall).
    const plan = computePaymentPlan(
      [usdLine(6_000)],
      [
        acct({ id: 'gal', institutionName: 'Galicia', currency: 'USD', balance: 10 }),
        acct({ id: 'deel', institutionName: 'Deel', currency: 'USD', balance: 4_000 }),
        acct({ id: 'payo', institutionName: 'Payoneer', currency: 'USD', balance: 3_000 }),
      ],
      { USD: 'gal' },
    )
    const usd = plan.currencies.find((c) => c.currency === 'USD')
    expect(usd?.need).toBe(6_000)
    expect(usd?.main?.id).toBe('gal')
    expect(usd?.sufficient).toBe(false)
    expect(usd?.transfers).toEqual([
      { from: expect.objectContaining({ id: 'deel' }), amount: 4_000 },
      { from: expect.objectContaining({ id: 'payo' }), amount: 1_990 },
    ])
    expect(usd?.residualGap).toBe(0)
    // The sum of the main balance + the pulled legs exactly meets the need.
    const pulled = (usd?.transfers ?? []).reduce((s, l) => s + l.amount, 0)
    expect((usd?.main?.balance ?? 0) + pulled).toBe(usd?.need)
  })

  test('a source is never over-drawn (pulls only its balance)', () => {
    const plan = computePaymentPlan(
      [arsLine(10_000)],
      [
        acct({ id: 'main', balance: 1_000 }),
        acct({ id: 'small', institutionName: 'Cash', balance: 2_000 }),
        acct({ id: 'big', institutionName: 'Brubank', balance: 50_000 }),
      ],
      { ARS: 'main' },
    )
    const ars = plan.currencies[0]
    // Shortfall 9,000; big (50,000) covers it entirely → single leg of 9,000.
    expect(ars?.transfers).toEqual([
      { from: expect.objectContaining({ id: 'big' }), amount: 9_000 },
    ])
    expect(ars?.residualGap).toBe(0)
  })
})

describe('computePaymentPlan — residual gap (ADR-189)', () => {
  test('reports the residual when all accounts combined fall short', () => {
    const plan = computePaymentPlan(
      [arsLine(100_000)],
      [
        acct({ id: 'main', balance: 30_000 }),
        acct({ id: 'other', institutionName: 'Cash', balance: 20_000 }),
      ],
      { ARS: 'main' },
    )
    const ars = plan.currencies[0]
    expect(ars?.sufficient).toBe(false)
    // Pulls the other's full 20,000; still 50,000 short (100k − 30k − 20k).
    expect(ars?.transfers).toEqual([
      { from: expect.objectContaining({ id: 'other' }), amount: 20_000 },
    ])
    expect(ars?.residualGap).toBe(50_000)
  })

  test('no same-currency account at all → whole need is the residual gap', () => {
    const plan = computePaymentPlan(
      [usdLine(500)],
      [acct({ id: 'ars-only', currency: 'ARS', balance: 999_999 })],
    )
    const usd = plan.currencies[0]
    expect(usd?.main).toBeNull()
    expect(usd?.available).toBe(0)
    expect(usd?.residualGap).toBe(500)
    expect(usd?.transfers).toEqual([])
  })
})

describe('computePaymentPlan — per-currency isolation (ADR-133/188)', () => {
  test('an ARS shortfall is not covered by a USD surplus', () => {
    const plan = computePaymentPlan(
      [arsLine(100_000), usdLine(100)],
      [
        acct({ id: 'ars', currency: 'ARS', balance: 40_000 }),
        acct({ id: 'usd', currency: 'USD', institutionName: 'Deel', balance: 5_000 }),
      ],
    )
    const ars = plan.currencies.find((c) => c.currency === 'ARS')
    const usd = plan.currencies.find((c) => c.currency === 'USD')
    // ARS is short (40k < 100k) with no other ARS account → residual 60k.
    expect(ars?.sufficient).toBe(false)
    expect(ars?.available).toBe(40_000)
    expect(ars?.residualGap).toBe(60_000)
    // USD is amply sufficient and is evaluated independently.
    expect(usd?.sufficient).toBe(true)
    expect(usd?.available).toBe(5_000)
    // Currencies are ordered ARS before USD.
    expect(plan.currencies.map((c) => c.currency)).toEqual(['ARS', 'USD'])
  })

  test('USD need uses usdAmount, not the ARS amount field', () => {
    // A USD line carries a large ARS `amount` (its pesos face value) but the NEED
    // must use its native usdAmount only (ADR-188).
    const plan = computePaymentPlan(
      [{ currency: 'USD', amount: 1_500_000, usdAmount: 1_000 }],
      [acct({ id: 'usd', currency: 'USD', balance: 2_000 })],
    )
    expect(plan.currencies[0]?.need).toBe(1_000)
    expect(plan.currencies[0]?.sufficient).toBe(true)
  })
})

describe('computePaymentPlan — card accounts excluded (ADR-184/188)', () => {
  test('card-type accounts count toward neither AVAILABLE nor the transfer sources', () => {
    const plan = computePaymentPlan(
      [arsLine(80_000)],
      [
        acct({ id: 'bank', institutionName: 'Galicia', type: 'bank', balance: 50_000 }),
        // A card account of the same currency must be ignored entirely.
        acct({ id: 'card', institutionName: 'Galicia', type: 'card', balance: 999_999 }),
        acct({ id: 'cash', institutionName: 'Cash', type: 'cash', balance: 20_000 }),
      ],
      { ARS: 'bank' },
    )
    const ars = plan.currencies[0]
    // AVAILABLE = bank + cash only (card excluded).
    expect(ars?.available).toBe(70_000)
    // Shortfall 30,000 from cash only; still 10,000 short (card never used).
    expect(ars?.transfers).toEqual([
      { from: expect.objectContaining({ id: 'cash' }), amount: 20_000 },
    ])
    expect(ars?.residualGap).toBe(10_000)
  })
})

describe('computePaymentPlan — main-account selection (ADR-189)', () => {
  test('defaults to the largest-balance eligible account', () => {
    const plan = computePaymentPlan(
      [arsLine(1_000)],
      [
        acct({ id: 'small', institutionName: 'Cash', balance: 100 }),
        acct({ id: 'big', institutionName: 'Brubank', balance: 5_000 }),
      ],
    )
    expect(plan.currencies[0]?.main?.id).toBe('big')
    expect(plan.currencies[0]?.sufficient).toBe(true)
  })

  test('honors the user selection and ignores an ineligible/unknown id', () => {
    const accounts = [
      acct({ id: 'a', institutionName: 'A', balance: 5_000 }),
      acct({ id: 'b', institutionName: 'B', balance: 3_000 }),
    ]
    expect(
      computePaymentPlan([arsLine(1)], accounts, { ARS: 'b' }).currencies[0]?.main
        ?.id,
    ).toBe('b')
    // An unknown id falls back to the largest-balance default.
    expect(
      computePaymentPlan([arsLine(1)], accounts, { ARS: 'ghost' }).currencies[0]
        ?.main?.id,
    ).toBe('a')
  })
})

describe('computePaymentPlan — empty', () => {
  test('no kept lines → no currency plans', () => {
    expect(computePaymentPlan([], [acct({})]).currencies).toEqual([])
  })
})

describe('pendingDueDate (ADR-188)', () => {
  const today = new Date('2026-07-06T12:00:00')

  test('due date in the future is pending (returns the due date)', () => {
    expect(pendingDueDate('2026-07-20', undefined, today)).toBe('2026-07-20')
  })

  test('due date today is still pending (today ≤ due)', () => {
    expect(pendingDueDate('2026-07-06', undefined, today)).toBe('2026-07-06')
  })

  test('past due date is not pending (null)', () => {
    expect(pendingDueDate('2026-06-30', undefined, today)).toBeNull()
  })

  test('falls back to periodClose when no due date', () => {
    expect(pendingDueDate(undefined, '2026-07-15', today)).toBe('2026-07-15')
  })

  test('null when neither date is present or the format is bad', () => {
    expect(pendingDueDate(undefined, undefined, today)).toBeNull()
    expect(pendingDueDate('not-a-date', undefined, today)).toBeNull()
  })
})

describe('scheduleOccurredOn (ADR-191)', () => {
  const today = new Date('2026-07-06T12:00:00')

  test('future due date → the transfer is dated on the due date (pending until then)', () => {
    expect(scheduleOccurredOn('2026-07-20', undefined, today)).toBe('2026-07-20')
  })

  test('on the due date → dated today (nothing to defer)', () => {
    expect(scheduleOccurredOn('2026-07-06', undefined, today)).toBe('2026-07-06')
  })

  test('past due date → dated today (move the funds now)', () => {
    expect(scheduleOccurredOn('2026-06-30', undefined, today)).toBe('2026-07-06')
  })

  test('falls back to periodClose when no due date', () => {
    expect(scheduleOccurredOn(undefined, '2026-07-15', today)).toBe('2026-07-15')
  })

  test('no parseable date → dated today', () => {
    expect(scheduleOccurredOn(undefined, undefined, today)).toBe('2026-07-06')
    expect(scheduleOccurredOn('not-a-date', undefined, today)).toBe('2026-07-06')
  })
})

describe('isPlanSchedulable (ADR-191)', () => {
  test('true when a shortfall is fully covered by suggested legs (no residual gap)', () => {
    const plan = computePaymentPlan(
      [usdLine(6_000)],
      [
        acct({ id: 'gal', institutionName: 'Galicia', currency: 'USD', balance: 4_000 }),
        acct({ id: 'deel', institutionName: 'Deel', currency: 'USD', balance: 3_000 }),
      ],
    )
    expect(isPlanSchedulable(plan)).toBe(true)
  })

  test('false when a currency still has a residual gap (suggest-only)', () => {
    const plan = computePaymentPlan(
      [usdLine(10_000)],
      [
        acct({ id: 'gal', institutionName: 'Galicia', currency: 'USD', balance: 4_000 }),
        acct({ id: 'deel', institutionName: 'Deel', currency: 'USD', balance: 3_000 }),
      ],
    )
    expect(plan.currencies[0]?.residualGap).toBeGreaterThan(0)
    expect(isPlanSchedulable(plan)).toBe(false)
  })

  test('false when every currency is already sufficient (nothing to schedule)', () => {
    const plan = computePaymentPlan(
      [arsLine(50_000)],
      [acct({ id: 'gal', institutionName: 'Galicia', balance: 100_000 })],
    )
    expect(isPlanSchedulable(plan)).toBe(false)
  })

  test('false when ANY currency has a residual gap even if another is coverable', () => {
    const plan = computePaymentPlan(
      [arsLine(80_000), usdLine(10_000)],
      [
        // ARS: 100k covers 80k (sufficient).
        acct({ id: 'ars', institutionName: 'Galicia', currency: 'ARS', balance: 100_000 }),
        // USD: only 3k against a 10k need → residual gap.
        acct({ id: 'usd', institutionName: 'Deel', currency: 'USD', balance: 3_000 }),
      ],
    )
    expect(isPlanSchedulable(plan)).toBe(false)
  })
})
