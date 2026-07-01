/**
 * Own the Budgets month by deriving it from — and writing it back to — the
 * `/budgets` route's validated `?month=YYYY-MM` search param (ADR-040/125,
 * mirroring ADR-116 on Transactions). The live {@link ViewingMonth} is a pure
 * function of the URL (no local copy to drift); switching months navigates in
 * `replace` mode (a month change is not a history step) so reload / back-forward
 * / deep-links restore the exact month.
 *
 * Kept out of the page-component module so the page stays Fast-Refresh-friendly
 * (a module that exports a component should not also export hooks). `router.tsx`
 * registers the route with {@link validateBudgetsSearch}; this hook is called
 * inside that route via {@link BudgetsRoute}.
 */

import { useCallback, useMemo } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import type { ViewingMonth } from '../../components/months'
import {
  monthToBudgetsSearch,
  searchToBudgetMonth,
  type BudgetsSearch,
} from './budgetsSearch'

/** The URL-synced budget month plus the setter that writes it back to the URL. */
export interface UseBudgetMonth {
  month: ViewingMonth
  setMonth: (next: ViewingMonth) => void
}

/**
 * Read the `/budgets` `month` param and expose a setter that navigates in
 * `replace` mode. Must be called inside a router for the `/budgets` route.
 */
export function useBudgetMonth(): UseBudgetMonth {
  // Read the validated `/budgets` search loosely (`strict: false` returns the
  // cross-route union); we own the shape via `validateBudgetsSearch`, so we
  // narrow it. `navigate` is used untyped-from with a typed `search` updater to
  // sidestep the self-referential router generics tripped when this hook is
  // imported by the route tree (same approach as `useTransactionFilters`).
  const rawSearch = useSearch({ strict: false }) as BudgetsSearch
  const navigate = useNavigate()

  const month = useMemo(() => searchToBudgetMonth(rawSearch), [rawSearch])

  const setMonth = useCallback(
    (next: ViewingMonth) => {
      void navigate({
        to: '/budgets',
        search: (() => monthToBudgetsSearch(next)) as unknown as BudgetsSearch,
        replace: true,
      })
    },
    [navigate],
  )

  return { month, setMonth }
}
