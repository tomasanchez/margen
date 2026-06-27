/**
 * Filter + search state for the Transactions screen, with the URL as the single
 * source of truth (ADR-116, amending ADR-012: filters are no longer purely
 * in-memory). The live {@link TransactionFilters} are DERIVED from the route's
 * validated search params via the pure {@link searchToFilters}; every filter
 * write navigates with `replace: true` (filters aren't history steps) using
 * {@link filtersToSearch} to omit defaults. Reload and browser back/forward
 * therefore restore the exact filter state from the URL for free.
 *
 * The router coupling is intentionally narrow: {@link useTransactionFilters}
 * reads `useSearch` + `useNavigate` for the `/transactions` route and returns a
 * `{ filters, controls }` bundle. `router.tsx` calls it and passes the bundle
 * down as props, so {@link TransactionsPage} stays router-agnostic (rendrable
 * standalone in tests with a default/local bundle — see ADR-062 note there).
 *
 * Kept out of the page component file so the page stays Fast-Refresh-friendly
 * (a module that exports a component should not also export hooks).
 */

import { useCallback, useMemo } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import type { Bank, Category } from '../../mock/types'
import {
  filtersToSearch,
  searchToFilters,
  type AmountRange,
  type CurrencyFilter,
  type MonthFilter,
  type TransactionFilters,
  type TransactionsSearch,
  type TypeFilter,
} from './filtering'

/** Add or remove `value` from `list`, returning a new array. */
function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value)
    ? list.filter((item) => item !== value)
    : [...list, value]
}

/** Typed bundle of bound filter setters returned by {@link useTransactionFilters}. */
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

/** The derived filter state plus the control callbacks that mutate the URL. */
export interface UseTransactionFilters {
  filters: TransactionFilters
  controls: FilterControls
}

/**
 * Own the Transactions filter state by deriving it from — and writing it back
 * to — the `/transactions` route's validated search params (ADR-116). Must be
 * called inside a router for that route; `router.tsx` owns that call and passes
 * the result to {@link TransactionsPage} as props.
 */
export function useTransactionFilters(): UseTransactionFilters {
  // Read the validated `/transactions` search loosely (`strict: false` returns
  // the cross-route union); we own the shape via `validateTransactionsSearch`,
  // so we narrow it to `TransactionsSearch`. Likewise `navigate` is used
  // untyped-from and given typed `search` updaters — this sidesteps the
  // self-referential router generics that the `from`-narrowed API trips on when
  // this hook is imported BY `router.tsx` (which registers the route tree).
  const rawSearch = useSearch({ strict: false }) as TransactionsSearch
  const navigate = useNavigate()

  // Live filters are a pure function of the URL — no local copy to drift.
  const filters = useMemo(() => searchToFilters(rawSearch), [rawSearch])

  // Push a new filter set to the URL in `replace` mode (a filter change is not a
  // history step). The `search` updater re-derives from the live `prev` so a
  // concurrent change is never clobbered, then re-encodes with defaults omitted.
  const pushFilters = useCallback(
    (next: (current: TransactionFilters) => TransactionFilters) => {
      void navigate({
        to: '/transactions',
        search: ((prev: TransactionsSearch) =>
          filtersToSearch(
            next(searchToFilters(prev)),
          )) as unknown as TransactionsSearch,
        replace: true,
      })
    },
    [navigate],
  )

  const controls = useMemo<FilterControls>(() => {
    const patch = (p: Partial<TransactionFilters>) =>
      pushFilters((current) => ({ ...current, ...p }))
    return {
      setSearch: (value) => patch({ q: value }),
      setType: (value) => patch({ type: value }),
      setCurrency: (value) => patch({ currency: value }),
      setMonth: (value) => patch({ month: value }),
      toggleCategory: (value) =>
        pushFilters((current) => ({
          ...current,
          categories: toggle(current.categories, value),
        })),
      toggleBank: (value) =>
        pushFilters((current) => ({
          ...current,
          banks: toggle(current.banks, value),
        })),
      setAmount: (value) => patch({ amount: value }),
      // "Clear filters" widens to the neutral baseline: every filter off and the
      // month at All-time (DEFAULT_FILTERS), preserving the pre-ADR-116 behavior
      // where clearing widened past the current-month default. `month=all` is the
      // ONE non-default we deliberately keep in the URL so the widened scope is
      // shareable and survives reload (absence of `month` would mean current
      // month, which is narrower).
      clear: () =>
        void navigate({
          to: '/transactions',
          search: (() => ({ month: 'all' })) as unknown as TransactionsSearch,
          replace: true,
        }),
    }
  }, [pushFilters, navigate])

  return { filters, controls }
}
