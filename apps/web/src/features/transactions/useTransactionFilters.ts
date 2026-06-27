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
  ALL_MONTHS,
  LAST_12_MONTHS,
  currentViewingMonth,
} from '../../components/months'
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

/** Options for {@link useTransactionFilters}. */
export interface UseTransactionFiltersOptions {
  /**
   * Categories to seed the filter with on first mount (ADR-062 drilldown). Used
   * once via lazy reducer init; the user can clear or change it normally
   * afterward, and it does not re-apply on re-render.
   */
  initialCategories?: Category[]
  /**
   * Type segment to seed the filter with on first mount (ADR-062 pattern). The
   * Home Monotributo "See the N invoices behind this" link passes `'invoice'`.
   * Used once via lazy reducer init (seed-once, like `initialCategories`); the
   * user can clear or change it afterward and it does not re-apply on re-render.
   * `'all'` (or absent) is a no-op.
   */
  initialType?: TypeFilter
}

/** Own the Transactions filter state and expose stable, typed setters. */
export function useTransactionFilters(
  options: UseTransactionFiltersOptions = {},
): UseTransactionFilters {
  const { initialCategories, initialType } = options
  const [filters, dispatch] = useReducer(
    filtersReducer,
    undefined,
    (): TransactionFilters => {
      const hasCategorySeed = !!initialCategories && initialCategories.length > 0
      const hasTypeSeed = !!initialType && initialType !== 'all'
      // A drilldown (ADR-062) widens the month scope past the current-month
      // default so the seed reveals more than one month of history. The windows
      // differ on purpose: the Monotributo invoice drill-in (`initialType`)
      // opens at "Last 12 months" so the visible invoices line up with the
      // card's annual/trailing total (matches the backend trailing window); a
      // category drilldown (`initialCategories`) opens at "All time" for the
      // full category history. Seeds compose; when both are present, type's
      // Last-12 window wins (the invoice list should stay bounded).
      if (hasCategorySeed || hasTypeSeed) {
        return {
          ...DEFAULT_FILTERS,
          month: hasTypeSeed ? LAST_12_MONTHS : ALL_MONTHS,
          ...(hasCategorySeed ? { categories: [...initialCategories] } : {}),
          ...(hasTypeSeed ? { type: initialType } : {}),
        }
      }
      // Otherwise default the per-screen month to the CURRENT month on first
      // load (the ledger owns its own month, independent of the Home navigator
      // — ADR-040). "All time" and other months are reachable via the picker;
      // "Clear filters" widens back to all time (DEFAULT_FILTERS).
      return { ...DEFAULT_FILTERS, month: currentViewingMonth() }
    },
  )

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
