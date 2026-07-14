/**
 * Review-table state + derivations for the statement import flow (ADR-080, ADR-086).
 *
 * Kept in a non-component module so `StatementReviewTable.tsx` only exports
 * components (Fast-Refresh friendly). This hook owns the editable per-line state
 * — the include/exclude toggle, the category edit, and (for flagged lines) the
 * Merge / Keep both resolution — seeded once from a parsed statement, and derives
 * the split counts (new vs merged), the running total of the lines importing as
 * new, and the ready-to-send import payload (only the kept lines, money re-encoded
 * as Decimal strings, the statement's normalized `bankName` carried as each line's
 * `bank` and the statement's `card` detail carried as each line's `card` (ADR-117),
 * plus the per-line `resolution` + `matchTransactionId`).
 *
 * Resolution model (ADR-084/085): a line with a `match` defaults to `merge`
 * (treat as the same expense, enrich the existing transaction); the user may
 * switch it to `keep_both` (import as a separate charge). A line without a match
 * always resolves as `import`. Merged lines do NOT count toward the "new" total.
 *
 * Money convention: the table speaks plain numbers (parsed at the client seam),
 * but the API boundary uses Decimal strings (ADR-025), so `buildImportRequest`
 * re-encodes amounts with `String(number)` on the way out — mirroring how
 * {@link useAddEditFormState} adapts the invoice flow.
 */

import { useCallback, useMemo, useState } from 'react'
import type {
  StatementImportRequest,
  StatementLine,
  StatementLineRequest,
  StatementLineResolution,
  StatementParse,
} from '../../api/statementsClient'
import type { Account, Currency } from '../../mock/types'
import type { PreferredRateSource } from '../../api/settingsClient'
import { materializeUsdLineFx } from '../transactions/captureFx'
import {
  currenciesInParse,
  matchAccounts,
  type AccountMatch,
} from './accountMatch'

/**
 * The user-facing resolution choice for a flagged line (ADR-086). Maps to the
 * import `resolution` field: `merge` → `merge`, `keep_both` → `keep_both`. An
 * unflagged line has no choice and resolves as `import`.
 */
export type ReviewResolution = 'merge' | 'keep_both'

/** A line plus its editable review state (kept/excluded, edited category, resolution). */
export interface ReviewLine extends StatementLine {
  /** Whether this line will be imported (seeded from the parser's `include`). */
  keep: boolean
  /**
   * For flagged lines (those with a `match`): how it resolves on import. Defaults
   * to `merge` (ADR-086). Ignored for unflagged lines (they always `import`).
   */
  resolution: ReviewResolution
}

/** A parsed installment marker: the 1-based index (`N`) and the total (`M`). */
export interface CuotaParts {
  /** The `N` of "Cuota N/M" (1-based position), or null when unparseable. */
  index: number | null
  /** The `M` of "Cuota N/M" (total payments), or null when unparseable. */
  total: number | null
}

/**
 * Parse a `cuota` marker string such as `"3/12"` / `"03/06"` into its numeric
 * index/total (ADR-175). A null/blank/malformed marker (or a decimal/negative
 * part) yields `{ index: null, total: null }` so the editor renders empty fields
 * rather than fabricating a bogus plan. Whitespace around the parts is tolerated.
 */
export function parseCuota(cuota: string | undefined): CuotaParts {
  if (!cuota) return { index: null, total: null }
  const parts = cuota.split('/')
  if (parts.length !== 2) return { index: null, total: null }
  const parseInteger = (raw: string): number | null => {
    const trimmed = raw.trim()
    if (!/^\d+$/.test(trimmed)) return null
    const value = Number.parseInt(trimmed, 10)
    return Number.isFinite(value) && value > 0 ? value : null
  }
  return { index: parseInteger(parts[0]), total: parseInteger(parts[1]) }
}

/**
 * Rebuild a `cuota` marker string from an edited index/total pair (ADR-175). Only a
 * COMPLETE, valid pair (both positive integers, index ≤ total) yields a string; any
 * incomplete or invalid pair yields `undefined` so the line drops its installment
 * marker rather than sending a malformed one the backend would reject.
 */
export function formatCuota(index: number | null, total: number | null): string | undefined {
  if (index == null || total == null) return undefined
  if (index <= 0 || total <= 0 || index > total) return undefined
  return `${index}/${total}`
}

/**
 * The per-currency account attachment for the import (ADR-198). A statement is
 * from one issuer, and Argentine accounts carry separate ARS + USD balances, so
 * the attachment is decided ONCE per line-currency present in the statement — not
 * per row. Each entry carries the currency, its auto-matched NON-card default (or
 * `null` when the user has no matching account), and the CURRENT selected account
 * id (`null` = import that currency's lines unattached).
 */
export interface CurrencyAccountChoice {
  /** The line currency this choice governs (ARS or USD). */
  readonly currency: Currency
  /** The auto-matched non-card account for (issuer, currency), or null (ADR-198). */
  readonly matched: AccountMatch | null
  /** The currently selected account id, or null to import unattached. */
  readonly selectedAccountId: string | null
}

export interface StatementReviewState {
  /** The editable line drafts, in statement order. */
  readonly lines: readonly ReviewLine[]
  /**
   * The per-currency account attachment choices (ADR-198), one per line-currency
   * present in the statement, ARS before USD. Empty when the parse has no lines.
   * The review UI renders a confirm/override selector per entry.
   */
  readonly accountChoices: readonly CurrencyAccountChoice[]
  /**
   * Set (or clear, with `null`) the account a currency's lines attach to
   * (ADR-198). No-op for a currency not present in the statement.
   */
  setAccountForCurrency: (currency: Currency, accountId: string | null) => void
  /** Count of lines currently kept for import (new + merged). */
  readonly includedCount: number
  /** Sum of the amounts of the kept lines importing as new (display number). */
  readonly includedTotal: number
  /** Count of kept lines importing as a NEW expense (import or keep_both). */
  readonly newCount: number
  /** Count of kept lines merging into an existing transaction. */
  readonly mergeCount: number
  /**
   * True when a USD line needs an ARS `amount` but the live preferred-source rate
   * is unavailable (query errored/empty), so no line could be auto-materialized
   * (ADR-079/149/150). The review surfaces a calm inline hint that the user must
   * enter the ARS amount to import; a rate is NEVER fabricated. False when there
   * is no such USD line, or the rate resolved and the lines were materialized.
   */
  readonly usdRateUnavailable: boolean
  /**
   * True when at least one KEPT line still has a non-positive `amount` (ADR-079).
   * This happens for a USD-only line whose ARS-equivalent could not be materialized
   * (rate unavailable) and which the user hasn't hand-entered — submitting it would
   * 422 the WHOLE import at the backend's `amount > 0` guard. The review disables
   * the Import action while this holds so the failure surfaces as the calm inline
   * "enter the ARS amount" hint rather than a blanket server error.
   */
  readonly hasBlockingZeroAmount: boolean
  /** Toggle a single line's keep/exclude state by id. */
  toggleKeep: (id: string, keep: boolean) => void
  /**
   * Edit a line's ARS-equivalent `amount` by id (ADR-079). Used for the USD-line
   * materialization affordance: the user can confirm or adjust the computed ARS
   * amount before import. A hand-edit is remembered so the async rate-materialize
   * never clobbers it. A blank/invalid value resets the amount to 0.
   */
  setAmount: (id: string, amount: number) => void
  /** Edit a single line's category by id (empty string clears it). */
  setCategory: (id: string, category: string) => void
  /** Set a flagged line's Merge / Keep both resolution by id. */
  setResolution: (id: string, resolution: ReviewResolution) => void
  /**
   * Edit a line's installment marker (ADR-175) from an index/total pair. A complete
   * valid pair sets `cuota = "N/M"`; an incomplete/invalid pair clears it. The
   * backend re-parses the `cuota` string into structured installment fields on
   * import, stamping `recurring_cadence='installment'` (ADR-175/176).
   */
  setCuota: (id: string, index: number | null, total: number | null) => void
  /** Build the import request payload from the current kept selection. */
  buildImportRequest: () => StatementImportRequest
}

/** Map a numeric amount back to the Decimal string the API expects. */
function toDecimalString(value: number): string {
  return String(value)
}

/**
 * The wire `resolution` for a kept line (ADR-085): a flagged line uses its
 * Merge / Keep both choice; an unflagged line always imports as new.
 */
function lineResolution(line: ReviewLine): StatementLineResolution {
  if (!line.match) return 'import'
  return line.resolution === 'keep_both' ? 'keep_both' : 'merge'
}

/**
 * Build the per-line import payload, carrying edits + the statement's bank/card
 * identity (ADR-117). A statement is from one card, so the normalized `bank` and
 * the `card` detail are statement-level and stamped onto every kept line.
 */
function toLineRequest(
  line: ReviewLine,
  bank: string | undefined,
  card: string | undefined,
  accountId: string | null,
): StatementLineRequest {
  const resolution = lineResolution(line)
  return {
    occurredOn: line.occurredOn,
    // Echo the original purchase date so the backend composes the purchase note (ADR-089).
    ...(line.purchaseDate ? { purchaseDate: line.purchaseDate } : {}),
    name: line.name,
    amount: toDecimalString(line.amount),
    currency: line.currency,
    ...(line.usdAmount !== undefined
      ? { usdAmount: toDecimalString(line.usdAmount) }
      : {}),
    ...(line.fxRate !== undefined
      ? { fxRate: toDecimalString(line.fxRate) }
      : {}),
    ...(line.fxRateType !== undefined ? { fxRateType: line.fxRateType } : {}),
    // The FX provenance travels WITH the rate (ADR-148) so the imported USD row
    // lands with a complete, auditable snapshot and the backend runs its
    // authoritative usd_amount = round(amount ÷ fx_rate) re-materialization (which
    // only fires when fx_source is set). Never hardcoded 'manual'.
    ...(line.fxSource !== undefined ? { fxSource: line.fxSource } : {}),
    ...(line.category ? { category: line.category } : {}),
    // The normalized bank + card detail are statement-level (ADR-117).
    ...(bank ? { bank } : {}),
    ...(card ? { card } : {}),
    ...(line.cuota ? { cuota: line.cuota } : {}),
    // The non-card account the user confirmed for this line's currency (ADR-198);
    // omitted (null) imports the line unattached — the backend is tolerant.
    ...(accountId ? { accountId } : {}),
    resolution,
    // matchTransactionId is REQUIRED for merge; carried only then (ADR-085).
    ...(resolution === 'merge' && line.match
      ? { matchTransactionId: line.match.transactionId }
      : {}),
  }
}

/**
 * Build the review state, seeded once from `parse`. The lines never re-seed
 * from the parse after mount — the user's edits are the source of truth — so a
 * `useState` initializer is sufficient.
 */
export function useStatementReviewState(
  parse: StatementParse,
  accounts: readonly Account[] = [],
  /**
   * The live preferred-source rate (ARS per 1 USD, ADR-149/151) the review uses
   * to materialize a USD-only line's ARS-equivalent + FX snapshot (ADR-079). The
   * SAME cached rate the Add-transaction flow uses (`usePreferredRate`). `null`/
   * `undefined` = unavailable → USD-only lines are left at `amount` 0 with a calm
   * "enter the ARS amount" hint; a rate is never fabricated.
   */
  preferredRate: number | null | undefined = null,
  /** The persisted preferred rate source (ADR-151) tagging the snapshot's `fxRateType`. */
  preferredRateSource: PreferredRateSource | undefined = undefined,
): StatementReviewState {
  const [lines, setLines] = useState<ReviewLine[]>(() =>
    parse.lines.map((line) => ({
      ...line,
      keep: line.include,
      // Flagged lines default to Merge (ADR-086); the value is inert otherwise.
      resolution: 'merge' as ReviewResolution,
    })),
  )

  // The ids of lines whose ARS `amount` the user has hand-edited (ADR-079). A
  // hand-edit is authoritative — the async rate-materialize below MUST NOT clobber
  // it, so it is skipped for any id in this set.
  const [editedAmounts, setEditedAmounts] = useState<ReadonlySet<string>>(
    () => new Set(),
  )

  // Materialize USD-only lines once the live rate resolves (ADR-079/148/149).
  // The lines are seeded once from the parse (a USD-only card charge arrives with
  // `usdAmount` set but `amount` 0 and no FX — FX is left for review, ADR-079).
  // When the preferred-source rate becomes available we compute
  // `amount = usdAmount × rate` and stamp `fxRate` + `fxRateType`, mirroring the
  // Add-transaction USD path (`materializeUsdLineFx`), so `usd_amount` + the FX
  // snapshot are complete and the import passes the `amount > 0` contract.
  //
  // This uses the sanctioned "adjust state while rendering" pattern (React docs)
  // rather than an effect: it is a pure derivation of local state from a resolved
  // query value, applied exactly once per line (guarded by the already-filled
  // check) and only to a still-zero, un-hand-edited USD line — so a user's edits
  // (amount, currency, or a line that already carried a peso `amount`) are never
  // clobbered. A USD line with an existing positive `amount` (e.g. a Santander
  // AMEX line that carried a peso column) is left AS-IS; ARS lines are untouched.
  const pending = lines
    .filter(
      (line) =>
        line.currency === 'USD' &&
        line.amount === 0 &&
        !editedAmounts.has(line.id) &&
        line.fxRate === undefined,
    )
    .map((line) => ({
      id: line.id,
      fx: materializeUsdLineFx(line.usdAmount, preferredRate, preferredRateSource),
    }))
    .filter(
      (entry): entry is { id: string; fx: NonNullable<typeof entry.fx> } =>
        entry.fx !== null,
    )
  if (pending.length > 0) {
    const byId = new Map(pending.map((entry) => [entry.id, entry.fx]))
    setLines((current) =>
      current.map((line) => {
        const fx = byId.get(line.id)
        return fx
          ? {
              ...line,
              amount: fx.amount,
              fxRate: fx.fxRate,
              fxRateType: fx.fxRateType,
              // The provenance travels with the rate so the row's snapshot is
              // complete on import (ADR-148); the backend re-materializes usd_amount
              // only when fx_source is set.
              fxSource: fx.fxSource,
            }
          : line
      }),
    )
  }

  // Auto-match the (issuer, currency) NON-card account per line-currency and seed
  // each currency's selected account id from it (ADR-198). Recomputed when the
  // accounts list resolves (it may be empty on first render): a currency's
  // selection is (re)seeded to the match ONLY while the user hasn't chosen — a
  // user override (tracked in `accountOverrides`) always wins.
  const matches = useMemo(
    () => matchAccounts(parse, accounts),
    [parse, accounts],
  )
  const currencies = useMemo(() => currenciesInParse(parse), [parse])
  // Per-currency user overrides: absent = follow the auto-match; present (id or
  // null) = the user's explicit confirm/override. Keyed by currency.
  const [accountOverrides, setAccountOverrides] = useState<
    Partial<Record<Currency, string | null>>
  >({})

  const accountChoices = useMemo<CurrencyAccountChoice[]>(
    () =>
      currencies.map((currency) => {
        const matched = matches.get(currency) ?? null
        const hasOverride = currency in accountOverrides
        const selectedAccountId = hasOverride
          ? (accountOverrides[currency] ?? null)
          : (matched?.id ?? null)
        return { currency, matched, selectedAccountId }
      }),
    [currencies, matches, accountOverrides],
  )

  const setAccountForCurrency = useCallback(
    (currency: Currency, accountId: string | null) => {
      setAccountOverrides((current) => ({ ...current, [currency]: accountId }))
    },
    [],
  )

  const toggleKeep = useCallback((id: string, keep: boolean) => {
    setLines((current) =>
      current.map((line) => (line.id === id ? { ...line, keep } : line)),
    )
  }, [])

  const setAmount = useCallback((id: string, amount: number) => {
    const next = Number.isFinite(amount) && amount > 0 ? amount : 0
    // Remember the hand-edit so the async rate-materialize never overwrites it.
    setEditedAmounts((current) => {
      if (current.has(id)) return current
      const updated = new Set(current)
      updated.add(id)
      return updated
    })
    setLines((current) =>
      current.map((line) => (line.id === id ? { ...line, amount: next } : line)),
    )
  }, [])

  const setCategory = useCallback((id: string, category: string) => {
    setLines((current) =>
      current.map((line) =>
        line.id === id
          ? { ...line, category: category === '' ? undefined : category }
          : line,
      ),
    )
  }, [])

  const setResolution = useCallback((id: string, resolution: ReviewResolution) => {
    setLines((current) =>
      current.map((line) => (line.id === id ? { ...line, resolution } : line)),
    )
  }, [])

  const setCuota = useCallback(
    (id: string, index: number | null, total: number | null) => {
      const cuota = formatCuota(index, total)
      setLines((current) =>
        current.map((line) =>
          line.id === id ? { ...line, cuota } : line,
        ),
      )
    },
    [],
  )

  // A USD line still awaiting an ARS amount: a USD-only line (usdAmount > 0) whose
  // `amount` is 0 and which the user hasn't hand-edited (ADR-079). When the live
  // rate is unavailable NONE of these can be auto-materialized, so the review must
  // surface a calm "enter the ARS amount" hint (a rate is never fabricated,
  // ADR-149/150). Derived from the CURRENT lines so it clears the moment the rate
  // lands and the amounts materialize, or the user types an amount.
  const rateAvailable =
    typeof preferredRate === 'number' &&
    Number.isFinite(preferredRate) &&
    preferredRate > 0
  const usdRateUnavailable = useMemo(
    () =>
      !rateAvailable &&
      lines.some(
        (line) =>
          line.currency === 'USD' &&
          typeof line.usdAmount === 'number' &&
          line.usdAmount > 0 &&
          line.amount === 0,
      ),
    [rateAvailable, lines],
  )

  const includedCount = useMemo(
    () => lines.filter((line) => line.keep).length,
    [lines],
  )

  // A kept line with a non-positive ARS `amount` (ADR-079): the backend rejects the
  // WHOLE import at its `amount > 0` guard (422), so the Import action is blocked
  // while any exists — the review shows the calm inline "enter the ARS amount" hint
  // instead of a blanket server error. Clears the instant the rate materializes the
  // amount or the user hand-enters a positive value.
  const hasBlockingZeroAmount = useMemo(
    () => lines.some((line) => line.keep && !(line.amount > 0)),
    [lines],
  )

  // A kept line counts as "merged" only when flagged AND set to merge; otherwise
  // (unflagged, or flagged + keep_both) it imports as a new expense (ADR-085/086).
  const mergeCount = useMemo(
    () =>
      lines.filter(
        (line) => line.keep && line.match && line.resolution === 'merge',
      ).length,
    [lines],
  )

  const newCount = useMemo(
    () => includedCount - mergeCount,
    [includedCount, mergeCount],
  )

  // Merged lines enrich an existing transaction, so they don't add to the
  // "new spend" total — only lines importing as new contribute (ADR-086).
  const includedTotal = useMemo(
    () =>
      lines.reduce(
        (sum, line) =>
          line.keep && lineResolution(line) !== 'merge'
            ? sum + line.amount
            : sum,
        0,
      ),
    [lines],
  )

  const buildImportRequest = useCallback((): StatementImportRequest => {
    const kept = lines.filter((line) => line.keep)
    // The selected account id per currency (ADR-198): each kept line attaches to
    // the account chosen for ITS currency (ARS line → ARS bank account, etc.).
    const accountByCurrency = new Map<Currency, string | null>(
      accountChoices.map((choice) => [choice.currency, choice.selectedAccountId]),
    )
    return {
      document: parse.document,
      lines: kept.map((line) =>
        toLineRequest(
          line,
          parse.bankName,
          parse.card,
          accountByCurrency.get(line.currency) ?? null,
        ),
      ),
    }
  }, [lines, accountChoices, parse.document, parse.bankName, parse.card])

  return {
    lines,
    accountChoices,
    setAccountForCurrency,
    usdRateUnavailable,
    hasBlockingZeroAmount,
    includedCount,
    includedTotal,
    newCount,
    mergeCount,
    toggleKeep,
    setAmount,
    setCategory,
    setResolution,
    setCuota,
    buildImportRequest,
  }
}
