/**
 * Form state + derivations for the shared Add/Edit transaction form (ADR-017).
 *
 * Kept in a non-component module so `AddEditForm.tsx` only exports components
 * (Fast-Refresh friendly). This hook owns the controlled field state, seeds it
 * from a prefill (add-shortcut `type`/`kind` or a full Edit patch), and exposes
 * the derived FX figures and the assembled `NewTransactionInput` for save.
 *
 * Money convention (mock/types.ts): `amountNum` is ALWAYS the ARS-equivalent
 * magnitude. For USD entries we store the original `usd` + `rate` and compute
 * `amountNum = round(usd * rate)`; for ARS, `amountNum` is the entered value.
 */

import { useMemo, useState } from 'react'
import { MEP_RATE } from '../../mock/seed'
import type {
  Bank,
  Category,
  Currency,
  NewTransactionInput,
  TxType,
} from '../../mock/types'
import type { AddPrefill } from './addContext'

/** Categories shown as expense chips (everything pickable except `Income`). */
export const EXPENSE_CATEGORIES: readonly Category[] = [
  'Food',
  'Rent',
  'Transport',
  'Subscriptions',
  'Health',
  'Shopping',
  'Services',
  'Taxes',
  'Other',
] as const

/** Default category when none is supplied (matches the concept's `Food`). */
const DEFAULT_CATEGORY: Category = 'Food'
/** Default bank/card when none is supplied. */
const DEFAULT_BANK: Bank = 'Galicia · Visa'

/** Today's short display date, e.g. "Jun 13" (the concept's "Today · …" label). */
export function todayDispDate(): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: '2-digit',
  }).format(new Date())
}

/**
 * Today as an ISO `YYYY-MM-DD` string in LOCAL time (the client clock, ADR-041).
 * Used as the date picker's default and its `max` (no future-dated transactions).
 * Local parts avoid the UTC off-by-one `toISOString()` would cause near midnight.
 */
export function todayIsoDate(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Short display date ("Jun 13") for an ISO `YYYY-MM-DD` date. Parsed as a local
 * date (noon, to dodge timezone edges) so the label matches the picked day.
 */
export function isoToDispDate(iso: string): string {
  const [y, m, d] = iso.split('-').map((part) => Number.parseInt(part, 10))
  if (!y || !m || !d) return iso
  const date = new Date(y, m - 1, d, 12)
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: '2-digit',
  }).format(date)
}

/**
 * Parse an es-AR-ish numeric string into a number. Accepts grouping dots and a
 * decimal comma OR a plain decimal point; strips anything else. Empty/garbage
 * yields `NaN` so callers can treat it as "no amount yet".
 */
export function parseAmountInput(raw: string): number {
  const cleaned = raw
    .replace(/\s/g, '')
    .replace(/[^\d.,]/g, '')
  if (cleaned === '') return Number.NaN
  // If both separators appear, the last one is the decimal separator.
  const lastComma = cleaned.lastIndexOf(',')
  const lastDot = cleaned.lastIndexOf('.')
  let normalized: string
  if (lastComma > -1 && lastDot > -1) {
    const decimalSep = lastComma > lastDot ? ',' : '.'
    const groupSep = decimalSep === ',' ? '.' : ','
    normalized = cleaned
      .split(groupSep)
      .join('')
      .replace(decimalSep, '.')
  } else if (lastComma > -1) {
    // Comma only: treat as decimal separator (es-AR), drop none.
    normalized = cleaned.replace(',', '.')
  } else {
    normalized = cleaned
  }
  const value = Number(normalized)
  return Number.isFinite(value) ? value : Number.NaN
}

/** Whether the prefill describes an edit (carries a row id) vs an add. */
export function isEditPrefill(prefill: AddPrefill | null): boolean {
  return typeof prefill?.id === 'string'
}

export interface AddEditFormState {
  /** Edit mode if an id was prefilled; otherwise add mode. */
  readonly mode: 'add' | 'edit'
  readonly editId: string | undefined

  readonly type: TxType
  setType: (next: TxType) => void

  /** Whether income should be recorded as an invoice (counts toward Monotributo). */
  readonly countsTowardMonotributo: boolean
  setCountsTowardMonotributo: (next: boolean) => void

  /** Raw amount string as typed (es-AR-ish); store the numeric via `amount`. */
  readonly amountText: string
  setAmountText: (next: string) => void
  /** Parsed numeric amount in the selected currency (NaN when blank/invalid). */
  readonly amount: number

  readonly currency: Currency
  setCurrency: (next: Currency) => void

  /** MEP rate used for USD→ARS (default {@link MEP_RATE}; user-overridable). */
  readonly rate: number
  /** Raw rate-override string (kept so the field can be cleared mid-edit). */
  readonly rateText: string
  setRateText: (next: string) => void

  readonly category: Category
  setCategory: (next: Category) => void

  readonly bank: Bank
  setBank: (next: Bank) => void

  /** ISO `YYYY-MM-DD` date from the picker (default today; prefilled on edit). */
  readonly occurredOn: string
  setOccurredOn: (next: string) => void
  /** Today as ISO `YYYY-MM-DD` — the picker's `max` (no future dates). */
  readonly maxOccurredOn: string
  /** Short display label derived from `occurredOn`, e.g. "Jun 13". */
  readonly dispDate: string

  readonly notes: string
  setNotes: (next: string) => void

  /** ARS-equivalent magnitude for the current entry (USD→ARS when needed). */
  readonly amountArs: number
  /** True when USD is selected but the rate is missing/invalid. */
  readonly usdRateMissing: boolean
  /** Save is allowed: a positive amount and a category are present. */
  readonly canSave: boolean

  /** Assemble the mutation input from the current state. */
  buildInput: () => NewTransactionInput
}

/**
 * Build the controlled form state, seeded once from `prefill`. The hook is
 * remounted (via a `key` on the form) whenever the flow opens with a new
 * prefill, so seeding in `useState` initializers is sufficient and avoids effect
 * churn.
 */
export function useAddEditFormState(
  prefill: AddPrefill | null,
): AddEditFormState {
  const mode = isEditPrefill(prefill) ? 'edit' : 'add'
  const editId = typeof prefill?.id === 'string' ? prefill.id : undefined

  const [type, setType] = useState<TxType>(prefill?.type ?? 'expense')
  const [countsTowardMonotributo, setCountsTowardMonotributo] =
    useState<boolean>(prefill?.kind === 'invoice')

  const [currency, setCurrency] = useState<Currency>(
    prefill?.currency ?? 'ARS',
  )

  // Seed the amount field: USD rows show their original USD figure, ARS rows
  // show the ARS magnitude. Add prefills usually have no amount.
  const seededAmount =
    prefill?.currency === 'USD'
      ? prefill?.usd
      : prefill?.amountNum
  const [amountText, setAmountText] = useState<string>(
    typeof seededAmount === 'number' ? String(seededAmount) : '',
  )

  const [rateText, setRateText] = useState<string>(
    typeof prefill?.rate === 'number' ? String(prefill.rate) : String(MEP_RATE),
  )

  const [category, setCategory] = useState<Category>(
    prefill?.category && prefill.category !== 'Income'
      ? prefill.category
      : DEFAULT_CATEGORY,
  )
  const [bank, setBank] = useState<Bank>(prefill?.bank ?? DEFAULT_BANK)
  const [notes, setNotes] = useState<string>('')

  // Date picker: ISO YYYY-MM-DD. New transactions default to today; edits
  // prefill from the row's occurredOn (ADR-041). `max` is today (no future).
  const maxOccurredOn = todayIsoDate()
  const [occurredOn, setOccurredOn] = useState<string>(
    prefill?.occurredOn ?? maxOccurredOn,
  )
  const dispDate = isoToDispDate(occurredOn)

  const amount = useMemo(() => parseAmountInput(amountText), [amountText])
  const rate = useMemo(() => {
    const parsed = parseAmountInput(rateText)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.NaN
  }, [rateText])

  const usdRateMissing = currency === 'USD' && !Number.isFinite(rate)

  const amountArs = useMemo(() => {
    if (!Number.isFinite(amount) || amount <= 0) return Number.NaN
    if (currency === 'USD') {
      if (!Number.isFinite(rate)) return Number.NaN
      return Math.round(amount * rate)
    }
    return Math.round(amount)
  }, [amount, currency, rate])

  const canSave =
    Number.isFinite(amount) &&
    amount > 0 &&
    !usdRateMissing &&
    Number.isFinite(amountArs)

  const buildInput = (): NewTransactionInput => {
    const kind =
      type === 'expense'
        ? 'expense'
        : countsTowardMonotributo
          ? 'invoice'
          : 'income'

    const base: NewTransactionInput = {
      name: prefill?.name ?? deriveName(type, kind, category),
      type,
      kind,
      currency,
      category: type === 'income' ? 'Income' : category,
      bank,
      // The picker's ISO date is the source of truth sent as occurredOn; the
      // backend derives the month from it (ADR-041), so no `month` override is
      // passed. `dispDate` is the derived display label.
      occurredOn,
      dispDate,
      amountNum: Math.round(amountArs),
      countsTowardMonotributo: type === 'income' && countsTowardMonotributo,
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...(prefill?.recurring !== undefined
        ? { recurring: prefill.recurring }
        : {}),
    }

    if (currency === 'USD') {
      base.usd = amount
      base.rate = rate
    } else {
      // Editing a USD row down to ARS must clear the stale FX figures. The patch
      // is spread over the existing row, so set them explicitly to undefined.
      base.usd = undefined
      base.rate = undefined
    }

    return base
  }

  return {
    mode,
    editId,
    type,
    setType,
    countsTowardMonotributo,
    setCountsTowardMonotributo,
    amountText,
    setAmountText,
    amount,
    currency,
    setCurrency,
    rate,
    rateText,
    setRateText,
    category,
    setCategory,
    bank,
    setBank,
    occurredOn,
    setOccurredOn,
    maxOccurredOn,
    dispDate,
    notes,
    setNotes,
    amountArs,
    usdRateMissing,
    canSave,
    buildInput,
  }
}

/**
 * Fallback display name when none was supplied (add flow). Mirrors the concept's
 * labels so a freshly-added row reads sensibly in the list.
 */
function deriveName(
  type: TxType,
  kind: NewTransactionInput['kind'],
  category: Category,
): string {
  if (type === 'income') {
    return kind === 'invoice' ? 'Invoice · income' : 'Income'
  }
  return category
}
