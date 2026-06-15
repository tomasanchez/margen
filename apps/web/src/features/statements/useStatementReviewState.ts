/**
 * Review-table state + derivations for the statement import flow (ADR-080).
 *
 * Kept in a non-component module so `StatementReviewTable.tsx` only exports
 * components (Fast-Refresh friendly). This hook owns the editable per-line state
 * — the include/exclude toggle and the category edit — seeded once from a parsed
 * statement, and derives the running total of included lines plus the
 * ready-to-send import payload (only the kept lines, money re-encoded as Decimal
 * strings, the statement's `paymentMethod` carried as each line's `bank`).
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
  StatementParse,
} from '../../api/statementsClient'

/** A line plus its editable review state (kept/excluded, edited category). */
export interface ReviewLine extends StatementLine {
  /** Whether this line will be imported (seeded from the parser's `include`). */
  keep: boolean
}

export interface StatementReviewState {
  /** The editable line drafts, in statement order. */
  readonly lines: readonly ReviewLine[]
  /** Count of lines currently kept for import. */
  readonly includedCount: number
  /** Sum of the amounts of the kept lines (display number, ARS-equivalent). */
  readonly includedTotal: number
  /** Toggle a single line's keep/exclude state by id. */
  toggleKeep: (id: string, keep: boolean) => void
  /** Edit a single line's category by id (empty string clears it). */
  setCategory: (id: string, category: string) => void
  /** Build the import request payload from the current kept selection. */
  buildImportRequest: () => StatementImportRequest
}

/** Map a numeric amount back to the Decimal string the API expects. */
function toDecimalString(value: number): string {
  return String(value)
}

/** Build the per-line import payload, carrying edits + the card payment method. */
function toLineRequest(
  line: ReviewLine,
  paymentMethod: string | undefined,
): StatementLineRequest {
  return {
    occurredOn: line.occurredOn,
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
    parse.lines.map((line) => ({ ...line, keep: line.include })),
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

  const includedCount = useMemo(
    () => lines.filter((line) => line.keep).length,
    [lines],
  )

  const includedTotal = useMemo(
    () =>
      lines.reduce((sum, line) => (line.keep ? sum + line.amount : sum), 0),
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
    toggleKeep,
    setCategory,
    buildImportRequest,
  }
}
