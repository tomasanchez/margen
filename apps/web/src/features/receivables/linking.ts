/**
 * Pure helpers for the receivable → expense REFERENCE link (ADR-217…220).
 *
 * The link is display/traceability only — it never nets against net worth,
 * budgets or category spend (ADR-219). These helpers build the link's view model
 * from either entry point (the Owed item form's picker, or a transaction row's
 * "Someone owes me this" action, ADR-220), compute the non-blocking over-split
 * warning (ADR-218), and build the deep link back to the expense in the
 * transactions list. React-free so the rules are unit-testable.
 */

import type { TFunction } from 'i18next'
import type { SourceTransaction } from '../../api/receivablesClient'
import { formatCurrency, formatUSD } from '../../lib/format'
import type { Transaction } from '../../mock/types'
import {
  MAX_INSTALLMENTS,
  MIN_INSTALLMENTS,
  centsToDecimal,
  decimalToCents,
  toCents,
} from './installments'

/**
 * The expense an item form links to. Same shape as the API's
 * {@link SourceTransaction}, except `linkedItemsTotal` may be UNKNOWN (null) —
 * when the link was seeded from a transactions-list row, which doesn't carry
 * it; the form then looks it up (ADR-218).
 */
export type LinkedExpense = Omit<SourceTransaction, 'linkedItemsTotal'> & {
  linkedItemsTotal: string | null
}

/**
 * What an expense stands for in full, in cents (ADR-218): one card cuota's amount
 * × its plan length (ADR-174), else the amount itself — the server's `planTotal`.
 */
export function planTotalCents(
  expense: Pick<SourceTransaction, 'amount' | 'installmentsTotal'>,
): number {
  const total = expense.installmentsTotal
  const cuotas = total != null && Number.isInteger(total) && total > 1 ? total : 1
  return decimalToCents(expense.amount) * cuotas
}

/**
 * Build a {@link LinkedExpense} from a transactions-list row (the ADR-220
 * "Someone owes me this" entry point). `amountNum` is the row's ARS-equivalent
 * magnitude — receivables are ARS-only (ADR-204) — and the row's own card-cuota
 * shape (ADR-174) rides along to seed the cuota count; `planTotal` is derived the
 * way the server derives it.
 */
export function linkedExpenseFromTransaction(
  transaction: Transaction,
): LinkedExpense {
  const amount = centsToDecimal(toCents(transaction.amountNum) ?? 0)
  const installmentsTotal = transaction.installmentsTotal ?? null
  return {
    id: transaction.id,
    name: transaction.name,
    occurredOn: transaction.occurredOn,
    amount,
    currency: transaction.currency,
    usdAmount:
      transaction.currency === 'USD' && transaction.usd !== undefined
        ? String(transaction.usd)
        : null,
    installmentsIndex: transaction.installmentsIndex ?? null,
    installmentsTotal,
    planTotal: centsToDecimal(planTotalCents({ amount, installmentsTotal })),
    linkedItemsTotal: null,
  }
}

/**
 * The cuota count an expense's own card plan suggests for the debtor's plan
 * (ADR-220): its `installmentsTotal`, when it is a plan the API accepts (≥ 2,
 * capped at 120). Null for a one-off expense.
 */
export function suggestedCuotaCount(
  expense: Pick<SourceTransaction, 'installmentsTotal'> | null,
): number | null {
  const total = expense?.installmentsTotal
  if (total == null || !Number.isInteger(total) || total < MIN_INSTALLMENTS) {
    return null
  }
  return Math.min(total, MAX_INSTALLMENTS)
}

/**
 * What OTHER items already link `expense`, in cents (ADR-218). The server's
 * `linkedItemsTotal` includes the item being edited when it already links the
 * same expense, so that item's saved amount is subtracted back out. Null when
 * the total is unknown.
 */
export function linkedOthersCents(
  expense: LinkedExpense,
  editing: { linkedExpenseId: string | null; amount: string } | null,
): number | null {
  if (expense.linkedItemsTotal === null) return null
  const total = decimalToCents(expense.linkedItemsTotal)
  const own =
    editing && editing.linkedExpenseId === expense.id
      ? decimalToCents(editing.amount)
      : 0
  return Math.max(total - own, 0)
}

/**
 * The non-blocking over-split check (ADR-218): would the items linking this
 * expense — the others plus this one — add up to MORE than what the expense
 * stands for in full (its `planTotal`: the whole card purchase for a cuota, not
 * the single cuota)? Returns the combined total (cents) when they would, else null.
 */
export function overLinkedTotalCents(
  expense: LinkedExpense,
  othersCents: number | null,
  thisAmountCents: number,
): number | null {
  if (othersCents === null || thisAmountCents <= 0) return null
  const combined = othersCents + thisAmountCents
  return combined > decimalToCents(expense.planTotal) ? combined : null
}

/**
 * The `/transactions` search that surfaces a linked expense (ADR-116): there is
 * no per-transaction deep link, so we filter by its NAME within its MONTH
 * (`YYYY-MM`), which narrows the ledger to the expense (and any same-named rows
 * that month).
 */
export function transactionsSearchFor(
  expense: Pick<SourceTransaction, 'name' | 'occurredOn'>,
): { q: string; month: string } {
  return { q: expense.name, month: expense.occurredOn.slice(0, 7) }
}

/** Parse a Decimal string to a number for the display edge (0 on a bad value). */
function num(value: string | null): number {
  const parsed = Number.parseFloat(value ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * The one-line summary of an expense: date · ARS amount (+ the original USD for a
 * USD expense) · its own card cuota ("Cuota 3/6", ADR-174) when it has one.
 * Shared by the link picker's options, its selected value, and the item list.
 */
export function describeExpense(
  expense: LinkedExpense,
  t: TFunction<'receivables'>,
): string {
  let amount = formatCurrency(num(expense.amount), 'ARS')
  if (expense.currency === 'USD' && expense.usdAmount !== null) {
    amount += ` (USD ${formatUSD(num(expense.usdAmount))})`
  }
  const parts = [expense.occurredOn, amount]
  if (expense.installmentsTotal) {
    parts.push(
      expense.installmentsIndex
        ? t('link.cuota', {
            index: expense.installmentsIndex,
            count: expense.installmentsTotal,
          })
        : t('link.cuotaPlan', { count: expense.installmentsTotal }),
    )
    // The whole purchase, so a card cuota is never mistaken for the total.
    parts.push(
      t('link.planTotal', {
        amount: formatCurrency(num(expense.planTotal), 'ARS'),
      }),
    )
  }
  return parts.join(' · ')
}
