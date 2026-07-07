/**
 * Credit-card statement import API client + DTO adapter (ADR-078, ADR-080).
 *
 * The single boundary between the backend's statement contract and the
 * multi-row review table. Unlike {@link invoicesClient} (which yields ONE
 * prefilled form), a statement parse yields N line drafts the user reviews,
 * edits, and selectively imports. This client owns three responsibilities:
 *
 *   1. `parseStatement(file)` — uploads a PDF (multipart) to
 *      `POST /statements/parse`, unwraps the `{ data }` envelope (ADR-030),
 *      parses Decimal-string money to numbers (ADR-025/034), narrows the
 *      currency/fx unions, and KEEPS the backend `document` payload verbatim so
 *      the confirm step can echo it back on import (ADR-078). Exposes the
 *      detected bank/card identity, the duplicate advisory, and the line drafts.
 *   2. `importStatement(payload)` — `POST /statements/import` with the document
 *      echo + only the lines the user kept; returns the created transaction ids.
 *   3. `statementDocumentUrl(id)` — the GET URL for the stored statement PDF.
 *
 * A {@link StatementsApiError} maps the documented upload-rejection codes
 * (415/413/422) to calm, friendly copy for the manual-fallback flow
 * (ADR-072/037).
 */

import { apiUrl } from '../config'
import { authedFetch } from './http'
import { fileToBase64 } from './invoicesClient'
import type { Currency, FxRateType } from '../mock/types'

/** The backend `{ data: T }` response envelope (ADR-030). */
interface ResponseEnvelope<T> {
  data: T
}

/**
 * The parse outcome (ADR-078). `ok` carries the detected identity + line drafts;
 * `unsupported` (bank not yet recognized) and `unparseable` (a valid PDF we
 * couldn't read) carry no lines and trigger the calm manual fallback (ADR-080).
 */
export type StatementParseStatus = 'ok' | 'unsupported' | 'unparseable'

/** A line's kind: a real purchase vs an issuer fee/charge (ADR-078). */
export type StatementLineKind = 'purchase' | 'fee'

/** The fiscal natural key computed from the parsed statement (ADR-077). */
export interface StatementNaturalKey {
  issuerCuit: string | null
  cardLast4: string | null
  statementNumber: string | null
}

/**
 * The matched existing transaction a parsed line likely duplicates (ADR-084/085),
 * as serialized by the backend (camelCase, money as Decimal strings).
 */
interface StatementMatchDto {
  transactionId: string
  name: string
  occurredOn: string
  amount: string
  category?: string | null
  paymentMethod?: string | null
}

/** A single parsed statement line as serialized by the backend (camelCase). */
interface StatementLineDto {
  /** The statement pay/due date — same for every line of a statement (ADR-089). */
  occurredOn: string
  /** The original purchase FECHA preserved for display + reconciliation (ADR-089). */
  purchaseDate?: string | null
  name: string
  amount: string
  currency: string
  usdAmount?: string | null
  fxRate?: string | null
  fxRateType?: string | null
  category?: string | null
  cuota?: string | null
  lineKind: StatementLineKind
  include: boolean
  /** Present when this line likely duplicates an existing manual transaction. */
  match?: StatementMatchDto | null
}

/**
 * The statement document echoed back on `POST /statements/import` so the backend
 * stores + links the PDF (ADR-078). `pdfBase64` is the client-read base64 of the
 * uploaded File (robust — never depends on the parse response echoing the bytes);
 * the rest are the parsed statement record fields. Sent verbatim under the import
 * body's `document` key.
 */
export interface StatementDocumentPayload {
  pdfBase64: string
  contentType: string
  byteSize?: number
  extractedText?: string
  bankName?: string
  network?: string
  cardLast4?: string
  issuerCuit?: string
  statementNumber?: string
  periodClose?: string
  periodDue?: string
  totalAmount?: string
}

/** The document DTO as serialized by the backend (camelCase, money as strings). */
interface StatementDocumentDto {
  pdfBase64?: string | null
  contentType?: string | null
  byteSize?: number | null
  extractedText?: string | null
  bankName?: string | null
  network?: string | null
  cardLast4?: string | null
  issuerCuit?: string | null
  statementNumber?: string | null
  periodClose?: string | null
  periodDue?: string | null
  totalAmount?: string | null
}

/** The raw statement parse DTO as serialized by the backend (camelCase). */
interface StatementParseDto {
  status: StatementParseStatus
  duplicate: boolean
  bankName?: string | null
  network?: string | null
  cardLast4?: string | null
  card?: string | null
  statementNumber?: string | null
  issuerCuit?: string | null
  periodClose?: string | null
  periodDue?: string | null
  totalAmount?: string | null
  naturalKey: {
    issuerCuit: string | null
    cardLast4: string | null
    statementNumber: string | null
  } | null
  lines: StatementLineDto[]
  document: StatementDocumentDto
}

/**
 * The matched existing transaction a parsed line likely duplicates (ADR-084/085),
 * adapted for the review table. Money is parsed to a number; `category`/
 * `paymentMethod` are the existing transaction's values (null → undefined) shown
 * in the inline match context + the side-by-side compare.
 */
export interface StatementMatch {
  /** Id of the existing transaction to enrich when the user merges (ADR-085). */
  transactionId: string
  name: string
  occurredOn: string
  amount: number
  category?: string
  paymentMethod?: string
}

/**
 * One adapted line draft the review table consumes (ADR-080). Money is parsed to
 * numbers; `currency`/`fxRateType` are narrowed to the prototype unions. `include`
 * seeds the per-row keep/exclude toggle; `category` seeds the editable selector.
 */
export interface StatementLine {
  /** Stable index-based id for table rows (the backend lines are positional). */
  id: string
  /**
   * The statement pay/due date — the same for every line of a statement (ADR-089).
   * This is what the line is dated/grouped on; the original purchase date lives in
   * {@link purchaseDate}.
   */
  occurredOn: string
  /**
   * The original purchase FECHA (ISO `YYYY-MM-DD`), preserved per line (ADR-089).
   * Shown alongside the pay date ("bought … · paid …") and echoed back on import so
   * the backend can compose the "Compra dd-mm-yy · Cuota n/m" note. Absent on lines
   * the parser couldn't attribute a purchase date to.
   */
  purchaseDate?: string
  name: string
  amount: number
  currency: Currency
  usdAmount?: number
  fxRate?: number
  fxRateType?: FxRateType
  /**
   * The FX snapshot provenance (ADR-148), the persisted preferred rate SOURCE
   * ('oficial'/'bolsa'), stamped at review when a USD-only line is materialized
   * (alongside `fxRate`/`fxRateType`). Carried to import so the row's snapshot is
   * complete; absent for lines with no materialized FX.
   */
  fxSource?: string
  category?: string
  /** Installment label (e.g. "3/12"), shown read-only; carried to import. */
  cuota?: string
  lineKind: StatementLineKind
  /** Default keep/exclude state from the parser (fees may default excluded). */
  include: boolean
  /**
   * Present when this line likely duplicates an existing manual transaction
   * (ADR-084). Flagged rows get the "Possible duplicate" treatment + a per-row
   * Merge / Keep both resolution; absent means a normal (unflagged) line.
   */
  match?: StatementMatch
}

/**
 * The adapted parse result the import flow consumes (ADR-080). On `ok` it carries
 * the detected identity + line drafts; on `unsupported`/`unparseable` the lines
 * are empty and the flow shows the calm manual fallback. The `document` is the
 * ready-to-echo import payload built from the uploaded File.
 */
export interface StatementParse {
  status: StatementParseStatus
  /** Advisory: a statement with this natural key already exists (ADR-077). */
  duplicate: boolean
  /** Normalized issuing bank, e.g. "Galicia" — the value stored as a row's `bank` (ADR-117). */
  bankName?: string
  /** Card network, e.g. "VISA". */
  network?: string
  /** Last 4 of the card, e.g. "5771". */
  cardLast4?: string
  /** Card / detail label for display, e.g. "VISA ·5771"; carried as each line's `card` (ADR-117). */
  card?: string
  statementNumber?: string
  issuerCuit?: string
  /** Statement close date (ISO `YYYY-MM-DD`). */
  periodClose?: string
  /** Statement due date (ISO `YYYY-MM-DD`). */
  periodDue?: string
  totalAmount?: number
  naturalKey: StatementNaturalKey | null
  lines: StatementLine[]
  /** The base64 PDF + record fields to echo back on import. */
  document: StatementDocumentPayload
}

/**
 * How a kept line resolves on import (ADR-085):
 *   - `import`    — no match; create a new expense (the default for unflagged lines).
 *   - `merge`     — flagged, kept as the same expense; enrich the existing
 *                   transaction (`matchTransactionId` REQUIRED).
 *   - `keep_both` — flagged but kept anyway; create a new, separate expense.
 */
export type StatementLineResolution = 'import' | 'merge' | 'keep_both'

/** One line sent on import (camelCase; money as Decimal strings — ADR-025). */
export interface StatementLineRequest {
  /** The statement pay/due date this line is dated on (ADR-089). */
  occurredOn: string
  /**
   * The original purchase FECHA (ISO `YYYY-MM-DD`) echoed back from the parse so the
   * backend composes the "Compra dd-mm-yy · Cuota n/m" note (ADR-089). Omitted when the
   * parsed line carried no purchase date.
   */
  purchaseDate?: string
  name: string
  amount: string
  currency: Currency
  usdAmount?: string
  fxRate?: string
  fxRateType?: FxRateType
  /**
   * The FX snapshot's provenance (ADR-148), the persisted preferred rate SOURCE
   * (e.g. `'mep'`/`'bolsa'`/`'oficial'`) — NOT hardcoded `'manual'`. Sent alongside
   * `fxRate`/`fxRateType` for a materialized USD line so the imported row carries a
   * COMPLETE snapshot; the backend re-materializes `usd_amount = round(amount ÷
   * fx_rate)` only when `fx_source` is set, so omitting it would leave `fx_source`
   * NULL (unauditable) and skip that authoritative re-derivation.
   */
  fxSource?: string
  category?: string
  /** The normalized issuing bank stored as the transaction's `bank` (e.g. "Galicia" — ADR-117). */
  bank?: string
  /** The card / detail label stored as the transaction's `card` (e.g. "VISA ·5771" — ADR-117). */
  card?: string
  cuota?: string
  notes?: string
  /**
   * The card account the frontend deduced + the user confirmed for this line
   * (ADR-184); omitted imports the line unattached (`account_id = null`, backend
   * tolerant). Matched by (institution, currency): an ARS line attaches to the
   * issuer's ARS card account, a USD line to its USD card account.
   */
  accountId?: string
  /** How this line resolves on import (ADR-085); defaults to `import`. */
  resolution: StatementLineResolution
  /** The existing transaction to enrich; REQUIRED when `resolution === 'merge'`. */
  matchTransactionId?: string
}

/** The document echoed back on import (Decimal money as strings — ADR-078). */
export type StatementDocumentRequest = StatementDocumentPayload

/** Request body accepted by `POST /statements/import` (ADR-078). */
export interface StatementImportRequest {
  document: StatementDocumentRequest
  lines: StatementLineRequest[]
}

/**
 * The 201 result of a successful import (ADR-078, ADR-085). Splits the outcome
 * into freshly-created expenses (`import`/`keep_both`) and existing transactions
 * enriched by a merge — so the confirmation can read "N created, M merged".
 */
export interface StatementImportResult {
  statementDocumentId: string
  createdCount: number
  mergedCount: number
  createdTransactionIds: string[]
  mergedTransactionIds: string[]
}

/** An API error that carries the HTTP status so callers can branch on it. */
export class StatementsApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'StatementsApiError'
    this.status = status
  }
}

/**
 * Map an upload status to calm, friendly copy (ADR-072/037/080). 415/413/422 are
 * the documented upload-rejection codes; anything else gets a generic message.
 * The UI shows this verbatim alongside the manual-entry fallback.
 */
function uploadErrorMessage(status: number): string {
  switch (status) {
    case 415:
      return 'That file is not a PDF. Upload the card statement PDF, or add expenses manually.'
    case 413:
      return 'That PDF is too large (over 10 MB). Try a smaller file, or add expenses manually.'
    case 422:
      return "Couldn't read this statement. You can still add expenses manually."
    default:
      return "Couldn't read this statement. You can still add expenses manually."
  }
}

/** Throw a {@link StatementsApiError} for any non-2xx parse response. */
async function ensureParseOk(response: Response): Promise<void> {
  if (response.ok) return
  throw new StatementsApiError(response.status, uploadErrorMessage(response.status))
}

/** Throw a {@link StatementsApiError} for any non-2xx import response. */
async function ensureImportOk(response: Response): Promise<void> {
  if (response.ok) return
  let detail = ''
  try {
    detail = await response.text()
  } catch {
    // Ignore body-read failures; the status is enough for the calm error state.
  }
  throw new StatementsApiError(
    response.status,
    `Statement import failed with ${response.status}${
      detail ? `: ${detail}` : ''
    }`,
  )
}

/** Parse a Decimal string (e.g. "45000.00") to a number; null/absent → undefined. */
function parseMoney(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Narrow the backend currency string to the prototype union (ARS fallback). */
function asCurrency(value: string | null | undefined): Currency {
  return value === 'USD' ? 'USD' : 'ARS'
}

/** Narrow the backend `fxRateType` string to the {@link FxRateType} union. */
function asFxRateType(value: string | null | undefined): FxRateType | undefined {
  return value === null || value === undefined ? undefined : (value as FxRateType)
}

/** Drop empty strings → undefined so optional fields stay clean. */
function nonEmpty(value: string | null | undefined): string | undefined {
  return value ? value : undefined
}

/** Adapt the backend match DTO to the table-ready {@link StatementMatch} (or undefined). */
function adaptMatch(dto: StatementMatchDto | null | undefined): StatementMatch | undefined {
  if (dto === null || dto === undefined) return undefined
  return {
    transactionId: dto.transactionId,
    name: dto.name,
    occurredOn: dto.occurredOn,
    amount: parseMoney(dto.amount) ?? 0,
    ...(nonEmpty(dto.category) ? { category: dto.category as string } : {}),
    ...(nonEmpty(dto.paymentMethod)
      ? { paymentMethod: dto.paymentMethod as string }
      : {}),
  }
}

/** Adapt one backend line DTO to the table-ready {@link StatementLine}. */
function adaptLine(dto: StatementLineDto, index: number): StatementLine {
  const usdAmount = parseMoney(dto.usdAmount)
  const fxRate = parseMoney(dto.fxRate)
  const fxRateType = asFxRateType(dto.fxRateType)
  const match = adaptMatch(dto.match)
  return {
    id: String(index),
    occurredOn: dto.occurredOn,
    ...(nonEmpty(dto.purchaseDate) ? { purchaseDate: dto.purchaseDate as string } : {}),
    name: dto.name,
    amount: parseMoney(dto.amount) ?? 0,
    currency: asCurrency(dto.currency),
    ...(usdAmount !== undefined ? { usdAmount } : {}),
    ...(fxRate !== undefined ? { fxRate } : {}),
    ...(fxRateType !== undefined ? { fxRateType } : {}),
    ...(nonEmpty(dto.category) ? { category: dto.category as string } : {}),
    ...(nonEmpty(dto.cuota) ? { cuota: dto.cuota as string } : {}),
    lineKind: dto.lineKind,
    include: dto.include,
    ...(match !== undefined ? { match } : {}),
  }
}

/**
 * Build the import-time `document` payload from the uploaded File + parse DTO.
 *
 * The PDF bytes come from the client-read base64 (robust — never depends on the
 * parse response echoing them); the statement record fields come from the parsed
 * `document` so the backend stores the same identity it deduped on.
 */
function buildDocument(
  file: File,
  pdfBase64: string,
  doc: StatementDocumentDto,
): StatementDocumentPayload {
  return {
    pdfBase64,
    contentType: doc.contentType || file.type || 'application/pdf',
    ...(doc.byteSize !== null && doc.byteSize !== undefined
      ? { byteSize: doc.byteSize }
      : {}),
    ...(nonEmpty(doc.extractedText) ? { extractedText: doc.extractedText as string } : {}),
    ...(nonEmpty(doc.bankName) ? { bankName: doc.bankName as string } : {}),
    ...(nonEmpty(doc.network) ? { network: doc.network as string } : {}),
    ...(nonEmpty(doc.cardLast4) ? { cardLast4: doc.cardLast4 as string } : {}),
    ...(nonEmpty(doc.issuerCuit) ? { issuerCuit: doc.issuerCuit as string } : {}),
    ...(nonEmpty(doc.statementNumber)
      ? { statementNumber: doc.statementNumber as string }
      : {}),
    ...(nonEmpty(doc.periodClose) ? { periodClose: doc.periodClose as string } : {}),
    ...(nonEmpty(doc.periodDue) ? { periodDue: doc.periodDue as string } : {}),
    ...(nonEmpty(doc.totalAmount) ? { totalAmount: doc.totalAmount as string } : {}),
  }
}

/** Adapt the raw parse DTO + uploaded File into the flow-ready {@link StatementParse}. */
function adaptParse(
  dto: StatementParseDto,
  file: File,
  pdfBase64: string,
): StatementParse {
  const naturalKey: StatementNaturalKey | null = dto.naturalKey
    ? {
        issuerCuit: dto.naturalKey.issuerCuit,
        cardLast4: dto.naturalKey.cardLast4,
        statementNumber: dto.naturalKey.statementNumber,
      }
    : null
  const totalAmount = parseMoney(dto.totalAmount)
  return {
    status: dto.status,
    duplicate: dto.duplicate,
    ...(nonEmpty(dto.bankName) ? { bankName: dto.bankName as string } : {}),
    ...(nonEmpty(dto.network) ? { network: dto.network as string } : {}),
    ...(nonEmpty(dto.cardLast4) ? { cardLast4: dto.cardLast4 as string } : {}),
    ...(nonEmpty(dto.card) ? { card: dto.card as string } : {}),
    ...(nonEmpty(dto.statementNumber)
      ? { statementNumber: dto.statementNumber as string }
      : {}),
    ...(nonEmpty(dto.issuerCuit) ? { issuerCuit: dto.issuerCuit as string } : {}),
    ...(nonEmpty(dto.periodClose) ? { periodClose: dto.periodClose as string } : {}),
    ...(nonEmpty(dto.periodDue) ? { periodDue: dto.periodDue as string } : {}),
    ...(totalAmount !== undefined ? { totalAmount } : {}),
    naturalKey,
    lines: dto.lines.map(adaptLine),
    document: buildDocument(file, pdfBase64, dto.document),
  }
}

/**
 * Upload a PDF to `POST /statements/parse` and adapt the result for review.
 *
 * Reads the File as base64 (for the import-time `document` echo) and POSTs the
 * raw file as multipart in parallel. Throws {@link StatementsApiError} on a 4xx
 * upload rejection (415/413/422) so the UI offers the calm manual fallback
 * (ADR-080); an unsupported-but-valid or unreadable PDF returns `200` with
 * `status: 'unsupported' | 'unparseable'` (not an error — the caller branches on
 * the status).
 *
 * @param file The user-selected PDF (multipart field name `file`).
 */
export async function parseStatement(file: File): Promise<StatementParse> {
  const form = new FormData()
  form.append('file', file)

  // Read the bytes (for the import echo) and upload (for parsing) together.
  const [pdfBase64, response] = await Promise.all([
    fileToBase64(file),
    authedFetch(apiUrl('/statements/parse'), {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: form,
    }),
  ])

  await ensureParseOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<StatementParseDto>
  return adaptParse(envelope.data, file, pdfBase64)
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const

/**
 * Import the reviewed selection to `POST /statements/import` (ADR-078, ADR-085).
 * The body echoes the document payload and carries ONLY the lines the user kept,
 * each with its `resolution` (and `matchTransactionId` for merges). The backend
 * creates one expense per `import`/`keep_both` line, enriches the existing
 * transaction for each `merge`, and returns the split created/merged ids.
 */
export async function importStatement(
  payload: StatementImportRequest,
): Promise<StatementImportResult> {
  const response = await authedFetch(apiUrl('/statements/import'), {
    method: 'POST',
    headers: { ...JSON_HEADERS, Accept: 'application/json' },
    body: JSON.stringify(payload),
  })
  await ensureImportOk(response)
  const envelope =
    (await response.json()) as ResponseEnvelope<StatementImportResult>
  return envelope.data
}

/**
 * The view/download URL for a stored statement PDF (ADR-078).
 * `GET /statements/{statementDocumentId}/document` streams the PDF inline.
 *
 * NOTE: every API route now requires `Authorization: Bearer <token>` (ADR-092),
 * so this URL can no longer be used directly as an `<a href>` (a plain GET sends
 * no token and 401s). It remains the single place the path is assembled; the UI
 * fetches the bytes through {@link fetchStatementDocument} (authed) instead.
 */
export function statementDocumentUrl(statementDocumentId: string): string {
  return apiUrl(`/statements/${statementDocumentId}/document`)
}

/** The PDF MIME type the document endpoints serve (ADR-078). */
const _PDF_CONTENT_TYPE = 'application/pdf'

/**
 * Fetch a stored statement PDF as a {@link Blob}, authenticated.
 *
 * `GET /statements/{statementDocumentId}/document` is behind the Supabase bearer
 * guard (ADR-092), so we go through {@link authedFetch} — a plain `<a href>` GET
 * cannot attach the token and would 401. The caller turns the Blob into a
 * short-lived object URL, opens/downloads it, then revokes the URL (the bytes are
 * sensitive PII — ADR-081 — so they never become a persistent, shareable link).
 * Throws {@link StatementsApiError} carrying the HTTP status on any non-2xx.
 *
 * @param statementDocumentId The stored statement document whose PDF to fetch.
 * @returns The PDF bytes as a Blob (its `type` reflects the backend content type).
 */
export async function fetchStatementDocument(
  statementDocumentId: string,
): Promise<Blob> {
  const response = await authedFetch(
    statementDocumentUrl(statementDocumentId),
    { headers: { Accept: _PDF_CONTENT_TYPE } },
  )
  if (!response.ok) {
    throw new StatementsApiError(
      response.status,
      "Couldn't open the statement PDF. Please try again.",
    )
  }
  return response.blob()
}

/** The statements API client, grouped for ergonomic import. */
export const statementsClient = {
  parseStatement,
  importStatement,
  statementDocumentUrl,
  fetchStatementDocument,
} as const
