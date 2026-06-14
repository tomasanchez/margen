import { describe, expect, test } from 'vitest'
import { TRANSACTIONS_FIXTURE as SEED_TRANSACTIONS } from './__fixtures__/transactions'
import {
  DEFAULT_FILTERS,
  activeFilterCount,
  buildEditPrefill,
  filterTransactions,
  hasActiveFilters,
  presentMonths,
  type TransactionFilters,
} from './filtering'
import type { Transaction } from '../../mock/types'

/** Build a filter set from overrides on top of the neutral default. */
function withFilters(over: Partial<TransactionFilters>): TransactionFilters {
  return { ...DEFAULT_FILTERS, ...over }
}

describe('filterTransactions', () => {
  test('with default filters returns every row, grouped newest-first', () => {
    const result = filterTransactions(SEED_TRANSACTIONS, DEFAULT_FILTERS)
    expect(result.filteredCount).toBe(SEED_TRANSACTIONS.length)
    expect(result.groups.map((g) => g.month)).toEqual(['June', 'May', 'April'])
    // Newest-first within June: Jun 12 before Jun 11.
    const june = result.groups[0]
    expect(june.items[0].dispDate).toBe('Jun 12')
    expect(june.items[1].dispDate).toBe('Jun 11')
  })

  test('totals: inflow, outflow and net are consistent', () => {
    const result = filterTransactions(SEED_TRANSACTIONS, DEFAULT_FILTERS)
    const expectedIn = SEED_TRANSACTIONS.filter((t) => t.type === 'income')
      .reduce((s, t) => s + t.amountNum, 0)
    const expectedOut = SEED_TRANSACTIONS.filter((t) => t.type === 'expense')
      .reduce((s, t) => s + t.amountNum, 0)
    expect(result.inflow).toBe(expectedIn)
    expect(result.outflow).toBe(expectedOut)
    expect(result.net).toBe(expectedIn - expectedOut)
  })

  test('search matches name OR category, case-insensitively', () => {
    const byName = filterTransactions(
      SEED_TRANSACTIONS,
      withFilters({ q: 'netflix' }),
    )
    expect(byName.rows.every((t) => /netflix/i.test(t.name))).toBe(true)
    expect(byName.rows.length).toBeGreaterThan(0)

    const byCategory = filterTransactions(
      SEED_TRANSACTIONS,
      withFilters({ q: 'rent' }),
    )
    expect(byCategory.rows.every((t) => t.category === 'Rent')).toBe(true)
  })

  test('type filter: invoices use kind, income excludes invoices', () => {
    const invoices = filterTransactions(
      SEED_TRANSACTIONS,
      withFilters({ type: 'invoice' }),
    )
    expect(invoices.rows.every((t) => t.kind === 'invoice')).toBe(true)

    const income = filterTransactions(
      SEED_TRANSACTIONS,
      withFilters({ type: 'income' }),
    )
    expect(income.rows.every((t) => t.kind === 'income')).toBe(true)
    expect(income.rows.some((t) => t.kind === 'invoice')).toBe(false)

    const expenses = filterTransactions(
      SEED_TRANSACTIONS,
      withFilters({ type: 'expense' }),
    )
    expect(expenses.rows.every((t) => t.type === 'expense')).toBe(true)
  })

  test('currency, month, category and bank filters narrow the list', () => {
    const usd = filterTransactions(
      SEED_TRANSACTIONS,
      withFilters({ currency: 'USD' }),
    )
    expect(usd.rows.every((t) => t.currency === 'USD')).toBe(true)

    const may = filterTransactions(
      SEED_TRANSACTIONS,
      withFilters({ month: 'May' }),
    )
    expect(may.groups.map((g) => g.month)).toEqual(['May'])

    const food = filterTransactions(
      SEED_TRANSACTIONS,
      withFilters({ categories: ['Food'] }),
    )
    expect(food.rows.every((t) => t.category === 'Food')).toBe(true)

    const transfer = filterTransactions(
      SEED_TRANSACTIONS,
      withFilters({ banks: ['Transfer'] }),
    )
    expect(transfer.rows.every((t) => t.bank === 'Transfer')).toBe(true)
  })

  test('amount ranges bucket by ARS-equivalent magnitude', () => {
    const big = filterTransactions(
      SEED_TRANSACTIONS,
      withFilters({ amount: 'gt1m' }),
    )
    expect(big.rows.every((t) => t.amountNum >= 1_000_000)).toBe(true)

    const small = filterTransactions(
      SEED_TRANSACTIONS,
      withFilters({ amount: 'lt10' }),
    )
    expect(small.rows.every((t) => t.amountNum < 10_000)).toBe(true)
  })

  test('no matches yields an empty grouping', () => {
    const none = filterTransactions(
      SEED_TRANSACTIONS,
      withFilters({ q: 'definitely-not-a-real-merchant' }),
    )
    expect(none.filteredCount).toBe(0)
    expect(none.groups).toHaveLength(0)
  })

  test('handles an empty input list gracefully', () => {
    const result = filterTransactions([], DEFAULT_FILTERS)
    expect(result.filteredCount).toBe(0)
    expect(result.net).toBe(0)
  })
})

describe('filter-state helpers', () => {
  test('hasActiveFilters reflects any narrowing', () => {
    expect(hasActiveFilters(DEFAULT_FILTERS)).toBe(false)
    expect(hasActiveFilters(withFilters({ q: 'x' }))).toBe(true)
    expect(hasActiveFilters(withFilters({ categories: ['Food'] }))).toBe(true)
  })

  test('activeFilterCount excludes search and type', () => {
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0)
    expect(
      activeFilterCount(withFilters({ q: 'x', type: 'expense' })),
    ).toBe(0)
    expect(
      activeFilterCount(
        withFilters({ currency: 'USD', categories: ['Food', 'Rent'] }),
      ),
    ).toBe(3)
  })

  test('presentMonths returns the data months in display order', () => {
    expect(presentMonths(SEED_TRANSACTIONS)).toEqual(['June', 'May', 'April'])
  })
})

describe('buildEditPrefill', () => {
  test('maps an expense row to a prefill shaped like NewTransactionInput', () => {
    const expense = SEED_TRANSACTIONS.find(
      (t): t is Transaction => t.name === 'Coto supermarket',
    )!
    const prefill = buildEditPrefill(expense)
    expect(prefill).toMatchObject({
      name: 'Coto supermarket',
      type: 'expense',
      category: 'Food',
      bank: 'Galicia · Visa',
      currency: 'ARS',
      amountNum: 38400,
    })
  })

  test('income/invoice rows have their Income category reset to Food', () => {
    const invoice = SEED_TRANSACTIONS.find(
      (t): t is Transaction => t.category === 'Income',
    )!
    const prefill = buildEditPrefill(invoice)
    expect(prefill.category).toBe('Food')
  })

  test('USD rows carry usd + rate through the prefill', () => {
    const usd = SEED_TRANSACTIONS.find(
      (t): t is Transaction => t.currency === 'USD',
    )!
    const prefill = buildEditPrefill(usd)
    expect(prefill.currency).toBe('USD')
    expect(prefill.usd).toBe(usd.usd)
    expect(prefill.rate).toBe(usd.rate)
  })
})
