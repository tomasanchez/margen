/**
 * Real transactions API client + DTO adapter (ADR-033, ADR-034).
 *
 * This is the single boundary between the backend's REST contract
 * (`GET|POST|PATCH|DELETE /api/v1/transactions`, a `{ data }` envelope, camelCase
 * field names, UUID string ids, Decimal-string money) and the frontend's
 * existing {@link Transaction} shape. Components, formatters and the query hooks
 * keep speaking the prototype shape unchanged; every contract difference
 * (envelope unwrap, Decimal-string → number, `occurredOn` ⇄ `dispDate`/`month`,
 * `bank` ⇄ payment method) is resolved here.
 *
 * The mock async module (ADR-015) is removed for transactions in favor of this
 * client; the remaining mock slices (trend/breakdown/insights/Monotributo) keep
 * their own seams until #6/#8/#10 ship (ADR-035).
 */

import { apiUrl } from '../config'
import type {
  Bank,
  Category,
  Currency,
  MonthName,
  NewTransactionInput,
  Transaction,
  TxKind,
  TxType,
} from '../mock/types'

/**
 * The shape the Add/Edit form produces for an update. It is a partial of the
 * create input (every field optional); the API treats omitted fields as
 * unchanged (ADR-028). In practice the form sends a full input, but typing the
 * patch as partial keeps the contract honest.
 */
export type TransactionUpdateInput = Partial<NewTransactionInput>

/** The backend `{ data: T }` response envelope (ADR-030). */
interface ResponseEnvelope<T> {
  data: T
}

/**
 * The transaction DTO as serialized by the backend. Money fields arrive as
 * Decimal strings (ADR-025); `id`/`occurredOn` are strings; the rest match the
 * mock field names (ADR-024). Optional fields may be `null` or absent.
 */
export interface TransactionDto {
  id: string
  occurredOn: string
  dispDate: string
  month: string
  name: string
  notes?: string | null
  category?: string | null
  bank?: string | null
  currency: Currency
  type: TxType
  kind: TxKind
  amountNum: string
  usd?: string | null
  rate?: string | null
  fxRateType?: string | null
  fxRateAsOf?: string | null
  recurring: boolean
  countsTowardMonotributo: boolean
  createdAt: string
  updatedAt: string
}

/** Request body accepted by `POST /transactions` (camelCase, ADR-024). */
interface TransactionCreateBody {
  occurredOn: string
  kind: TxKind
  amountNum: number
  currency: Currency
  name: string
  category?: string
  bank?: string
  usd?: number
  rate?: number
  recurring?: boolean
  countsTowardMonotributo?: boolean
  notes?: string
}

/** Request body accepted by `PATCH /transactions/{id}` (all fields optional). */
type TransactionPatchBody = Partial<TransactionCreateBody>

/** An API error that carries the HTTP status so callers can branch on it. */
export class TransactionApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'TransactionApiError'
    this.status = status
  }
}

/** Throw a {@link TransactionApiError} for any non-2xx response. */
async function ensureOk(response: Response): Promise<void> {
  if (response.ok) return
  let detail = ''
  try {
    detail = await response.text()
  } catch {
    // Ignore body-read failures; the status is enough for the calm error state.
  }
  throw new TransactionApiError(
    response.status,
    `Transactions API request failed with ${response.status}${
      detail ? `: ${detail}` : ''
    }`,
  )
}

/** Parse a Decimal string (e.g. "45000.00") to a number; `null`/absent → undefined. */
function parseMoney(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Narrow an arbitrary string to one of the prototype's known categories. */
function asCategory(value: string | null | undefined): Category {
  return (value ?? 'Other') as Category
}

/** Narrow an arbitrary string to one of the prototype's known banks. */
function asBank(value: string | null | undefined): Bank {
  return (value ?? 'Transfer') as Bank
}

/** Narrow the backend month name to the prototype's {@link MonthName} union. */
function asMonth(value: string): MonthName {
  return value as MonthName
}

/**
 * Adapt a backend {@link TransactionDto} to the frontend {@link Transaction}.
 *
 * Parses Decimal-string money to numbers (ADR-034), keeps the UUID string id,
 * carries `occurredOn` (ISO date) so Home can filter by year+month (ADR-040),
 * and drops the contract-only fields the UI does not consume (notes, FX rate
 * metadata, timestamps) — the screens stay untouched.
 */
export function adaptTransaction(dto: TransactionDto): Transaction {
  const usd = parseMoney(dto.usd)
  const rate = parseMoney(dto.rate)
  return {
    id: dto.id,
    occurredOn: dto.occurredOn,
    dispDate: dto.dispDate,
    month: asMonth(dto.month),
    name: dto.name,
    category: asCategory(dto.category),
    bank: asBank(dto.bank),
    currency: dto.currency,
    type: dto.type,
    kind: dto.kind,
    amountNum: parseMoney(dto.amountNum) ?? 0,
    ...(usd !== undefined ? { usd } : {}),
    ...(rate !== undefined ? { rate } : {}),
    ...(dto.recurring ? { recurring: dto.recurring } : {}),
  }
}

const MONTH_ABBREVIATIONS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
}

const MONTH_NAME_INDEX: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
}

/** Format a (year, monthIndex, day) tuple as an ISO `YYYY-MM-DD` calendar date. */
function toIsoDate(year: number, monthIndex: number, day: number): string {
  const mm = String(monthIndex + 1).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  return `${year}-${mm}-${dd}`
}

/**
 * Derive the backend's required `occurredOn` ISO date from the form input.
 *
 * The Add/Edit form carries `dispDate` (e.g. "Jun 13") and, on edits, the full
 * `month` name; neither has a year. We resolve the month from `dispDate`'s
 * abbreviation (falling back to the `month` field), the day from `dispDate`, and
 * default the year to the current calendar year. This mapping lives only here so
 * the form is never redesigned (ADR-033).
 */
export function deriveOccurredOn(
  input: Pick<NewTransactionInput, 'dispDate' | 'month'>,
  today: Date = new Date(),
): string {
  const year = today.getFullYear()
  const parts = input.dispDate.trim().split(/\s+/)
  const abbrev = (parts[0] ?? '').slice(0, 3).toLowerCase()
  const day = Number.parseInt(parts[1] ?? '', 10)

  let monthIndex = MONTH_ABBREVIATIONS[abbrev]
  if (monthIndex === undefined && input.month) {
    monthIndex = MONTH_NAME_INDEX[input.month.toLowerCase()]
  }
  if (monthIndex === undefined) monthIndex = today.getMonth()
  const safeDay = Number.isFinite(day) && day >= 1 && day <= 31 ? day : today.getDate()

  return toIsoDate(year, monthIndex, safeDay)
}

/**
 * Map a {@link NewTransactionInput} from the form to the backend create body.
 *
 * Derives `occurredOn` from the form date (ADR-033), passes the camelCase money
 * fields straight through (`amountNum`/`usd`/`rate`), and omits empty optionals
 * so the lenient backend (ADR-031) applies its own defaults. `type` is never
 * sent — the backend derives it from `kind` (ADR-027).
 */
export function toCreateBody(input: NewTransactionInput): TransactionCreateBody {
  const body: TransactionCreateBody = {
    occurredOn: deriveOccurredOn(input),
    kind: input.kind,
    amountNum: input.amountNum,
    currency: input.currency,
    name: input.name,
    category: input.category,
    bank: input.bank,
    countsTowardMonotributo: input.countsTowardMonotributo ?? false,
  }
  if (input.usd !== undefined) body.usd = input.usd
  if (input.rate !== undefined) body.rate = input.rate
  if (input.recurring !== undefined) body.recurring = input.recurring
  if (input.notes) body.notes = input.notes
  return body
}

/**
 * Map a {@link TransactionUpdateInput} to the backend patch body. Only the fields
 * the patch actually carries are sent; an omitted field leaves the stored value
 * unchanged (ADR-028). When the patch carries a date (`dispDate`), `occurredOn`
 * is derived from it.
 */
export function toPatchBody(
  patch: TransactionUpdateInput,
): TransactionPatchBody {
  const body: TransactionPatchBody = {}
  if (patch.dispDate !== undefined) {
    body.occurredOn = deriveOccurredOn({
      dispDate: patch.dispDate,
      month: patch.month,
    })
  }
  if (patch.kind !== undefined) body.kind = patch.kind
  if (patch.amountNum !== undefined) body.amountNum = patch.amountNum
  if (patch.currency !== undefined) body.currency = patch.currency
  if (patch.name !== undefined) body.name = patch.name
  if (patch.category !== undefined) body.category = patch.category
  if (patch.bank !== undefined) body.bank = patch.bank
  if (patch.usd !== undefined) body.usd = patch.usd
  if (patch.rate !== undefined) body.rate = patch.rate
  if (patch.recurring !== undefined) body.recurring = patch.recurring
  if (patch.notes !== undefined) body.notes = patch.notes
  if (patch.countsTowardMonotributo !== undefined) {
    body.countsTowardMonotributo = patch.countsTowardMonotributo
  }
  return body
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const

/** GET all transactions (newest-first), adapted to the frontend shape. */
async function list(): Promise<Transaction[]> {
  const response = await fetch(apiUrl('/transactions'), {
    headers: { Accept: 'application/json' },
  })
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<TransactionDto[]>
  return envelope.data.map(adaptTransaction)
}

/** POST a new transaction; returns the persisted, adapted row. */
async function create(input: NewTransactionInput): Promise<Transaction> {
  const response = await fetch(apiUrl('/transactions'), {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(toCreateBody(input)),
  })
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<TransactionDto>
  return adaptTransaction(envelope.data)
}

/** PATCH a transaction by UUID; returns the refreshed, adapted row. */
async function update(
  id: string,
  patch: TransactionUpdateInput,
): Promise<Transaction> {
  const response = await fetch(apiUrl(`/transactions/${id}`), {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(toPatchBody(patch)),
  })
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<TransactionDto>
  return adaptTransaction(envelope.data)
}

/** DELETE a transaction by UUID (204, no body). */
async function remove(id: string): Promise<void> {
  const response = await fetch(apiUrl(`/transactions/${id}`), {
    method: 'DELETE',
  })
  await ensureOk(response)
}

/** The transactions API client, grouped for ergonomic import. */
export const transactionsClient = {
  list,
  create,
  update,
  remove,
} as const
