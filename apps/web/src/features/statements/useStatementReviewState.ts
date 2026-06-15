/**
 * Review-table state + derivations for the statement import flow (ADR-080, ADR-086).
 *
 * Kept in a non-component module so `StatementReviewTable.tsx` only exports
 * components (Fast-Refresh friendly). This hook owns the editable per-line state
 * — the include/exclude toggle, the category edit, and (for flagged lines) the
 * Merge / Keep both resolution — seeded once from a parsed statement, and derives
 * the split counts (new vs merged), the running total of the lines importing as
 * new, and the ready-to-send import payload (only the kept lines, money re-encoded
 * as Decimal strings, the statement's `paymentMethod` carried as each line's
 * `bank`, plus the per-line `resolution` + `matchTransactionId`).
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

export interface StatementReviewState {
  /** The editable line drafts, in statement order. */
  readonly lines: readonly ReviewLine[]
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

/** Build the per-line import payload, carrying edits + the card payment method. */
function toLineRequest(
  line: ReviewLine,
  paymentMethod: string | undefined,
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
    ...(paymentMethod ? { bank: paymentMethod } : {}),
    ...(line.cuota ? { cuota: line.cuota } : {}),
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
): StatementReviewState {
  const [lines, setLines] = useState<ReviewLine[]>(() =>
    parse.lines.map((line) => ({
      ...line,
      keep: line.include,
      // Flagged lines default to Merge (ADR-086); the value is inert otherwise.
      resolution: 'merge' as ReviewResolution,
    })),
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
    return {
      document: parse.document,
      lines: kept.map((line) => toLineRequest(line, parse.paymentMethod)),
    }
  }, [lines, parse.document, parse.paymentMethod])

  return {
    lines,
    includedCount,
    includedTotal,
    newCount,
    mergeCount,
    toggleKeep,
    setCategory,
    setResolution,
    buildImportRequest,
  }
}
