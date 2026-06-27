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
 * typing a value (or picking Manual) sets `fxRateType = 'manual'`. The initial
 * source defaults to the user's configured FX default (settings
 * `fxDefaultRateType`, ADR-057), falling back to MEP when settings haven't
 * loaded; if that source's rate is unavailable it falls back to the other. The
 * rate is REQUIRED before a USD transaction can be saved (revisits ADR-031 for
 * the UI). If both fetches fail, the user must enter a rate manually — never a
 * silent guess.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchSuggestedRates } from '../../api/fxClient'
import { useSettings } from '../settings/queries'
import type { FxDefaultRateType } from '../../api/settingsClient'
import type {
  Bank,
  Category,
  Currency,
  FxRateType,
  NewTransactionInput,
  TxType,
} from '../../mock/types'
import type {
  InvoiceDocumentPayload,
  InvoiceParse,
} from '../../api/invoicesClient'
import type { AddPrefill } from './addContext'

/** Categories shown as expense chips (everything pickable except `Income`). */
export const EXPENSE_CATEGORIES: readonly Category[] = [
  'Food',
  'Rent',
  'Transport',
  'Subscriptions',
  'Health',
  'Shopping',
  'Entertainment',
  'Services',
  'Taxes',
  'Fee',
  'Other',
] as const

/** Default category when none is supplied (matches the concept's `Food`). */
const DEFAULT_CATEGORY: Category = 'Food'
/** Default bank when none is supplied (ADR-117 normalized name). */
const DEFAULT_BANK: Bank = 'Galicia'

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

  /**
   * Optional merchant/client name for the transaction (ADR-088). When non-blank
   * it is the saved `name` — and so the reconciliation match key (ADR-085); when
   * blank, `buildInput` falls back to the category-derived label. Edits seed it
   * from the row's current name; a parsed invoice / the Monotributo cuota autofill
   * populate it (still editable). Distinct from `notes`.
   */
  readonly name: string
  setName: (next: string) => void

  readonly notes: string
  setNotes: (next: string) => void

  /** ARS-equivalent magnitude for the current entry (USD→ARS when needed). */
  readonly amountArs: number
  /** True when USD is selected but the rate is missing/invalid. */
  readonly usdRateMissing: boolean
  /** Save is allowed: a positive amount, a present rate for USD, etc. */
  readonly canSave: boolean

  /**
   * True when the most recently applied ARCA parse flagged the invoice as already
   * imported (ADR-071/072). Drives the calm, non-blocking duplicate warning in
   * the form; saving stays allowed. Reset on each new upload.
   */
  readonly duplicate: boolean

  /** True when a parsed invoice PDF is currently attached (sent on save). */
  readonly hasImportedDocument: boolean
  /**
   * The uploaded invoice's file name (e.g. "invoice.pdf"), shown in the attached
   * -file row so the user sees which file they picked. `null` when nothing is
   * attached. Set alongside `applyParsedInvoice`; cleared on unattach/reset.
   */
  readonly attachedFileName: string | null

  /**
   * Autofill the form from a parsed ARCA invoice (ADR-072). Sets amount, date,
   * currency + the FX block (when USD), name, and category, stashes the base64
   * `document` so `buildInput` attaches it on save, and records the `duplicate`
   * advisory. The optional `fileName` is the picked File's name, surfaced in the
   * attached-file row. The user then reviews/edits and decides whether to save.
   */
  applyParsedInvoice: (parsed: InvoiceParse, fileName?: string) => void

  /**
   * Unattach the uploaded invoice PDF (issue #26 polish): clears the stashed
   * `document`, the file name, and the duplicate advisory — WITHOUT touching the
   * autofilled field values. Saving afterwards creates the transaction with no
   * document. The form's parse-error/upload state is reset by the caller.
   */
  clearImportedDocument: () => void

  /**
   * Autofill the EXPENSE path with the user's monthly Monotributo cuota. Sets the
   * amount to the ARS cuota, forces a plain ARS expense (clearing any FX state),
   * picks the `Taxes` category, and names the row after the configured category
   * (e.g. "Monotributo C"). The button that calls this is shown on the Expense
   * tab only; the caller computes the cuota from the snapshot.
   */
  applyMonotributoCuota: (amount: number, categoryLabel: string) => void

  /**
   * Reset every field to its blank new-entry default and clear the attachment +
   * duplicate advisory (issue #26 polish). Resets in place (no remount), so it
   * works whether the form opened blank or via an upload. Does NOT close the
   * dialog/drawer — that's Cancel's job.
   */
  resetForm: () => void

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

  // The configured FX default source (ADR-044/045/057) pre-selects the USD
  // source on a fresh add. Read non-blockingly: if settings are still loading
  // (or failed), fall back to MEP so the form never waits on settings.
  const settingsQuery = useSettings()
  const fxDefaultRateType: FxDefaultRateType =
    settingsQuery.data?.fxDefaultRateType ?? 'MEP'

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
  // else the configured FX default (ADR-057) — the form falls back to the other
  // suggested source if the chosen one is unavailable.
  const seededFxSource: FxSource =
    prefill?.fxRateType === 'official'
      ? 'official'
      : prefill?.fxRateType === 'manual'
        ? 'manual'
        : fxDefaultRateType
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
  // Optional merchant/client name (ADR-088). Seeded from the row's current name
  // on edit, blank on add. Typed/auto-filled input wins in `buildInput`; blank
  // falls back to the category-derived label. This field subsumes the old
  // `importedName` — invoice parse + Monotributo autofills now write here.
  const [name, setName] = useState<string>(prefill?.name ?? '')
  const [notes, setNotes] = useState<string>(prefill?.notes ?? '')

  // In-form ARCA invoice upload (ADR-072). The parse autofills the fields above
  // via `applyParsedInvoice`; the base64 `document` is stashed here so saving
  // attaches the PDF, and `duplicate` drives the calm non-blocking warning. The
  // parse's client name is written into the editable `name` field (ADR-088).
  const [importedDocument, setImportedDocument] = useState<
    InvoiceDocumentPayload | null
  >(prefill?.document ?? null)
  const [duplicate, setDuplicate] = useState<boolean>(false)
  // The uploaded PDF's file name, surfaced in the attached-file row so the user
  // sees which file they picked (issue #26). Set when a parse succeeds; cleared
  // on unattach/reset. Seeded null — a prefill carries no original file name.
  const [attachedFileName, setAttachedFileName] = useState<string | null>(null)

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

  // Keep the configured FX default in a ref so the stable `fetchSuggestion`
  // callback (empty deps, fed to a one-shot effect) reads the latest value
  // without changing identity and re-triggering the effect (ADR-057). Synced in
  // an effect (never written during render) so settings arriving late are
  // reflected the next time a suggestion is applied.
  const fxDefaultRef = useRef<FxDefaultRateType>(fxDefaultRateType)
  useEffect(() => {
    fxDefaultRef.current = fxDefaultRateType
  }, [fxDefaultRateType])

  // Fetch BOTH suggested rates in parallel and pre-fill the active non-manual
  // source when they land. Only pre-fills when the user has not already typed a
  // rate, so a refresh never clobbers an edit. `applyDefault` (true on the first
  // auto-fetch) picks the configured default source, falling back to the other
  // when the configured one is unavailable.
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
          // First fetch: pick the configured default source (ADR-057), falling
          // back to the other suggested source when the configured one is null.
          const preferred = fxDefaultRef.current
          const preferredValue = preferred === 'MEP' ? mep : official
          const next: FxSource =
            preferredValue !== null
              ? preferred
              : mep !== null
                ? 'MEP'
                : 'official'
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

  // Autofill the form from a parsed ARCA invoice (ADR-072). Imported invoices
  // are always income; we set the type/kind + amount/date/currency/name/category
  // from the parse, seed the FX block when USD (marking the rate user-owned so
  // the auto-suggest effect never clobbers the declared rate), stash the base64
  // document for confirm-time attach, and record the duplicate advisory.
  const applyParsedInvoice = useCallback(
    (parsed: InvoiceParse, fileName?: string) => {
    setType('income')
    setCountsTowardMonotributo(parsed.countsTowardMonotributo ?? true)
    setDuplicate(parsed.duplicate)
    setImportedDocument(parsed.document)
    if (fileName) setAttachedFileName(fileName)
    // Surface the parsed client name in the editable Name field (ADR-088); a
    // parse without a name clears it so the field reflects the import.
    setName(parsed.name ?? '')
    if (parsed.amount !== undefined) setAmountText(String(parsed.amount))
    if (parsed.occurredOn) setOccurredOn(parsed.occurredOn)

    const nextCurrency = parsed.currency ?? 'ARS'
    setCurrency(nextCurrency)
    if (nextCurrency === 'USD') {
      // Seed the declared FX from the parse and mark it user-owned so the
      // USD-suggestion effect leaves it intact (ADR-044/072).
      if (parsed.fxRate !== undefined) {
        setRateTextRaw(String(parsed.fxRate))
        setRateEdited(true)
        // Narrow the declared rate type to a concrete FX source; anything other
        // than MEP/official (e.g. `configured_default`) is treated as manual.
        const source: FxSource =
          parsed.fxRateType === 'MEP' || parsed.fxRateType === 'official'
            ? parsed.fxRateType
            : 'manual'
        setFxSourceRaw(source)
      }
      // The original USD figure is the amount field for a USD entry.
      if (parsed.usdAmount !== undefined) {
        setAmountText(String(parsed.usdAmount))
      }
    }
    },
    [],
  )

  // Unattach the uploaded invoice PDF (issue #26): drop the stashed document, its
  // file name, and the duplicate advisory — but keep the autofilled field values.
  // After this, `buildInput` attaches no document, so saving creates the row
  // without a PDF and the upload control reappears for a different file.
  const clearImportedDocument = useCallback(() => {
    setImportedDocument(null)
    setAttachedFileName(null)
    setDuplicate(false)
    // The Name field is part of the autofilled values the user reviews, so an
    // unattach keeps it (parity with amount/date/category) — not reset (ADR-088).
  }, [])

  // Autofill the expense path with the monthly Monotributo cuota. The cuota is an
  // ARS amount, so we set ARS and clear any FX state (rate/source/suggestions) so
  // `buildInput` produces a plain ARS expense. We pin the `Taxes` category and set
  // the name override to the configured category label (e.g. "Monotributo C").
  const applyMonotributoCuota = useCallback(
    (amount: number, categoryLabel: string) => {
      setAmountText(String(amount))
      setCurrency('ARS')
      setRateTextRaw('')
      setRateEdited(false)
      setFxSourceRaw(fxDefaultRef.current)
      setSuggestedRates({ MEP: null, official: null })
      setRateSuggestionStatus('idle')
      setCategory('Taxes')
      setName(categoryLabel)
    },
    [],
  )

  // Reset every field to its blank new-entry default + clear the attachment and
  // duplicate advisory (issue #26). Resets in place so it works whether the form
  // opened blank or via an upload; it does not close the surface.
  const resetForm = useCallback(() => {
    setType('expense')
    setCountsTowardMonotributo(false)
    setAmountText('')
    setCurrency('ARS')
    setRateTextRaw('')
    setRateEdited(false)
    setFxSourceRaw(fxDefaultRef.current)
    setSuggestedRates({ MEP: null, official: null })
    setRateSuggestionStatus('idle')
    setCategory(DEFAULT_CATEGORY)
    setBank(DEFAULT_BANK)
    setName('')
    setNotes('')
    setOccurredOn(maxOccurredOn)
    setImportedDocument(null)
    setAttachedFileName(null)
    setDuplicate(false)
  }, [maxOccurredOn])

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
      // The typed/auto-filled Name wins (ADR-088); a blank field falls back to
      // the category-derived label exactly as before. This becomes the row's
      // `name`, which the reconciliation matcher reads (ADR-085).
      name: name.trim() || deriveName(type, kind, category),
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
      // Card detail is import-set, not user-editable (ADR-117): carry the prefill's
      // value straight through so editing an imported row keeps its card on save.
      ...(prefill?.card ? { card: prefill.card } : {}),
      ...(prefill?.recurring !== undefined
        ? { recurring: prefill.recurring }
        : {}),
      // Carry the imported invoice PDF through to create so confirming the form
      // persists + links the attachment (ADR-072). Add-only: an edit never
      // re-attaches. The document comes from the in-form upload (or a prefill).
      ...(mode === 'add' && importedDocument
        ? { document: importedDocument }
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
    name,
    setName,
    notes,
    setNotes,
    amountArs,
    usdRateMissing,
    canSave,
    duplicate,
    hasImportedDocument: importedDocument !== null,
    attachedFileName,
    applyParsedInvoice,
    clearImportedDocument,
    applyMonotributoCuota,
    resetForm,
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
