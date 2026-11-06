/**
 * Pure payment-allocation helpers for the receivables payment forms
 * (ADR-206/215/221).
 *
 * A payment is split across a person's open TARGETS: a flat item as a whole, or
 * — for an installment item — each of its open cuotas (the API requires an
 * `installmentId` for those, ADR-221/223). The forms render one editable row per
 * target, prefilled from the server's suggested allocation (due cuotas
 * oldest-first, then flat items newest-first; upcoming cuotas are never
 * suggested). These helpers build the targets in that same fill order, map a
 * suggestion onto them, and turn the edited rows back into the API's
 * `allocations` — React-free so the rules are unit-testable.
 */

import type {
  PaymentAllocationInput,
  ReceivableInstallment,
  ReceivableItem,
  SuggestedAllocation,
} from '../../api/receivablesClient'
import { parseBalance, toDecimalString } from '../accounts/balance'
import { centsToDecimal, decimalToCents, toCents, toInputAmount } from './installments'

/** One row of the allocation editor: a flat item, or one cuota of a plan. */
export interface AllocationTarget {
  /** Stable row key (`itemId:installmentId`). */
  key: string
  item: ReceivableItem
  /** The targeted cuota, or null for a flat item. */
  cuota: ReceivableInstallment | null
  /** True for a cuota not due yet — paying it is an early payment (ADR-215). */
  upcoming: boolean
  /** What is still owed on the target, in cents. */
  remainingCents: number
}

/** The row key for an item (and cuota) — matches suggestion lines to rows. */
export function allocationKey(
  itemId: string,
  installmentId: string | null,
): string {
  return `${itemId}:${installmentId ?? ''}`
}

/**
 * Every open target of a person, in the server's fill order: DUE cuotas (oldest
 * due date first, then the older purchase, then index), then open FLAT items in
 * the person's list order (newest-first), then UPCOMING cuotas by due date.
 * Pardoned items/cuotas and settled ones are not payable and never appear
 * (ADR-210/221).
 */
export function buildAllocationTargets(
  items: readonly ReceivableItem[],
): AllocationTarget[] {
  const due: AllocationTarget[] = []
  const flat: AllocationTarget[] = []
  const upcoming: AllocationTarget[] = []
  for (const item of items) {
    if (item.installments.length === 0) {
      const remainingCents = decimalToCents(item.remaining)
      if (!item.pardoned && remainingCents > 0) {
        flat.push({
          key: allocationKey(item.id, null),
          item,
          cuota: null,
          upcoming: false,
          remainingCents,
        })
      }
      continue
    }
    for (const cuota of item.installments) {
      const remainingCents = decimalToCents(cuota.remaining)
      if (remainingCents <= 0) continue
      if (cuota.status !== 'due' && cuota.status !== 'upcoming') continue
      const target: AllocationTarget = {
        key: allocationKey(item.id, cuota.id),
        item,
        cuota,
        upcoming: cuota.status === 'upcoming',
        remainingCents,
      }
      if (target.upcoming) upcoming.push(target)
      else due.push(target)
    }
  }
  const byDueDate = (a: AllocationTarget, b: AllocationTarget): number => {
    const left = a.cuota as ReceivableInstallment
    const right = b.cuota as ReceivableInstallment
    return (
      left.dueOn.localeCompare(right.dueOn) ||
      a.item.occurredOn.localeCompare(b.item.occurredOn) ||
      a.item.id.localeCompare(b.item.id) ||
      left.index - right.index
    )
  }
  due.sort(byDueDate)
  upcoming.sort(byDueDate)
  return [...due, ...flat, ...upcoming]
}

/**
 * Map a server suggestion onto row keys → the short input text to prefill
 * (`"10000.00"` → `"10000"`). Lines for unknown targets are simply unused.
 */
export function suggestionValues(
  suggestion: SuggestedAllocation | undefined,
): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of suggestion?.allocations ?? []) {
    values[allocationKey(line.itemId, line.installmentId)] = toInputAmount(
      line.amount,
    )
  }
  return values
}

/** Parse a row's typed amount to cents; 0 for blank / invalid / non-positive. */
export function rowCents(raw: string | undefined): number {
  const value = parseBalance(raw ?? '')
  const cents = toCents(value)
  return cents !== null && cents > 0 ? cents : 0
}

/**
 * The API `allocations` for the edited rows: one slice per positive row, with
 * `installmentId` for a cuota and none for a flat item (ADR-221).
 */
export function toAllocations(
  targets: readonly AllocationTarget[],
  values: Readonly<Record<string, string>>,
): PaymentAllocationInput[] {
  const out: PaymentAllocationInput[] = []
  for (const target of targets) {
    const cents = rowCents(values[target.key])
    if (cents <= 0) continue
    const slice: PaymentAllocationInput = {
      itemId: target.item.id,
      amount: centsToDecimal(cents),
    }
    if (target.cuota) slice.installmentId = target.cuota.id
    out.push(slice)
  }
  return out
}

/** Σ of the positive rows, in cents. */
export function allocatedCents(
  targets: readonly AllocationTarget[],
  values: Readonly<Record<string, string>>,
): number {
  return targets.reduce((sum, target) => sum + rowCents(values[target.key]), 0)
}

/** True when any positive row pays an upcoming cuota early (ADR-215). */
export function includesUpcoming(
  targets: readonly AllocationTarget[],
  values: Readonly<Record<string, string>>,
): boolean {
  return targets.some(
    (target) => target.upcoming && rowCents(values[target.key]) > 0,
  )
}

/**
 * Spread `leftoverCents` over the UPCOMING cuotas (earliest due first), on top
 * of what each row already holds, capped at each cuota's remaining. Returns only
 * the rows it changed (as input text) so the caller can merge them as edits —
 * the "apply the rest to upcoming cuotas" shortcut for paying ahead.
 */
export function fillUpcoming(
  targets: readonly AllocationTarget[],
  values: Readonly<Record<string, string>>,
  leftoverCents: number,
): Record<string, string> {
  const changed: Record<string, string> = {}
  let left = leftoverCents
  for (const target of targets) {
    if (left <= 0) break
    if (!target.upcoming) continue
    const current = rowCents(values[target.key])
    const room = target.remainingCents - current
    if (room <= 0) continue
    const take = Math.min(room, left)
    changed[target.key] = toInputAmount(centsToDecimal(current + take))
    left -= take
  }
  return changed
}

/** The target an API conflict names (by item + cuota), if it is one of ours. */
export function findTarget(
  targets: readonly AllocationTarget[],
  itemId: string,
  installmentId: string | null,
): AllocationTarget | undefined {
  return targets.find((target) => target.key === allocationKey(itemId, installmentId))
}

/**
 * Add `cents` on top of whatever a row holds — the "put the rest on…" action,
 * which may deliberately pay a target beyond what it owes (confirmed as a credit
 * through the 409 warning, ADR-206). Returns the row's new input text.
 */
export function addToRow(current: string | undefined, cents: number): string {
  return toInputAmount(centsToDecimal(rowCents(current) + cents))
}

/** A positive typed amount → its Decimal string, or null when not payable. */
export function positiveDecimal(raw: string): string | null {
  const value = parseBalance(raw)
  if (!Number.isFinite(value) || value <= 0) return null
  const text = toDecimalString(value)
  return Number.parseFloat(text) > 0 ? text : null
}

/** True when some UPCOMING cuota can still take money (room under its remaining). */
export function upcomingHasRoom(
  targets: readonly AllocationTarget[],
  values: Readonly<Record<string, string>>,
): boolean {
  return targets.some(
    (target) => target.upcoming && target.remainingCents > rowCents(values[target.key]),
  )
}
