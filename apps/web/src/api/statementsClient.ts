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

/** A single parsed statement line as serialized by the backend (camelCase). */
interface StatementLineDto {
  occurredOn: string
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
  paymentMethod?: string | null
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
 * One adapted line draft the review table consumes (ADR-080). Money is parsed to
 * numbers; `currency`/`fxRateType` are narrowed to the prototype unions. `include`
 * seeds the per-row keep/exclude toggle; `category` seeds the editable selector.
 */
export interface StatementLine {
  /** Stable index-based id for table rows (the backend lines are positional). */
  id: string
  occurredOn: string
  name: string
  amount: number
  currency: Currency
  usdAmount?: number
  fxRate?: number
  fxRateType?: FxRateType
  category?: string
  /** Installment label (e.g. "3/12"), shown read-only; carried to import. */
  cuota?: string
  lineKind: StatementLineKind
  /** Default keep/exclude state from the parser (fees may default excluded). */
  include: boolean
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
  /** Detected bank, e.g. "Galicia". */
  bankName?: string
  /** Card network, e.g. "VISA". */
  network?: string
  /** Last 4 of the card, e.g. "5771". */
  cardLast4?: string
  /** Display label for the card, e.g. "Galicia VISA ·5771"; carried as `bank`. */
  paymentMethod?: string
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

/** One line sent on import (camelCase; money as Decimal strings — ADR-025). */
export interface StatementLineRequest {
  occurredOn: string
  name: string
  amount: string
  currency: Currency
  usdAmount?: string
  fxRate?: string
  fxRateType?: FxRateType
  category?: string
  /** The card payment method carried as the transaction's bank (ADR-078). */
  bank?: string
  cuota?: string
  notes?: string
}

/** The document echoed back on import (Decimal money as strings — ADR-078). */
export type StatementDocumentRequest = StatementDocumentPayload

/** Request body accepted by `POST /statements/import` (ADR-078). */
export interface StatementImportRequest {
  document: StatementDocumentRequest
  lines: StatementLineRequest[]
}

/** The 201 result of a successful import (ADR-078). */
export interface StatementImportResult {
  statementDocumentId: string
  createdCount: number
  transactionIds: string[]
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

/** Adapt one backend line DTO to the table-ready {@link StatementLine}. */
function adaptLine(dto: StatementLineDto, index: number): StatementLine {
  const usdAmount = parseMoney(dto.usdAmount)
  const fxRate = parseMoney(dto.fxRate)
  const fxRateType = asFxRateType(dto.fxRateType)
  return {
    id: String(index),
    occurredOn: dto.occurredOn,
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
    ...(nonEmpty(dto.paymentMethod)
      ? { paymentMethod: dto.paymentMethod as string }
      : {}),
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
    fetch(apiUrl('/statements/parse'), {
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
 * Import the reviewed selection to `POST /statements/import` (ADR-078). The body
 * echoes the document payload and carries ONLY the lines the user kept; the
 * backend creates one expense per line and returns the created ids.
 */
export async function importStatement(
  payload: StatementImportRequest,
): Promise<StatementImportResult> {
  const response = await fetch(apiUrl('/statements/import'), {
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
 */
export function statementDocumentUrl(statementDocumentId: string): string {
  return apiUrl(`/statements/${statementDocumentId}/document`)
}

/** The statements API client, grouped for ergonomic import. */
export const statementsClient = {
  parseStatement,
  importStatement,
  statementDocumentUrl,
} as const
