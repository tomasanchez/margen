import { describe, expect, test } from 'vitest'
import { DEFAULT_FILTERS } from './filtering'
import { filtersReducer } from './useTransactionFilters'

describe('filtersReducer', () => {
  test('setSearch / setType / setCurrency / setMonth / setAmount set values', () => {
    let s = filtersReducer(DEFAULT_FILTERS, { kind: 'setSearch', value: 'uber' })
    expect(s.q).toBe('uber')
    s = filtersReducer(s, { kind: 'setType', value: 'invoice' })
    expect(s.type).toBe('invoice')
    s = filtersReducer(s, { kind: 'setCurrency', value: 'USD' })
    expect(s.currency).toBe('USD')
    s = filtersReducer(s, { kind: 'setMonth', value: 'May' })
    expect(s.month).toBe('May')
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
