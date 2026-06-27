import { describe, expect, test } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { ALL_MONTHS, currentViewingMonth } from '../../components/months'
import { DEFAULT_FILTERS } from './filtering'
import { filtersReducer, useTransactionFilters } from './useTransactionFilters'

describe('filtersReducer', () => {
  test('setSearch / setType / setCurrency / setMonth / setAmount set values', () => {
    let s = filtersReducer(DEFAULT_FILTERS, { kind: 'setSearch', value: 'uber' })
    expect(s.q).toBe('uber')
    s = filtersReducer(s, { kind: 'setType', value: 'invoice' })
    expect(s.type).toBe('invoice')
    s = filtersReducer(s, { kind: 'setCurrency', value: 'USD' })
    expect(s.currency).toBe('USD')
    s = filtersReducer(s, { kind: 'setMonth', value: { year: 2026, month: 4 } })
    expect(s.month).toEqual({ year: 2026, month: 4 })
    s = filtersReducer(s, { kind: 'setMonth', value: 'all' })
    expect(s.month).toBe('all')
    s = filtersReducer(s, { kind: 'setAmount', value: 'gt1m' })
    expect(s.amount).toBe('gt1m')
  })

  test('toggleCategory adds then removes', () => {
    let s = filtersReducer(DEFAULT_FILTERS, {
      kind: 'toggleCategory',
      value: 'Food',
    })
    expect(s.categories).toEqual(['Food'])
    s = filtersReducer(s, { kind: 'toggleCategory', value: 'Food' })
    expect(s.categories).toEqual([])
  })

  test('toggleBank accumulates multiple selections', () => {
    let s = filtersReducer(DEFAULT_FILTERS, {
      kind: 'toggleBank',
      value: 'Transfer',
    })
    s = filtersReducer(s, { kind: 'toggleBank', value: 'Brubank' })
    expect(s.banks).toEqual(['Transfer', 'Brubank'])
  })

  test('clear resets to the default filters', () => {
    const dirty = filtersReducer(
      filtersReducer(DEFAULT_FILTERS, { kind: 'setSearch', value: 'x' }),
      { kind: 'toggleCategory', value: 'Rent' },
    )
    expect(filtersReducer(dirty, { kind: 'clear' })).toEqual(DEFAULT_FILTERS)
  })
})

describe('useTransactionFilters seeding (ADR-062 drilldown)', () => {
  test('with no options, defaults month to the current month and type to "all"', () => {
    const { result } = renderHook(() => useTransactionFilters())
    expect(result.current.filters.month).toEqual(currentViewingMonth())
    expect(result.current.filters.type).toBe('all')
    expect(result.current.filters.categories).toEqual([])
  })

  test('initialType seeds the type segment AND opens at All time', () => {
    const { result } = renderHook(() =>
      useTransactionFilters({ initialType: 'invoice' }),
    )
    expect(result.current.filters.type).toBe('invoice')
    expect(result.current.filters.month).toBe(ALL_MONTHS)
  })

  test('initialType of "all" is a no-op (keeps the current-month default)', () => {
    const { result } = renderHook(() =>
      useTransactionFilters({ initialType: 'all' }),
    )
    expect(result.current.filters.type).toBe('all')
    expect(result.current.filters.month).toEqual(currentViewingMonth())
  })

  test('initialType composes with initialCategories, both seeded at All time', () => {
    const { result } = renderHook(() =>
      useTransactionFilters({
        initialType: 'invoice',
        initialCategories: ['Income'],
      }),
    )
    expect(result.current.filters.type).toBe('invoice')
    expect(result.current.filters.categories).toEqual(['Income'])
    expect(result.current.filters.month).toBe(ALL_MONTHS)
  })

  test('seeded type stays overridable by the user afterward', () => {
    const { result } = renderHook(() =>
      useTransactionFilters({ initialType: 'invoice' }),
    )
    act(() => {
      result.current.controls.setType('income')
    })
    expect(result.current.filters.type).toBe('income')
  })
})
