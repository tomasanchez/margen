/**
 * Filter + search state for the Transactions screen, owned locally (ADR-012:
 * prototype state is in-memory). A reducer keeps the many filter mutations
 * explicit and testable; the desktop FilterBar and the mobile filter sheet both
 * dispatch through the same actions so the two surfaces stay in lockstep.
 *
 * Kept out of the page component file so the page stays Fast-Refresh-friendly
 * (a module that exports a component should not also export hooks/reducers).
 */

import { useMemo, useReducer } from 'react'
import type { Bank, Category } from '../../mock/types'
import {
  DEFAULT_FILTERS,
  type AmountRange,
  type CurrencyFilter,
  type MonthFilter,
  type TransactionFilters,
  type TypeFilter,
} from './filtering'

/** Discriminated union of every filter mutation the screen can perform. */
export type FilterAction =
  | { kind: 'setSearch'; value: string }
  | { kind: 'setType'; value: TypeFilter }
  | { kind: 'setCurrency'; value: CurrencyFilter }
  | { kind: 'setMonth'; value: MonthFilter }
  | { kind: 'toggleCategory'; value: Category }
  | { kind: 'toggleBank'; value: Bank }
  | { kind: 'setAmount'; value: AmountRange }
  | { kind: 'clear' }

/** Add or remove `value` from `list`, returning a new array. */
function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value)
    ? list.filter((item) => item !== value)
    : [...list, value]
}

/** Pure reducer applying a {@link FilterAction} to the filter state. */
export function filtersReducer(
  state: TransactionFilters,
  action: FilterAction,
): TransactionFilters {
  switch (action.kind) {
    case 'setSearch':
      return { ...state, q: action.value }
    case 'setType':
      return { ...state, type: action.value }
    case 'setCurrency':
      return { ...state, currency: action.value }
    case 'setMonth':
      return { ...state, month: action.value }
    case 'toggleCategory':
      return { ...state, categories: toggle(state.categories, action.value) }
    case 'toggleBank':
      return { ...state, banks: toggle(state.banks, action.value) }
    case 'setAmount':
      return { ...state, amount: action.value }
    case 'clear':
      return DEFAULT_FILTERS
  }
}

/** Typed bundle of bound dispatchers returned by {@link useTransactionFilters}. */
export interface FilterControls {
  setSearch: (value: string) => void
  setType: (value: TypeFilter) => void
  setCurrency: (value: CurrencyFilter) => void
  setMonth: (value: MonthFilter) => void
  toggleCategory: (value: Category) => void
  toggleBank: (value: Bank) => void
  setAmount: (value: AmountRange) => void
  clear: () => void
}

/** The filter state plus the memoized control callbacks that mutate it. */
export interface UseTransactionFilters {
  filters: TransactionFilters
  controls: FilterControls
}

/** Own the Transactions filter state and expose stable, typed setters. */
export function useTransactionFilters(): UseTransactionFilters {
  const [filters, dispatch] = useReducer(filtersReducer, DEFAULT_FILTERS)

  const controls = useMemo<FilterControls>(
    () => ({
      setSearch: (value) => dispatch({ kind: 'setSearch', value }),
      setType: (value) => dispatch({ kind: 'setType', value }),
      setCurrency: (value) => dispatch({ kind: 'setCurrency', value }),
      setMonth: (value) => dispatch({ kind: 'setMonth', value }),
      toggleCategory: (value) => dispatch({ kind: 'toggleCategory', value }),
      toggleBank: (value) => dispatch({ kind: 'toggleBank', value }),
      setAmount: (value) => dispatch({ kind: 'setAmount', value }),
      clear: () => dispatch({ kind: 'clear' }),
    }),
    [],
  )

  return { filters, controls }
}
