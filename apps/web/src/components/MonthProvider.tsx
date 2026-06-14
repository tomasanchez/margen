/**
 * Viewing-month provider (ADR-040).
 *
 * Holds the single shared "viewing month" state the app shell wraps around its
 * body so the top-bar {@link MonthSwitcher} (writer) and the routed Home
 * dashboard (reader) stay in sync. Defaults to the current real calendar month,
 * resolved once at mount; `initialMonth` lets tests pin a deterministic month.
 */

import { useMemo, useState, type ReactNode } from 'react'
import { MonthContext, type MonthContextValue } from './monthContext'
import { currentViewingMonth, type ViewingMonth } from './months'

export function MonthProvider({
  children,
  initialMonth,
}: {
  children: ReactNode
  initialMonth?: ViewingMonth
}) {
  const [viewingMonth, setViewingMonth] = useState<ViewingMonth>(
    () => initialMonth ?? currentViewingMonth(),
  )

  const value = useMemo<MonthContextValue>(
    () => ({ viewingMonth, setViewingMonth }),
    [viewingMonth],
  )

  return <MonthContext.Provider value={value}>{children}</MonthContext.Provider>
}

export default MonthProvider
