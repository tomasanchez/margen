/**
 * Shared viewing-month context seam (ADR-040).
 *
 * The context + hook live in this non-component module (mirroring `addContext`)
 * so the provider component can live in its own file and Fast Refresh stays
 * happy (component files export only components). The app shell wraps the routed
 * content in {@link MonthProvider} and writes the selected month from the top-bar
 * {@link MonthSwitcher} (desktop stepper + mobile picker share this single
 * source). Home reads it via {@link useViewingMonth} to filter its
 * real-transaction metrics and recent activity by year+month.
 *
 * The mock panels (trend / breakdown / insights / Monotributo) do NOT consume
 * this — they stay non-reactive until #6/#8 (ADR-035).
 */

import { createContext, useContext } from 'react'
import type { ViewingMonth } from './months'

export interface MonthContextValue {
  /** The currently viewed calendar month (default: the current real month). */
  viewingMonth: ViewingMonth
  /** Replace the viewed month (used by both switcher presentations). */
  setViewingMonth: (next: ViewingMonth) => void
}

export const MonthContext = createContext<MonthContextValue | null>(null)

/** Read the shared viewing month. Throws if used outside a {@link MonthProvider}. */
export function useViewingMonth(): MonthContextValue {
  const ctx = useContext(MonthContext)
  if (ctx === null) {
    throw new Error('useViewingMonth must be used within a MonthProvider')
  }
  return ctx
}
