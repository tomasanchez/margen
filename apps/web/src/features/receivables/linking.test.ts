/**
 * Unit tests for the receivable → expense link helpers (ADR-217…220).
 */

import { describe, expect, test } from 'vitest'
import type { Transaction } from '../../mock/types'
import {
  linkedExpenseFromTransaction,
  linkedOthersCents,
  overLinkedTotalCents,
  planTotalCents,
  suggestedCuotaCount,
  transactionsSearchFor,
  type LinkedExpense,
} from './linking'

const EXPENSE: LinkedExpense = {
  id: 'tx-1',
  name: 'Dinner at Don Julio',
  occurredOn: '2026-10-05',
  amount: '60000.00',
  currency: 'ARS',
  usdAmount: null,
  installmentsIndex: null,
  installmentsTotal: null,
  planTotal: '60000.00',
  linkedItemsTotal: '40000.00',
}

describe('over-split warning (ADR-218)', () => {
  test('a new item adds to what other items already link', () => {
    const others = linkedOthersCents(EXPENSE, null)
    expect(others).toBe(4_000_000)
    // 40.000 + 25.000 > 60.000 → warn with the combined total.
    expect(overLinkedTotalCents(EXPENSE, others, 2_500_000)).toBe(6_500_000)
    // 40.000 + 20.000 = 60.000 → exactly the expense, no warning.
    expect(overLinkedTotalCents(EXPENSE, others, 2_000_000)).toBeNull()
  })

  test('editing an item already linked to it subtracts its saved amount', () => {
    // The 40.000 linked total INCLUDES this item's own 30.000.
    const others = linkedOthersCents(EXPENSE, {
      linkedExpenseId: 'tx-1',
      amount: '30000.00',
    })
    expect(others).toBe(1_000_000)
    expect(overLinkedTotalCents(EXPENSE, others, 5_000_000)).toBeNull()
  })

  test('a card-cuota expense is compared against its whole plan, not one cuota', () => {
    // Cuota 3/6 of 10.000 → the purchase stands for 60.000 (planTotal).
    const cuota: LinkedExpense = {
      ...EXPENSE,
      amount: '10000.00',
      installmentsIndex: 3,
      installmentsTotal: 6,
      planTotal: '60000.00',
      linkedItemsTotal: '0.00',
    }
    // The debt equals the whole plan → NO warning (it would warn against 10.000).
    expect(overLinkedTotalCents(cuota, 0, 6_000_000)).toBeNull()
    // Beyond the plan total → warn.
    expect(overLinkedTotalCents(cuota, 0, 6_000_001)).toBe(6_000_001)
  })

  test('an unknown linked total never warns', () => {
    const unknown = { ...EXPENSE, linkedItemsTotal: null }
    expect(linkedOthersCents(unknown, null)).toBeNull()
    expect(overLinkedTotalCents(unknown, null, 99_999_999)).toBeNull()
  })
})

describe('linkedExpenseFromTransaction (ADR-220)', () => {
  test('builds the link from a transactions-list expense row', () => {
    const row: Transaction = {
      id: 'tx-9',
      occurredOn: '2026-10-05',
      dispDate: 'Oct 05',
      month: 'October',
      name: 'Notebook',
      category: 'Shopping',
      bank: 'Santander',
      currency: 'USD',
      type: 'expense',
      kind: 'expense',
      amountNum: 1_250_000,
      usd: 1000,
      installmentsIndex: 2,
      installmentsTotal: 6,
    }
    expect(linkedExpenseFromTransaction(row)).toEqual({
      id: 'tx-9',
      name: 'Notebook',
      occurredOn: '2026-10-05',
      amount: '1250000.00',
      currency: 'USD',
      usdAmount: '1000',
      installmentsIndex: 2,
      installmentsTotal: 6,
      // Derived like the server: one card cuota × the plan length.
      planTotal: '7500000.00',
      linkedItemsTotal: null,
    })
  })

  test('suggests the expense\'s own cuota count when it is a valid plan', () => {
    expect(suggestedCuotaCount({ installmentsTotal: 6 })).toBe(6)
    expect(suggestedCuotaCount({ installmentsTotal: 1 })).toBeNull()
    expect(suggestedCuotaCount({ installmentsTotal: null })).toBeNull()
    expect(suggestedCuotaCount({ installmentsTotal: 240 })).toBe(120)
  })
})

describe('planTotalCents', () => {
  test('is amount × installmentsTotal for a card cuota, else the amount', () => {
    expect(planTotalCents({ amount: '10000.00', installmentsTotal: 6 })).toBe(6_000_000)
    expect(planTotalCents({ amount: '10000.00', installmentsTotal: null })).toBe(1_000_000)
  })
})

describe('transactionsSearchFor', () => {
  test('filters the ledger to the expense by name within its month', () => {
    expect(transactionsSearchFor(EXPENSE)).toEqual({
      q: 'Dinner at Don Julio',
      month: '2026-10',
    })
  })
})
