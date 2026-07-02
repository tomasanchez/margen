/**
 * Own the Reports month by deriving it from — and writing it back to — the
 * `/reports` route's validated `?month=YYYY-MM` search param (mirroring the
 * Budgets hook, ADR-040/125). The live {@link ViewingMonth} is a pure function of
 * the URL; switching months navigates in `replace` mode (a month change is not a
 * history step) so reload / back-forward / deep-links restore the exact month.
 *
 * Kept out of the page-component module so the page stays Fast-Refresh-friendly.
 */

import { useCallback, useMemo } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import type { ViewingMonth } from '../../components/months'
import {
  monthToReportsSearch,
  searchToReportMonth,
  type ReportsSearch,
} from './reportsSearch'

/** The URL-synced report month plus the setter that writes it back to the URL. */
export interface UseReportMonth {
  month: ViewingMonth
  setMonth: (next: ViewingMonth) => void
}

/**
 * Read the `/reports` `month` param and expose a setter that navigates in
 * `replace` mode. Must be called inside a router for the `/reports` route.
 */
export function useReportMonth(): UseReportMonth {
  // Read the validated `/reports` search loosely (`strict: false` returns the
  // cross-route union); we own the shape via `validateReportsSearch`, so we
  // narrow it (same approach as `useBudgetMonth`).
  const rawSearch = useSearch({ strict: false }) as ReportsSearch
  const navigate = useNavigate()

  const month = useMemo(() => searchToReportMonth(rawSearch), [rawSearch])

  const setMonth = useCallback(
    (next: ViewingMonth) => {
      void navigate({
        to: '/reports',
        search: (() => monthToReportsSearch(next)) as unknown as ReportsSearch,
        replace: true,
      })
    },
    [navigate],
  )

  return { month, setMonth }
}
