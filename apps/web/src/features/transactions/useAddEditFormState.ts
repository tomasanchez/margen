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
 * `amountNum = round(usd * rate, 2)`; for ARS, `amountNum` is the entered value.
 *
 * USD FX (ADR-044/045): the rate is no longer a hardcoded default. When USD is
 * selected (and on open for a USD edit without a stored rate) the form fetches
 * SUGGESTED MEP + official rates from dolarapi.com in parallel. The user picks
 * the source via an explicit selector — MEP / Official / Manual: picking a
 * suggested source pre-fills its value and sets `fxRateType = 'MEP' | 'official'`;
 * typing a value (or picking Manual) sets `fxRateType = 'manual'`. The rate is
 * REQUIRED before a USD transaction can be saved (revisits ADR-031 for the UI).
 * If both fetches fail, the user must enter a rate manually — never a silent guess.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchSuggestedRates } from '../../api/fxClient'
import type {
  Bank,
  Category,
  Currency,
  FxRateType,
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
 * Convert an ISO `YYYY-MM-DD` date to an ISO datetime (`fx_rate_as_of`, ADR-044).
 * We anchor at local noon then serialize to UTC so the calendar day is stable
 * across timezones; an empty/garbage date falls back to "now".
 */
export function isoDateToAsOf(iso: string): string {
  const [y, m, d] = iso.split('-').map((part) => Number.parseInt(part, 10))
  if (!y || !m || !d) return new Date().toISOString()
  return new Date(y, m - 1, d, 12).toISOString()
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

/** Round to 2 decimals, the ARS-equivalent precision sent as `amountNum`. */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Loading status of the suggested-rate fetch (ADR-045 affordances). `suggested`
 * means at least one of the two rates (MEP / official) came back; `failed` means
 * both were null (require manual entry).
 */
export type RateSuggestionStatus = 'idle' | 'loading' | 'suggested' | 'failed'

/**
 * Explicit FX rate source the user selected (ADR-044 update). Maps 1:1 to the
 * persisted `FxRateType` ('MEP' | 'official' | 'manual').
 */
export type FxSource = 'MEP' | 'official' | 'manual'

/** The two suggested values fetched from dolarapi.com (null until fetched / on failure). */
export interface SuggestedRateValues {
  readonly MEP: number | null
  readonly official: number | null
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

  /** Parsed FX rate used for USD→ARS (NaN when missing/invalid). */
  readonly rate: number
  /** Raw rate string (kept so the field can be cleared mid-edit). */
  readonly rateText: string
  setRateText: (next: string) => void
  /** Source of the current rate: `MEP` / `official` (suggested) or `manual`. */
  readonly fxRateType: FxRateType
  /** Explicit user-selected FX source; drives `fxRateType` 1:1 (ADR-044 update). */
  readonly fxSource: FxSource
  /**
   * Pick the FX source. Selecting `MEP`/`official` pre-fills that suggested
   * value (when available); selecting `manual` keeps the current rate text but
   * marks it user-owned.
   */
  setFxSource: (next: FxSource) => void
  /** Both suggested values so the UI can label and enable/disable each option. */
  readonly suggestedRates: SuggestedRateValues
  /** Status of the suggested-rate fetch (drives the loading/refresh/fail hint). */
  readonly rateSuggestionStatus: RateSuggestionStatus
  /** Re-fetch both suggested rates and re-apply the current non-manual source. */
  refreshSuggestedRate: () => void

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
  /** Save is allowed: a positive amount, a present rate for USD, etc. */
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

  // The rate field starts EMPTY (no hardcoded default, ADR-044). An edit prefills
  // the stored rate; an add leaves it blank until the suggestion arrives.
  const [rateText, setRateTextRaw] = useState<string>(
    typeof prefill?.rate === 'number' ? String(prefill.rate) : '',
  )

  // Both suggested values once fetched (null until then / on failure).
  const [suggestedRates, setSuggestedRates] = useState<SuggestedRateValues>({
    MEP: null,
    official: null,
  })
  const [rateSuggestionStatus, setRateSuggestionStatus] =
    useState<RateSuggestionStatus>('idle')

  // The explicit FX source the user selected (ADR-044 update). Defaults to the
  // prefill's stored source on an edit (preserved until the rate is edited),
  // else MEP — the form will fall back to official if MEP is unavailable.
  const seededFxSource: FxSource =
    prefill?.fxRateType === 'official'
      ? 'official'
      : prefill?.fxRateType === 'manual'
        ? 'manual'
        : 'MEP'
  const [fxSource, setFxSourceRaw] = useState<FxSource>(seededFxSource)

  // Whether the user has touched the rate field (an explicit manual override).
  // Editing an existing row's stored rate also counts as manual.
  const [rateEdited, setRateEdited] = useState<boolean>(false)

  const setRateText = useCallback((next: string) => {
    setRateTextRaw(next)
    // Typing a rate always flips the source to manual (ADR-044 update): the
    // entered value is user-owned, no longer a suggested MEP/official figure.
    setRateEdited(true)
    setFxSourceRaw('manual')
  }, [])

  // Pick a source explicitly. MEP/official pre-fill that suggested value (when
  // available) and clear the "edited" flag so it counts as a confirmed
  // suggestion; manual keeps the current text but marks it user-owned.
  const setFxSource = useCallback(
    (next: FxSource) => {
      setFxSourceRaw(next)
      if (next === 'manual') {
        setRateEdited(true)
        return
      }
      const value = suggestedRates[next]
      if (value !== null) {
        setRateTextRaw(String(value))
        setRateEdited(false)
      }
    },
    [suggestedRates],
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

  // Fetch BOTH suggested rates in parallel and pre-fill the active non-manual
  // source when they land. Only pre-fills when the user has not already typed a
  // rate, so a refresh never clobbers an edit. `applyDefault` (true on the first
  // auto-fetch) picks MEP, falling back to official when MEP is unavailable.
  const fetchToken = useRef(0)
  const fetchSuggestion = useCallback(
    async (applyDefault: boolean) => {
      const token = ++fetchToken.current
      setRateSuggestionStatus('loading')
      const { mep, official } = await fetchSuggestedRates()
      // Ignore a stale response if a newer fetch (or unmount) superseded it.
      if (token !== fetchToken.current) return
      setSuggestedRates({ MEP: mep, official })
      if (mep === null && official === null) {
        // Both failed → require manual entry, no silent default (ADR-044/045).
        setRateSuggestionStatus('failed')
        return
      }
      setRateSuggestionStatus('suggested')
      // Pre-fill only if the user hasn't entered/edited a rate yet (ADR-045).
      setRateEdited((edited) => {
        if (edited) return edited
        if (applyDefault) {
          // First fetch: pick the default source (MEP, falling back to official).
          const next: FxSource = mep !== null ? 'MEP' : 'official'
          const value = next === 'MEP' ? mep : official
          setFxSourceRaw(next)
          if (value !== null) setRateTextRaw(String(value))
        } else {
          // Refresh: re-apply the currently selected non-manual source's value.
          setFxSourceRaw((source) => {
            if (source === 'manual') return source
            const value = source === 'MEP' ? mep : official
            if (value !== null) setRateTextRaw(String(value))
            return source
          })
        }
        return edited
      })
    },
    [],
  )

  // On switching to USD (or opening a USD entry without a stored rate), fetch
  // the suggestions. This is a one-shot external adapter call (ADR-044), not the
  // app's own server state, so a focused effect is appropriate here.
  useEffect(() => {
    if (currency !== 'USD') return
    // An edit that already carries a stored rate keeps it; don't auto-suggest.
    if (rateEdited) return
    if (typeof prefill?.rate === 'number') return
    if (rateSuggestionStatus !== 'idle') return
    // Fetching suggested rates from dolarapi.com is a legitimate effect: it
    // synchronizes the form with an external system (ADR-044). The loading
    // setState it triggers is the sanctioned "subscribe/fetch" case, not a
    // render-cascade, so the rule is scoped-off for this trigger only.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchSuggestion(true)
  }, [
    currency,
    rateEdited,
    prefill?.rate,
    rateSuggestionStatus,
    fetchSuggestion,
  ])

  const refreshSuggestedRate = useCallback(() => {
    // A manual refresh re-fetches both rates and re-applies the current
    // non-manual source's fresh value, clearing the "edited" flag so it pre-fills
    // (the user explicitly asked for the suggestion). If the source is manual,
    // the value is kept and only the suggested option labels refresh.
    setRateEdited((edited) => (fxSource === 'manual' ? edited : false))
    void fetchSuggestion(false)
  }, [fetchSuggestion, fxSource])

  const usdRateMissing = currency === 'USD' && !Number.isFinite(rate)

  // The persisted source maps 1:1 from the explicit selection (ADR-044 update).
  const fxRateType: FxRateType = fxSource

  const amountArs = useMemo(() => {
    if (!Number.isFinite(amount) || amount <= 0) return Number.NaN
    if (currency === 'USD') {
      if (!Number.isFinite(rate)) return Number.NaN
      return round2(amount * rate)
    }
    return round2(amount)
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
      amountNum: round2(amountArs),
      countsTowardMonotributo: type === 'income' && countsTowardMonotributo,
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...(prefill?.recurring !== undefined
        ? { recurring: prefill.recurring }
        : {}),
    }

    if (currency === 'USD') {
      base.usd = amount
      base.rate = rate
      base.fxRateType = fxRateType
      // The rate applies as-of the transaction's own date (ADR-044).
      base.fxRateAsOf = isoDateToAsOf(occurredOn)
    } else {
      // Editing a USD row down to ARS must clear the stale FX figures. The patch
      // is spread over the existing row, so set them explicitly to undefined.
      base.usd = undefined
      base.rate = undefined
      base.fxRateType = undefined
      base.fxRateAsOf = undefined
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
    fxRateType,
    fxSource,
    setFxSource,
    suggestedRates,
    rateSuggestionStatus,
    refreshSuggestedRate,
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
