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
import type { Account, Currency, Institution } from '../../mock/types'
import {
  currenciesInParse,
  matchCardAccounts,
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
 * The per-currency card-account attachment for the import (ADR-184). A statement
 * is from ONE card institution, and Argentine cards carry separate ARS + USD
 * balances, so the attachment is decided ONCE per line-currency present in the
 * statement — not per row. Each entry carries the currency, its auto-matched
 * default (or `null` when the user has no matching card account), and the CURRENT
 * selected account id (`null` = import that currency's lines unattached).
 */
export interface CurrencyAccountChoice {
  /** The line currency this choice governs (ARS or USD). */
  readonly currency: Currency
  /** The auto-matched card account for (institution, currency), or null (ADR-184). */
  readonly matched: AccountMatch | null
  /** The currently selected account id, or null to import unattached. */
  readonly selectedAccountId: string | null
}

export interface StatementReviewState {
  /** The editable line drafts, in statement order. */
  readonly lines: readonly ReviewLine[]
  /**
   * The per-currency card-account attachment choices (ADR-184), one per line-
   * currency present in the statement, ARS before USD. Empty when the parse has
   * no lines. The review UI renders a confirm/override selector per entry.
   */
  readonly accountChoices: readonly CurrencyAccountChoice[]
  /**
   * Set (or clear, with `null`) the card account a currency's lines attach to
   * (ADR-184). No-op for a currency not present in the statement.
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
  /** Toggle a single line's keep/exclude state by id. */
  toggleKeep: (id: string, keep: boolean) => void
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
    ...(line.category ? { category: line.category } : {}),
    // The normalized bank + card detail are statement-level (ADR-117).
    ...(bank ? { bank } : {}),
    ...(card ? { card } : {}),
    ...(line.cuota ? { cuota: line.cuota } : {}),
    // The card account the user confirmed for this line's currency (ADR-184);
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
  institutions: readonly Institution[] = [],
): StatementReviewState {
  const [lines, setLines] = useState<ReviewLine[]>(() =>
    parse.lines.map((line) => ({
      ...line,
      keep: line.include,
      // Flagged lines default to Merge (ADR-086); the value is inert otherwise.
      resolution: 'merge' as ReviewResolution,
    })),
  )

  // Auto-match the (institution, currency) card account per line-currency and
  // seed each currency's selected account id from it (ADR-184). Recomputed when
  // the accounts list resolves (it may be empty on first render): a currency's
  // selection is (re)seeded to the match ONLY while the user hasn't chosen — a
  // user override (tracked in `accountOverrides`) always wins.
  const matches = useMemo(
    () => matchCardAccounts(parse, accounts, institutions),
    [parse, accounts, institutions],
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

  const includedCount = useMemo(
    () => lines.filter((line) => line.keep).length,
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
    // The selected account id per currency (ADR-184): each kept line attaches to
    // the account chosen for ITS currency (ARS line → ARS card account, etc.).
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
    includedCount,
    includedTotal,
    newCount,
    mergeCount,
    toggleKeep,
    setCategory,
    setResolution,
    setCuota,
    buildImportRequest,
  }
}
