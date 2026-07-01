import { createContext, useContext } from 'react'
import type { NewTransactionInput } from '../../mock/types'

/**
 * Prefill passed to the Add/Edit flow when it opens (ADR-017).
 *
 * The real form (a later task) reads this to pre-populate fields — e.g. the Home
 * "Expense"/"Invoice" shortcuts open the flow with `type`/`kind` pre-selected,
 * and Edit opens it with the full transaction patched in. A partial of the
 * new-transaction input keeps the seam compatible with the eventual form.
 */
export type AddPrefill = Partial<NewTransactionInput> & {
  /**
   * Present only when the flow is opened to EDIT an existing row (set by
   * `buildEditPrefill`). The form reads it to decide between the add and update
   * mutations; add-shortcut prefills omit it. Additive to the
   * `NewTransactionInput` shape, so the seam stays input-compatible.
   */
  id?: string
  /**
   * Display-only summary of the EXPENSE a reimbursement offsets (ADR-159), set by
   * `buildReimbursementPrefill` when the flow is opened from an expense's "add
   * reimbursement" action. The form shows it so the user sees which expense the
   * payback pays back; it is NOT sent to the backend (the link travels via
   * `offsetsTransactionId`). Absent for every non-reimbursement flow.
   */
  offsetsExpense?: {
    /** The linked expense's display name. */
    name: string
    /** The linked expense's ARS-equivalent magnitude (a positive number). */
    amountNum: number
  }
}

export interface AddTransactionContextValue {
  /** Whether the Add/Edit flow is currently open. */
  isOpen: boolean
  /** The prefill the flow was opened with, if any. */
  prefill: AddPrefill | null
  /** Open the Add/Edit flow, optionally with a prefill. */
  openAdd: (prefill?: AddPrefill) => void
  /** Close the Add/Edit flow. */
  closeAdd: () => void
}

/**
 * Add-transaction flow seam (ADR-017).
 *
 * This context is the single integration point between the shell's triggers
 * (sidebar CTA, mobile FAB, future Home shortcuts) and the Add/Edit flow. The
 * flow itself is NOT implemented yet — `AddTransactionProvider` only tracks
 * open state and prefill. The later task renders the real Dialog (desktop) /
 * Drawer (mobile) form by reading `isOpen` + `prefill` from this context and
 * calling `closeAdd` on submit/cancel. Nothing about the shell wiring changes
 * when the form lands.
 *
 * Kept in a non-component module so the provider component file stays
 * Fast-Refresh-friendly (it must only export components).
 */
export const AddTransactionContext =
  createContext<AddTransactionContextValue | null>(null)

/** Access the Add-transaction flow controls. Must be used under the provider. */
export function useAddTransaction(): AddTransactionContextValue {
  const ctx = useContext(AddTransactionContext)
  if (!ctx) {
    throw new Error(
      'useAddTransaction must be used within an AddTransactionProvider',
    )
  }
  return ctx
}
