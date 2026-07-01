import { describe, expect, test } from 'vitest'
import { TRANSACTIONS_FIXTURE as SEED_TRANSACTIONS } from './__fixtures__/transactions'
import {
  DEFAULT_FILTERS,
  activeFilterCount,
  buildEditPrefill,
  filterTransactions,
  filtersToSearch,
  hasActiveFilters,
  matchesMonth,
  presentMonths,
  searchToFilters,
  validateTransactionsSearch,
  type TransactionFilters,
} from './filtering'
import {
  ALL_MONTHS,
  LAST_12_MONTHS,
  THIS_YEAR,
  currentViewingMonth,
} from '../../components/months'
import type { Transaction } from '../../mock/types'

describe('matchesMonth (named-range sentinels)', () => {
  const now = new Date(2026, 5, 15) // 2026-06-15

  test('"all" matches every date (no scope)', () => {
    expect(matchesMonth(ALL_MONTHS, '2020-01-01', now)).toBe(true)
  })

  test('"last12" includes 5 months ago, excludes 13 months ago', () => {
    expect(matchesMonth(LAST_12_MONTHS, '2026-01-10', now)).toBe(true)
    expect(matchesMonth(LAST_12_MONTHS, '2025-05-31', now)).toBe(false)
    // First-of-month floor (June 2025) is inclusive.
    expect(matchesMonth(LAST_12_MONTHS, '2025-06-01', now)).toBe(true)
  })

  test('"thisYear" includes the Jan 1 boundary, excludes the prior Dec 31', () => {
    expect(matchesMonth(THIS_YEAR, '2026-01-01', now)).toBe(true)
    expect(matchesMonth(THIS_YEAR, '2025-12-31', now)).toBe(false)
  })

  test('a specific ViewingMonth matches that exact year+month only', () => {
    const may2026 = { year: 2026, month: 4 }
    expect(matchesMonth(may2026, '2026-05-20', now)).toBe(true)
    expect(matchesMonth(may2026, '2026-06-20', now)).toBe(false)
    expect(matchesMonth(may2026, '2025-05-20', now)).toBe(false)
  })
})

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

  test('groups a row in a month OUTSIDE the old fixed Jan–June window (ADR-040)', () => {
    // Regression: the previous grouping iterated a hardcoded Jan–June MONTH_ORDER
    // and matched by bare month name, so a July-dated row passed the filter yet
    // was dropped from every group (it never appeared in the list). Grouping now
    // covers ANY present month, so a today-dated July row shows.
    const julyRow: Transaction = {
      id: 'july-1',
      occurredOn: '2026-07-01',
      dispDate: 'Jul 01',
      month: 'July',
      name: 'Mercado Pago top-up',
      category: 'Other',
      bank: '' as Transaction['bank'],
      currency: 'ARS',
      type: 'expense',
      kind: 'expense',
      amountNum: 12000,
    }
    const result = filterTransactions([julyRow, ...SEED_TRANSACTIONS], {
      ...DEFAULT_FILTERS,
    })
    // The July row is present in the flat rows AND in a July group, sorted first
    // (newest occurredOn).
    expect(result.rows.some((t) => t.id === 'july-1')).toBe(true)
    expect(result.groups[0]?.month).toBe('July')
    expect(result.groups[0]?.items[0]?.id).toBe('july-1')
    expect(result.filteredCount).toBe(SEED_TRANSACTIONS.length + 1)
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

  test('currency, month and category filters narrow the list', () => {
    const usd = filterTransactions(
      SEED_TRANSACTIONS,
      withFilters({ currency: 'USD' }),
    )
    expect(usd.rows.every((t) => t.currency === 'USD')).toBe(true)

    // Year-aware month filter (ADR-040): the fixtures are 2026, so May 2026
    // matches; the same month in another year would not.
    const may = filterTransactions(
      SEED_TRANSACTIONS,
      withFilters({ month: { year: 2026, month: 4 } }),
    )
    expect(may.groups.map((g) => g.month)).toEqual(['May'])

    const mayOtherYear = filterTransactions(
      SEED_TRANSACTIONS,
      withFilters({ month: { year: 2025, month: 4 } }),
    )
    expect(mayOtherYear.filteredCount).toBe(0)

    const food = filterTransactions(
      SEED_TRANSACTIONS,
      withFilters({ categories: ['Food'] }),
    )
    expect(food.rows.every((t) => t.category === 'Food')).toBe(true)
  })

  test('the account filter narrows by accountId (ADR-134)', () => {
    // A tiny set with explicit account attribution: two rows on acc-1, one on
    // acc-2, and one unlinked. The fixtures carry no accountId, so build inline.
    const base = SEED_TRANSACTIONS[0]
    const tagged: Transaction[] = [
      { ...base, id: 't1', accountId: 'acc-1' },
      { ...base, id: 't2', accountId: 'acc-1' },
      { ...base, id: 't3', accountId: 'acc-2' },
      { ...base, id: 't4', accountId: null },
    ]

    const onlyAcc1 = filterTransactions(tagged, withFilters({ accounts: ['acc-1'] }))
    expect(onlyAcc1.filteredCount).toBe(2)
    expect(onlyAcc1.rows.every((t) => t.accountId === 'acc-1')).toBe(true)

    // A multi-select matches the union; the unlinked row never matches.
    const both = filterTransactions(
      tagged,
      withFilters({ accounts: ['acc-1', 'acc-2'] }),
    )
    expect(both.filteredCount).toBe(3)
    expect(both.rows.some((t) => t.accountId == null)).toBe(false)

    // An unknown id is a harmless no-op match (selects nothing).
    const unknown = filterTransactions(
      tagged,
      withFilters({ accounts: ['no-such-account'] }),
    )
    expect(unknown.filteredCount).toBe(0)
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
      bank: 'Galicia',
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

  test('carries the row notes through so an edit can re-save them (ADR-088)', () => {
    const base = SEED_TRANSACTIONS[0]
    const withNotes: Transaction = { ...base, notes: 'Reimbursed by client' }
    expect(buildEditPrefill(withNotes).notes).toBe('Reimbursed by client')
  })

  test('carries the linked accountId so editing seeds the Account selector (ADR-136)', () => {
    const base = SEED_TRANSACTIONS[0]
    expect(buildEditPrefill({ ...base, accountId: 'acc-7' }).accountId).toBe('acc-7')
    expect(buildEditPrefill({ ...base, accountId: null }).accountId).toBeUndefined()
  })

  test('omits notes from the prefill when the row has none (ADR-088)', () => {
    const noNotes: Transaction = { ...SEED_TRANSACTIONS[0], notes: undefined }
    expect('notes' in buildEditPrefill(noNotes)).toBe(false)
  })

  test('carries the import-set card through so an edit preserves it (ADR-117)', () => {
    const imported = SEED_TRANSACTIONS.find(
      (t): t is Transaction => t.card !== undefined,
    )!
    expect(buildEditPrefill(imported).card).toBe(imported.card)
  })

  test('omits card from the prefill when the row has none (ADR-117)', () => {
    const noCard: Transaction = { ...SEED_TRANSACTIONS[0], card: undefined }
    expect('card' in buildEditPrefill(noCard)).toBe(false)
  })

  test('carries the FX snapshot rate + source so an ARS edit reseeds it (ADR-148)', () => {
    const withSnapshot: Transaction = {
      ...SEED_TRANSACTIONS[1],
      currency: 'ARS',
      fxRate: '1240.5',
      fxSource: 'bolsa',
    }
    const prefill = buildEditPrefill(withSnapshot)
    expect(prefill.fxRate).toBe('1240.5')
    expect(prefill.fxSource).toBe('bolsa')
    // A row with no snapshot omits both (the field then prefills from the cache).
    const noSnapshot: Transaction = {
      ...SEED_TRANSACTIONS[1],
      fxRate: undefined,
      fxSource: undefined,
    }
    expect('fxRate' in buildEditPrefill(noSnapshot)).toBe(false)
    expect('fxSource' in buildEditPrefill(noSnapshot)).toBe(false)
  })
})

describe('validateTransactionsSearch (ADR-116)', () => {
  test('accepts each valid param and narrows it', () => {
    expect(
      validateTransactionsSearch({
        q: 'uber',
        type: 'invoice',
        currency: 'USD',
        month: '2026-05',
        category: 'Food,Rent',
        amount: 'gt1m',
      }),
    ).toEqual({
      q: 'uber',
      type: 'invoice',
      currency: 'USD',
      month: '2026-05',
      category: 'Food,Rent',
      amount: 'gt1m',
    })
  })

  test('drops default values so the URL never round-trips redundancy', () => {
    expect(
      validateTransactionsSearch({
        q: '   ',
        type: 'all',
        currency: 'all',
        amount: 'any',
        category: '',
      }),
    ).toEqual({})
  })

  test('ignores garbage type / amount / currency / month', () => {
    expect(validateTransactionsSearch({ type: 'bogus' })).toEqual({})
    expect(validateTransactionsSearch({ amount: 'huge' })).toEqual({})
    expect(validateTransactionsSearch({ currency: 'BTC' })).toEqual({})
    expect(validateTransactionsSearch({ month: '2026-13' })).toEqual({})
    expect(validateTransactionsSearch({ month: 'nope' })).toEqual({})
  })

  test('accepts the month range sentinels and a specific YYYY-MM', () => {
    expect(validateTransactionsSearch({ month: 'all' })).toEqual({ month: 'all' })
    expect(validateTransactionsSearch({ month: 'last12' })).toEqual({
      month: 'last12',
    })
    expect(validateTransactionsSearch({ month: 'thisYear' })).toEqual({
      month: 'thisYear',
    })
    expect(validateTransactionsSearch({ month: '2025-12' })).toEqual({
      month: '2025-12',
    })
  })

  test('a csv category with one unknown entry drops ONLY the unknown', () => {
    expect(validateTransactionsSearch({ category: 'Food,Bogus,Rent' })).toEqual({
      category: 'Food,Rent',
    })
    // All unknown → the param is omitted entirely.
    expect(validateTransactionsSearch({ category: 'Bogus,Nope' })).toEqual({})
  })

  test('back-compatible single category drilldown still validates', () => {
    expect(validateTransactionsSearch({ category: 'Food' })).toEqual({
      category: 'Food',
    })
    expect(validateTransactionsSearch({ category: 'Bogus' })).toEqual({})
  })

  test('accepts the account param: keeps opaque ids, de-dups, drops empties (ADR-134)', () => {
    // A single-id drilldown (the account drilldown link sets `account=<id>`).
    expect(validateTransactionsSearch({ account: 'acc-1' })).toEqual({
      account: 'acc-1',
    })
    // Account ids have no fixed allow-set, so any non-empty token survives;
    // duplicates and empty segments are dropped, order preserved.
    expect(
      validateTransactionsSearch({ account: 'acc-1, ,acc-2,acc-1' }),
    ).toEqual({ account: 'acc-1,acc-2' })
    // An all-empty value omits the param entirely.
    expect(validateTransactionsSearch({ account: ' , ' })).toEqual({})
    // A non-string value is ignored.
    expect(validateTransactionsSearch({ account: 42 })).toEqual({})
  })
})

describe('searchToFilters (ADR-116)', () => {
  const now = new Date(2026, 5, 15) // 2026-06-15

  test('an empty search defaults the month to the current month (ADR-040)', () => {
    const f = searchToFilters({}, now)
    expect(f.month).toEqual(currentViewingMonth(now))
    expect(f.type).toBe('all')
    expect(f.currency).toBe('all')
    expect(f.q).toBe('')
    expect(f.categories).toEqual([])
    expect(f.accounts).toEqual([])
    expect(f.amount).toBe('any')
  })

  test('hydrates every param, parsing csv + month token', () => {
    const f = searchToFilters(
      {
        q: 'rent',
        type: 'invoice',
        currency: 'ARS',
        month: '2026-05',
        category: 'Food,Rent',
        account: 'acc-1,acc-2',
        amount: '100_1m',
      },
      now,
    )
    expect(f).toEqual({
      q: 'rent',
      type: 'invoice',
      currency: 'ARS',
      month: { year: 2026, month: 4 },
      categories: ['Food', 'Rent'],
      accounts: ['acc-1', 'acc-2'],
      amount: '100_1m',
    })
  })

  test('the range sentinels round-trip through the month token', () => {
    expect(searchToFilters({ month: 'all' }, now).month).toBe(ALL_MONTHS)
    expect(searchToFilters({ month: 'last12' }, now).month).toBe(LAST_12_MONTHS)
    expect(searchToFilters({ month: 'thisYear' }, now).month).toBe(THIS_YEAR)
  })
})

describe('filtersToSearch (ADR-116, defaults omitted)', () => {
  const now = new Date(2026, 5, 15) // 2026-06-15

  test('the current-month default produces an EMPTY search', () => {
    const f: TransactionFilters = {
      ...DEFAULT_FILTERS,
      month: currentViewingMonth(now),
    }
    expect(filtersToSearch(f, now)).toEqual({})
  })

  test('omits every default, serializing only what narrows the list', () => {
    const f: TransactionFilters = {
      q: 'uber',
      type: 'invoice',
      currency: 'USD',
      month: { year: 2026, month: 4 },
      categories: ['Food', 'Rent'],
      accounts: ['acc-1', 'acc-2'],
      amount: 'gt1m',
    }
    expect(filtersToSearch(f, now)).toEqual({
      q: 'uber',
      type: 'invoice',
      currency: 'USD',
      month: '2026-05',
      category: 'Food,Rent',
      account: 'acc-1,acc-2',
      amount: 'gt1m',
    })
  })

  test('round-trips back through searchToFilters', () => {
    const f: TransactionFilters = {
      q: 'cafe',
      type: 'expense',
      currency: 'ARS',
      month: LAST_12_MONTHS,
      categories: ['Transport'],
      accounts: ['acc-9'],
      amount: 'lt10',
    }
    const restored = searchToFilters(
      validateTransactionsSearch(
        filtersToSearch(f, now) as Record<string, unknown>,
      ),
      now,
    )
    expect(restored).toEqual(f)
  })

  test('an empty/whitespace query is omitted', () => {
    const f: TransactionFilters = {
      ...DEFAULT_FILTERS,
      month: ALL_MONTHS,
      q: '   ',
    }
    expect(filtersToSearch(f, now)).toEqual({ month: 'all' })
  })
})
