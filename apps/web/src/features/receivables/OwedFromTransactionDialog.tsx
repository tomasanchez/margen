/**
 * "Someone owes me this" — start a receivable from an expense row (ADR-220).
 *
 * Opened from a transaction row's actions menu, this is the item form
 * ({@link ReceivableItemForm}) with NO person yet — so its person picker asks who
 * owes it (an existing person, or a new name created on save) — PREFILLED from
 * the expense: its date, its name as the detail, the link to it (reference only,
 * ADR-219) and, when the expense is itself a card cuota (ADR-174), a cuota plan
 * with the same count. The expense's amount seeds the debt only for a one-off
 * expense: for a cuota the amount is ONE card cuota, so the total is left to the
 * owner (the form shows the per-cuota amount as a hint).
 *
 * Saving refreshes the whole receivables tree (the save hook invalidates it), so
 * the Owed tab is current the next time it's opened.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Transaction } from '../../mock/types'
import { linkedExpenseFromTransaction, suggestedCuotaCount } from './linking'
import {
  ReceivableItemForm,
  type ReceivableItemPrefill,
  type ReceivableItemSaved,
} from './ReceivableItemForm'

export interface OwedFromTransactionDialogProps {
  /** The expense the debt comes from. */
  transaction: Transaction
  /** Dismiss the dialog. */
  onClose: () => void
  /** Called once the debt is saved (e.g. to show a confirmation). */
  onSaved?: (saved: ReceivableItemSaved) => void
}

/** Build the item-form prefill for an expense (ADR-220). */
function prefillFor(transaction: Transaction): ReceivableItemPrefill {
  const link = linkedExpenseFromTransaction(transaction)
  const cuotas = suggestedCuotaCount(link)
  return {
    occurredOn: transaction.occurredOn,
    // A card cuota's amount is one cuota, not the debt — leave the total open.
    amount: cuotas === null ? link.amount : undefined,
    detail: transaction.name,
    link,
    installmentsCount: cuotas,
  }
}

export function OwedFromTransactionDialog({
  transaction,
  onClose,
  onSaved,
}: OwedFromTransactionDialogProps) {
  const { t } = useTranslation('receivables')
  // Seeded once per open — the form reads its prefill only on mount.
  const [prefill] = useState(() => prefillFor(transaction))
  return (
    <ReceivableItemForm
      open
      personId={null}
      item={null}
      prefill={prefill}
      title={t('fromTransaction.title')}
      onClose={onClose}
      onSaved={onSaved}
    />
  )
}

export default OwedFromTransactionDialog
