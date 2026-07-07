/**
 * Unit tests for the commitment-aware available balance primitive (ADR-193).
 *
 * The primitive layers PENDING (future-dated, ADR-191) own-account transfer legs
 * on top of each account's as-of-today native balance (ADR-186), never crossing
 * currencies (ADR-133). These cover:
 *   - `pendingOut` subtracts (a future-dated outflow from the account);
 *   - `pendingIn` accumulates (multiple future-dated inflows into the account);
 *   - per-currency isolation (an ARS leg never touches a USD account, and each
 *     figure stays native);
 *   - future-vs-past dating (only `occurredOn > today` counts; today / past / the
 *     due date itself never pends);
 *   - no matching transfers → balance unchanged, pending 0;
 *   - the derived `spendableNow` (balance − pendingOut, inflow NOT added) and
 *     `projectedBalance` (balance + pendingIn − pendingOut).
 * English-pinned (ADR-105); no i18n / React here.
 */

import { describe, expect, test } from 'vitest'
import {
  computeAvailable,
  isPendingTransfer,
  projectedBalance,
  spendableNow,
  type AvailableAccountInput,
} from './availableBalance'
import type { Transfer } from '../../mock/types'

const TODAY = '2026-07-07'

/** A minimal funding account (native balance + currency). */
function acct(overrides: Partial<AvailableAccountInput>): AvailableAccountInput {
  return { id: 'a-1', currency: 'ARS', balance: 0, ...overrides }
}

/** A minimal transfer leg. */
function transfer(overrides: Partial<Transfer>): Transfer {
  return {
    id: 't-1',
    fromAccountId: 'a-1',
    toAccountId: 'a-2',
    amountOut: '0',
    amountIn: '0',
    occurredOn: TODAY,
    ...overrides,
  }
}

describe('computeAvailable — pendingOut (ADR-193)', () => {
  test('a future-dated outflow subtracts from the source account', () => {
    const map = computeAvailable(
      [acct({ id: 'gal', balance: 100_000 })],
      [
        transfer({
          fromAccountId: 'gal',
          toAccountId: 'other',
          amountOut: '30000',
          amountIn: '30000',
          occurredOn: '2026-07-20',
        }),
      ],
      TODAY,
    )
    const gal = map.get('gal')!
    expect(gal.balance).toBe(100_000)
    expect(gal.pendingOut).toBe(30_000)
    expect(gal.pendingIn).toBe(0)
    expect(spendableNow(gal)).toBe(70_000)
  })
})

describe('computeAvailable — pendingIn (ADR-193)', () => {
  test('multiple future-dated inflows accumulate into the destination', () => {
    const map = computeAvailable(
      [acct({ id: 'gal', balance: 100_000 })],
      [
        transfer({
          fromAccountId: 'other',
          toAccountId: 'gal',
          amountOut: '20000',
          amountIn: '20000',
          occurredOn: '2026-07-15',
        }),
        transfer({
          id: 't-2',
          fromAccountId: 'other',
          toAccountId: 'gal',
          amountOut: '5000',
          amountIn: '5000',
          occurredOn: '2026-07-18',
        }),
      ],
      TODAY,
    )
    const gal = map.get('gal')!
    expect(gal.pendingIn).toBe(25_000)
    expect(gal.pendingOut).toBe(0)
    // Spendable-now NEVER adds the arriving money (ADR-194).
    expect(spendableNow(gal)).toBe(100_000)
    // Projected DOES count it (ADR-195).
    expect(projectedBalance(gal)).toBe(125_000)
  })
})

describe('computeAvailable — per-currency isolation (ADR-133)', () => {
  test('a USD leg never touches an ARS account; each figure stays native', () => {
    const map = computeAvailable(
      [
        acct({ id: 'ars', currency: 'ARS', balance: 100_000 }),
        acct({ id: 'usd', currency: 'USD', balance: 500 }),
      ],
      [
        // USD outflow from the USD account into the ARS account is nonsense in a
        // same-currency world, but the primitive attributes each side by id in
        // that side's native amount — never summing across currencies.
        transfer({
          fromAccountId: 'usd',
          toAccountId: 'ars',
          amountOut: '100',
          amountIn: '120000',
          occurredOn: '2026-07-20',
        }),
      ],
      TODAY,
    )
    const usd = map.get('usd')!
    const ars = map.get('ars')!
    expect(usd.currency).toBe('USD')
    expect(usd.pendingOut).toBe(100)
    expect(spendableNow(usd)).toBe(400)
    expect(ars.currency).toBe('ARS')
    expect(ars.pendingIn).toBe(120_000)
    expect(projectedBalance(ars)).toBe(220_000)
    // No cross-sum: the USD figure and the ARS figure are independent.
  })
})

describe('computeAvailable — future-vs-past dating (ADR-191)', () => {
  test('only occurred_on strictly after today pends; today / past do not', () => {
    const map = computeAvailable(
      [acct({ id: 'gal', balance: 100_000 })],
      [
        // In the past — already settled, in the balance, not pending.
        transfer({
          fromAccountId: 'gal',
          amountOut: '10000',
          amountIn: '10000',
          occurredOn: '2026-06-30',
        }),
        // TODAY — settled today, not strictly future, not pending.
        transfer({
          id: 't-today',
          fromAccountId: 'gal',
          amountOut: '5000',
          amountIn: '5000',
          occurredOn: TODAY,
        }),
        // Future — the only one that pends.
        transfer({
          id: 't-future',
          fromAccountId: 'gal',
          amountOut: '7000',
          amountIn: '7000',
          occurredOn: '2026-07-08',
        }),
      ],
      TODAY,
    )
    const gal = map.get('gal')!
    expect(gal.pendingOut).toBe(7_000)
    expect(spendableNow(gal)).toBe(93_000)
  })

  test('isPendingTransfer: future true, today/past/malformed false', () => {
    expect(
      isPendingTransfer(transfer({ occurredOn: '2026-07-08' }), TODAY),
    ).toBe(true)
    expect(isPendingTransfer(transfer({ occurredOn: TODAY }), TODAY)).toBe(false)
    expect(
      isPendingTransfer(transfer({ occurredOn: '2026-07-06' }), TODAY),
    ).toBe(false)
    expect(isPendingTransfer(transfer({ occurredOn: 'not-a-date' }), TODAY)).toBe(
      false,
    )
  })
})

describe('computeAvailable — no matching transfers (ADR-193)', () => {
  test('an account with no pending legs keeps its balance, pending 0', () => {
    const map = computeAvailable(
      [acct({ id: 'gal', balance: 100_000 })],
      [
        // A pending leg between two OTHER accounts — nothing to attribute to gal.
        transfer({
          fromAccountId: 'x',
          toAccountId: 'y',
          amountOut: '5000',
          amountIn: '5000',
          occurredOn: '2026-07-20',
        }),
      ],
      TODAY,
    )
    const gal = map.get('gal')!
    expect(gal.balance).toBe(100_000)
    expect(gal.pendingIn).toBe(0)
    expect(gal.pendingOut).toBe(0)
    expect(spendableNow(gal)).toBe(100_000)
    expect(projectedBalance(gal)).toBe(100_000)
  })

  test('every input account is present in the map, even with no transfers', () => {
    const map = computeAvailable(
      [acct({ id: 'a' }), acct({ id: 'b' })],
      [],
      TODAY,
    )
    expect(map.has('a')).toBe(true)
    expect(map.has('b')).toBe(true)
  })
})

describe('projectedBalance (ADR-195)', () => {
  test('balance + pendingIn − pendingOut', () => {
    const map = computeAvailable(
      [acct({ id: 'gal', balance: 100_000 })],
      [
        transfer({
          fromAccountId: 'gal',
          toAccountId: 'z',
          amountOut: '30000',
          amountIn: '30000',
          occurredOn: '2026-07-20',
        }),
        transfer({
          id: 't-in',
          fromAccountId: 'z',
          toAccountId: 'gal',
          amountOut: '10000',
          amountIn: '10000',
          occurredOn: '2026-07-21',
        }),
      ],
      TODAY,
    )
    const gal = map.get('gal')!
    // 100_000 + 10_000 − 30_000
    expect(projectedBalance(gal)).toBe(80_000)
    // spendable-now ignores the inflow: 100_000 − 30_000
    expect(spendableNow(gal)).toBe(70_000)
  })
})
