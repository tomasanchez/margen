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
 * Tracks `isOpen` + `prefill` for the shell's CTA / mobile FAB and the
 * Home/Transactions add shortcuts. The ARCA invoice import now lives ON the
 * invoice input inside the Add/Edit form itself (ADR-072): the upload parses,
 * autofills the form fields, and the user reviews + decides whether to save, so
 * the provider no longer owns the parse flow. The shared form
 * ({@link AddEditTransaction}) renders as a sibling of `children`.
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
    () => ({
      isOpen,
      prefill,
      openAdd,
      closeAdd,
    }),
    [isOpen, prefill, openAdd, closeAdd],
  )

  return (
    <AddTransactionContext.Provider value={value}>
      {children}
      <AddEditTransaction />
    </AddTransactionContext.Provider>
  )
}
