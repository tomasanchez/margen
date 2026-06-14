/**
 * ARCA invoice import API client + DTO adapter (ADR-070, ADR-072).
 *
 * The single boundary between the backend's invoice contract and the Add/Edit
 * form's prefill. It owns three responsibilities:
 *
 *   1. `parseInvoice(file)` — uploads a PDF (multipart) to `POST /invoices/parse`,
 *      unwraps the `{ data }` envelope (ADR-030), parses Decimal-string money to
 *      numbers (ADR-025/034), and ALSO reads the same File as base64 so the
 *      confirm step can persist + link the PDF on create. The base64 document is
 *      built client-side (robust: it never depends on the parse response echoing
 *      the bytes back) and carries the parsed natural-key/record fields the
 *      backend's `document` payload expects.
 *   2. `documentUrl(transactionId)` — the GET URL for the stored PDF, used by the
 *      attachment badge to view/download it.
 *   3. `InvoicesApiError` — a status-carrying error mapping 415/413/422 to calm,
 *      friendly messages for the manual-fallback flow (ADR-072/037).
 *
 * Mirrors {@link transactionsClient} / {@link summariesClient}: `apiUrl()` for the
 * versioned URL, a status-carrying typed error, and Decimal-string → number
 * parsing at this seam so the form speaks plain numbers.
 */

import { apiUrl } from '../config'
import type { Currency, FxRateType } from '../mock/types'

/** The backend `{ data: T }` response envelope (ADR-030). */
interface ResponseEnvelope<T> {
  data: T
}

/**
 * The parse outcome (ADR-069). `okQr` / `okTextFallback` carry prefill fields;
 * `unparseable` carries none and triggers the calm manual fallback (ADR-072).
 * The backend serializes the `StrEnum` values in snake_case.
 */
export type InvoiceParseStatus = 'ok_qr' | 'ok_text_fallback' | 'unparseable'

/** The fiscal natural key computed from the parsed invoice (ADR-068). */
export interface InvoiceNaturalKey {
  emisorCuit: string | null
  ptoVta: number | null
  tipoCmp: number | null
  nroCmp: number | null
}

/**
 * The raw parse DTO as serialized by the backend (camelCase, Decimal money as
 * strings — ADR-025). Every prefill field is optional/nullable because an
 * unparseable PDF leaves them empty.
 */
interface InvoiceParseDto {
  status: InvoiceParseStatus
  duplicate: boolean
  naturalKey: {
    emisorCuit: string | null
    ptoVta: number | null
    tipoCmp: number | null
    nroCmp: number | null
  } | null
  occurredOn: string | null
  name: string | null
  kind: string | null
  amount: string | null
  currency: string | null
  usdAmount: string | null
  fxRate: string | null
  fxRateType: string | null
  fxRateAsOf: string | null
  category: string | null
  countsTowardMonotributo: boolean | null
}

/**
 * The base64 invoice attachment echoed back on `POST /transactions` so the
 * backend stores + links the PDF (ADR-070/071). `pdfBase64` is the client-read
 * base64 of the uploaded File; the rest are the parsed record/natural-key fields.
 * Sent verbatim under the create body's `document` key.
 */
export interface InvoiceDocumentPayload {
  pdfBase64: string
  contentType: string
  emisorCuit?: string
  ptoVta?: string
  tipoCmp?: string
  nroCmp?: string
  fecha?: string
  importe?: number
  moneda?: string
  ctz?: number
}

/**
 * The adapted parse result the Add flow consumes (ADR-072). Money is parsed to
 * numbers; `currency`/`fxRateType` are narrowed to the prototype unions. The
 * `document` is the ready-to-send create payload built from the uploaded File.
 */
export interface InvoiceParse {
  status: InvoiceParseStatus
  /** Advisory: a document with this natural key already exists (ADR-071). */
  duplicate: boolean
  naturalKey: InvoiceNaturalKey | null
  /** Mapped prefill fields (absent on an unparseable PDF). */
  occurredOn?: string
  name?: string
  amount?: number
  currency?: Currency
  usdAmount?: number
  fxRate?: number
  fxRateType?: FxRateType
  fxRateAsOf?: string
  category?: string
  countsTowardMonotributo?: boolean
  /** The base64 PDF + record fields to persist on confirm. */
  document: InvoiceDocumentPayload
}

/** An API error that carries the HTTP status so callers can branch on it. */
export class InvoicesApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'InvoicesApiError'
    this.status = status
  }
}

/**
 * Map an upload status to calm, friendly copy (ADR-072/037). 415/413/422 are the
 * documented upload-rejection codes; anything else gets a generic "couldn't read"
 * message. The UI shows this verbatim alongside the "Enter manually" fallback.
 */
function uploadErrorMessage(status: number): string {
  switch (status) {
    case 415:
      return 'That file is not a PDF. Upload the ARCA invoice PDF, or enter it manually.'
    case 413:
      return 'That PDF is too large (over 10 MB). Try a smaller file, or enter it manually.'
    case 422:
      return "Couldn't read this as an ARCA invoice. You can enter it manually."
    default:
      return "Couldn't read this as an ARCA invoice. You can enter it manually."
  }
}

/** Throw an {@link InvoicesApiError} for any non-2xx parse response. */
async function ensureOk(response: Response): Promise<void> {
  if (response.ok) return
  throw new InvoicesApiError(response.status, uploadErrorMessage(response.status))
}

/** Parse a Decimal string (e.g. "45000.00") to a number; null/absent → undefined. */
function parseMoney(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Narrow the backend currency string to the prototype union (defaults to ARS). */
function asCurrency(value: string | null | undefined): Currency | undefined {
  if (value === 'USD') return 'USD'
  if (value === 'ARS') return 'ARS'
  return undefined
}

/** Narrow the backend `fxRateType` string to the {@link FxRateType} union. */
function asFxRateType(
  value: string | null | undefined,
): FxRateType | undefined {
  return value === null || value === undefined
    ? undefined
    : (value as FxRateType)
}

/**
 * Read a File as a base64 string (no data-URI prefix), for the create payload.
 *
 * Uses {@link FileReader} (native, no deps) and strips the
 * `data:<mime>;base64,` prefix so the value is the bare base64 the backend
 * `pdfBase64` field decodes. Rejects if the file cannot be read.
 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () =>
      reject(new InvoicesApiError(0, 'Could not read the selected file.'))
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new InvoicesApiError(0, 'Could not read the selected file.'))
        return
      }
      // `result` is a data URI: "data:application/pdf;base64,<payload>".
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.readAsDataURL(file)
  })
}

/** A natural-key int field as the string the backend's `document` expects. */
function asKeyString(value: number | null | undefined): string | undefined {
  return value === null || value === undefined ? undefined : String(value)
}

/**
 * Build the create-time `document` payload from the uploaded File + parse DTO.
 *
 * The PDF bytes come from the client-read base64 (robust — never depends on the
 * parse response echoing them); the fiscal record fields come from the parse
 * result so the backend stores the same natural key it deduped on.
 */
function buildDocument(
  file: File,
  pdfBase64: string,
  dto: InvoiceParseDto,
): InvoiceDocumentPayload {
  const key = dto.naturalKey
  const importe = parseMoney(dto.amount)
  const ctz = parseMoney(dto.fxRate)
  return {
    pdfBase64,
    contentType: file.type || 'application/pdf',
    ...(key?.emisorCuit ? { emisorCuit: key.emisorCuit } : {}),
    ...(asKeyString(key?.ptoVta) !== undefined
      ? { ptoVta: asKeyString(key?.ptoVta) }
      : {}),
    ...(asKeyString(key?.tipoCmp) !== undefined
      ? { tipoCmp: asKeyString(key?.tipoCmp) }
      : {}),
    ...(asKeyString(key?.nroCmp) !== undefined
      ? { nroCmp: asKeyString(key?.nroCmp) }
      : {}),
    ...(dto.occurredOn ? { fecha: dto.occurredOn } : {}),
    ...(importe !== undefined ? { importe } : {}),
    ...(dto.currency ? { moneda: dto.currency } : {}),
    ...(ctz !== undefined ? { ctz } : {}),
  }
}

/** Adapt the raw parse DTO + uploaded File into the form-ready {@link InvoiceParse}. */
function adaptParse(
  dto: InvoiceParseDto,
  file: File,
  pdfBase64: string,
): InvoiceParse {
  const naturalKey: InvoiceNaturalKey | null = dto.naturalKey
    ? {
        emisorCuit: dto.naturalKey.emisorCuit,
        ptoVta: dto.naturalKey.ptoVta,
        tipoCmp: dto.naturalKey.tipoCmp,
        nroCmp: dto.naturalKey.nroCmp,
      }
    : null

  const amount = parseMoney(dto.amount)
  const usdAmount = parseMoney(dto.usdAmount)
  const fxRate = parseMoney(dto.fxRate)
  const currency = asCurrency(dto.currency)
  const fxRateType = asFxRateType(dto.fxRateType)

  return {
    status: dto.status,
    duplicate: dto.duplicate,
    naturalKey,
    ...(dto.occurredOn ? { occurredOn: dto.occurredOn } : {}),
    ...(dto.name ? { name: dto.name } : {}),
    ...(amount !== undefined ? { amount } : {}),
    ...(currency !== undefined ? { currency } : {}),
    ...(usdAmount !== undefined ? { usdAmount } : {}),
    ...(fxRate !== undefined ? { fxRate } : {}),
    ...(fxRateType !== undefined ? { fxRateType } : {}),
    ...(dto.fxRateAsOf ? { fxRateAsOf: dto.fxRateAsOf } : {}),
    ...(dto.category ? { category: dto.category } : {}),
    ...(dto.countsTowardMonotributo !== null &&
    dto.countsTowardMonotributo !== undefined
      ? { countsTowardMonotributo: dto.countsTowardMonotributo }
      : {}),
    document: buildDocument(file, pdfBase64, dto),
  }
}

/**
 * Upload a PDF to `POST /invoices/parse` and adapt the result for prefill.
 *
 * Reads the File as base64 (for the confirm-time `document`) and POSTs the raw
 * file as multipart in parallel. Throws {@link InvoicesApiError} on a 4xx upload
 * rejection (415/413/422) so the UI offers the calm manual fallback (ADR-072); an
 * unparseable-but-valid PDF returns `200` with `status: 'unparseable'` (not an
 * error — the caller branches on the status).
 *
 * @param file The user-selected PDF (multipart field name `file`).
 */
export async function parseInvoice(file: File): Promise<InvoiceParse> {
  const form = new FormData()
  form.append('file', file)

  // Read the bytes (for the create payload) and upload (for parsing) together.
  const [pdfBase64, response] = await Promise.all([
    fileToBase64(file),
    fetch(apiUrl('/invoices/parse'), {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: form,
    }),
  ])

  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<InvoiceParseDto>
  return adaptParse(envelope.data, file, pdfBase64)
}

/**
 * The view/download URL for a transaction's stored invoice PDF (ADR-072).
 * `GET /invoices/{transactionId}/document` streams the PDF inline; the
 * attachment badge opens it in a new tab.
 */
export function documentUrl(transactionId: string): string {
  return apiUrl(`/invoices/${transactionId}/document`)
}

/** The invoices API client, grouped for ergonomic import. */
export const invoicesClient = {
  parseInvoice,
  documentUrl,
} as const
