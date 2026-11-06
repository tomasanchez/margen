/**
 * Unit tests for the payment-allocation helpers (ADR-206/215/221).
 *
 * Targets are built in the server's fill order (due cuotas oldest-first, flat
 * items, then upcoming cuotas), never include forgiven / settled targets, map a
 * server suggestion onto rows, and serialize back to the API's `allocations` —
 * with `installmentId` for a cuota and none for a flat item.
 */

import { describe, expect, test } from 'vitest'
import {
  allocatedCents,
  allocationKey,
  buildAllocationTargets,
  fillUpcoming,
  includesUpcoming,
  suggestionValues,
  toAllocations,
} from './allocation'
import { makeCuota, makeItem } from './__fixtures__/receivables'

const FLAT = makeItem({
  id: 'flat',
  occurredOn: '2026-08-10',
  amount: '50000.00',
})
const FORGIVEN = makeItem({
  id: 'forgiven',
  occurredOn: '2026-08-05',
  amount: '9000.00',
  pardoned: true,
})
const PLAN = makeItem({
  id: 'plan',
  occurredOn: '2026-07-01',
  amount: '400000.00',
  installments: [
    makeCuota({ id: 'c1', index: 1, dueOn: '2026-08-01', amount: '100000.00', status: 'paid', paid: '100000.00' }),
    makeCuota({ id: 'c2', index: 2, dueOn: '2026-09-01', amount: '100000.00', status: 'due', paid: '40000.00' }),
    makeCuota({ id: 'c3', index: 3, dueOn: '2026-10-01', amount: '100000.00', status: 'pardoned' }),
    makeCuota({ id: 'c4', index: 4, dueOn: '2026-12-01', amount: '100000.00', status: 'upcoming' }),
  ],
})

describe('buildAllocationTargets', () => {
  test('lists due cuotas, then flat items, then upcoming cuotas — open ones only', () => {
    const targets = buildAllocationTargets([FLAT, FORGIVEN, PLAN])
    expect(targets.map((target) => target.key)).toEqual([
      'plan:c2',
      'flat:',
      'plan:c4',
    ])
    // Remaining is per target (cuota 2 is half paid).
    expect(targets[0].remainingCents).toBe(6_000_000)
    expect(targets[2].upcoming).toBe(true)
  })
})

describe('suggestion → rows → allocations', () => {
  const targets = buildAllocationTargets([FLAT, PLAN])

  test('maps a server suggestion onto row keys as input text', () => {
    const values = suggestionValues({
      asOf: '2026-11-06',
      amount: '70000.00',
      allocated: '70000.00',
      unallocated: '0.00',
      allocations: [
        { itemId: 'plan', installmentId: 'c2', amount: '60000.00' },
        { itemId: 'flat', installmentId: null, amount: '10000.00' },
      ],
    })
    expect(values).toEqual({ 'plan:c2': '60000', 'flat:': '10000' })
  })

  test('serializes positive rows with installmentId only for cuotas', () => {
    const values = {
      [allocationKey('plan', 'c2')]: '60000',
      [allocationKey('flat', null)]: '10000,5',
      [allocationKey('plan', 'c4')]: '0',
    }
    expect(toAllocations(targets, values)).toEqual([
      { itemId: 'plan', installmentId: 'c2', amount: '60000.00' },
      { itemId: 'flat', amount: '10000.50' },
    ])
    expect(allocatedCents(targets, values)).toBe(7_000_050)
    expect(includesUpcoming(targets, values)).toBe(false)
  })

  test('fillUpcoming spreads a leftover over upcoming cuotas, capped at each', () => {
    const changed = fillUpcoming(targets, { 'plan:c4': '20000' }, 9_000_000)
    // c4 already holds 20.000; it can take 80.000 more (its remaining is 100.000).
    expect(changed).toEqual({ 'plan:c4': '100000' })
    expect(includesUpcoming(targets, { ...changed })).toBe(true)
  })
})
