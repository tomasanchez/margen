/**
 * Viewing-month provider (ADR-040).
 *
 * Holds the single shared "viewing month" state the app shell wraps around its
 * body so the top-bar {@link MonthSwitcher} (writer) and the routed Home
 * dashboard (reader) stay in sync. Defaults to the current real calendar month,
 * resolved once at mount; `initialMonth` lets tests pin a deterministic month.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { MonthContext, type MonthContextValue } from './monthContext'
import {
  clampViewingMonth,
  currentViewingMonth,
  type ViewingMonth,
} from './months'

export function MonthProvider({
  children,
  initialMonth,
}: {
  children: ReactNode
  initialMonth?: ViewingMonth
}) {
  // Clamp the seed (and every later write) into the reachable
  // [lowerBound, upperBound] window so the shared state can never sit on a
  // future or older-than-6-months month (ADR-041).
  const [viewingMonth, setViewingMonthRaw] = useState<ViewingMonth>(() =>
    clampViewingMonth(initialMonth ?? currentViewingMonth()),
  )

  const setViewingMonth = useCallback((next: ViewingMonth) => {
    setViewingMonthRaw(clampViewingMonth(next))
  }, [])

  const value = useMemo<MonthContextValue>(
    () => ({ viewingMonth, setViewingMonth }),
    [viewingMonth, setViewingMonth],
  )

  return <MonthContext.Provider value={value}>{children}</MonthContext.Provider>
}

export default MonthProvider
