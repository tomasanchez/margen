/**
 * Own the Reports analytics range by deriving it from — and writing it back to —
 * the `/reports` route's validated `?range=` search param (ADR-167, mirroring the
 * Budgets month hook, ADR-040/125). The live {@link ReportsRange} is a pure
 * function of the URL (no local copy to drift); switching ranges navigates in
 * `replace` mode (a range change is not a history step) so reload / back-forward
 * / deep-links restore the exact window.
 *
 * Kept out of the page-component module so the page stays Fast-Refresh-friendly.
 */

import { useCallback, useMemo } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import type { ReportsRange } from '../../api/reportsClient'
import {
  rangeToReportsSearch,
  searchToReportRange,
  type ReportsSearch,
} from './reportsSearch'

/** The URL-synced report range plus the setter that writes it back to the URL. */
export interface UseReportRange {
  range: ReportsRange
  setRange: (next: ReportsRange) => void
}

/**
 * Read the `/reports` `range` param and expose a setter that navigates in
 * `replace` mode. Must be called inside a router for the `/reports` route.
 */
export function useReportRange(): UseReportRange {
  // Read the validated `/reports` search loosely (`strict: false` returns the
  // cross-route union); we own the shape via `validateReportsSearch`, so we
  // narrow it (same approach as `useBudgetMonth`).
  const rawSearch = useSearch({ strict: false }) as ReportsSearch
  const navigate = useNavigate()

  const range = useMemo(() => searchToReportRange(rawSearch), [rawSearch])

  const setRange = useCallback(
    (next: ReportsRange) => {
      void navigate({
        to: '/reports',
        search: (() => rangeToReportsSearch(next)) as unknown as ReportsSearch,
        replace: true,
      })
    },
    [navigate],
  )

  return { range, setRange }
}
