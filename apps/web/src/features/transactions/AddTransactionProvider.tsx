import { useCallback, useMemo, useState, type ReactNode } from 'react'
import {
  AddTransactionContext,
  type AddPrefill,
  type AddTransactionContextValue,
} from './addContext'
import { AddEditTransaction } from './AddEditTransaction'

/**
 * Holds the Add/Edit flow open-state seam (ADR-017).
 *
 * Tracks `isOpen` + `prefill` for the shell's CTA/FAB and Home/Transactions
 * triggers, and renders the shared Add/Edit form ({@link AddEditTransaction}) as
 * a sibling of `children`: a centered Dialog on desktop, a bottom Drawer on
 * mobile, gated on `isOpen`, prefilled from `prefill`, closing via `closeAdd`.
 * No shell code changes — the seam (addContext) is unchanged.
 */
export function AddTransactionProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
  const [prefill, setPrefill] = useState<AddPrefill | null>(null)

  const openAdd = useCallback((next?: AddPrefill) => {
    setPrefill(next ?? null)
    setIsOpen(true)
  }, [])

  const closeAdd = useCallback(() => {
    setIsOpen(false)
    setPrefill(null)
  }, [])

  const value = useMemo<AddTransactionContextValue>(
    () => ({ isOpen, prefill, openAdd, closeAdd }),
    [isOpen, prefill, openAdd, closeAdd],
  )

  return (
    <AddTransactionContext.Provider value={value}>
      {children}
      <AddEditTransaction />
    </AddTransactionContext.Provider>
  )
}
