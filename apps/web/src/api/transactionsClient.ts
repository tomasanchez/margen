/**
 * Real transactions API client + DTO adapter (ADR-033, ADR-034).
 *
 * This is the single boundary between the backend's REST contract
 * (`GET|POST|PATCH|DELETE /api/v1/transactions`, a `{ data }` envelope, camelCase
 * field names, UUID string ids, Decimal-string money) and the frontend's
 * existing {@link Transaction} shape. Components, formatters and the query hooks
 * keep speaking the prototype shape unchanged; every contract difference
 * (envelope unwrap, Decimal-string → number, `occurredOn` carried straight from
 * the form's date picker, `bank` ⇄ payment method) is resolved here.
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
  FxRateType,
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
  fxRateType?: FxRateType
  fxRateAsOf?: string
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

/** Narrow the backend `fx_rate_type` string to the {@link FxRateType} union. */
function asFxRateType(
  value: string | null | undefined,
): FxRateType | undefined {
  return value === null || value === undefined
    ? undefined
    : (value as FxRateType)
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
  const fxRateType = asFxRateType(dto.fxRateType)
  const fxRateAsOf = dto.fxRateAsOf ?? undefined
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
    // FX source/as-of drive the row's source indicator (ADR-045); only USD rows
    // carry them, so keep them off ARS rows to keep the shape clean.
    ...(fxRateType !== undefined ? { fxRateType } : {}),
    ...(fxRateAsOf !== undefined ? { fxRateAsOf } : {}),
    ...(dto.recurring ? { recurring: dto.recurring } : {}),
  }
}

/**
 * Map a {@link NewTransactionInput} from the form to the backend create body.
 *
 * Sends the picker's real `occurredOn` ISO date straight through (ADR-041 — no
 * more dispDate+current-year derivation), passes the camelCase money fields
 * straight through (`amountNum`/`usd`/`rate`), and omits empty optionals so the
 * lenient backend (ADR-031) applies its own defaults. `type` is never sent — the
 * backend derives it from `kind` (ADR-027).
 */
export function toCreateBody(input: NewTransactionInput): TransactionCreateBody {
  const body: TransactionCreateBody = {
    occurredOn: input.occurredOn,
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
  if (input.fxRateType !== undefined) body.fxRateType = input.fxRateType
  if (input.fxRateAsOf !== undefined) body.fxRateAsOf = input.fxRateAsOf
  if (input.recurring !== undefined) body.recurring = input.recurring
  if (input.notes) body.notes = input.notes
  return body
}

/**
 * Map a {@link TransactionUpdateInput} to the backend patch body. Only the fields
 * the patch actually carries are sent; an omitted field leaves the stored value
 * unchanged (ADR-028). When the patch carries a date, the picker's real
 * `occurredOn` ISO date is sent directly (ADR-041).
 */
export function toPatchBody(
  patch: TransactionUpdateInput,
): TransactionPatchBody {
  const body: TransactionPatchBody = {}
  if (patch.occurredOn !== undefined) {
    body.occurredOn = patch.occurredOn
  }
  if (patch.kind !== undefined) body.kind = patch.kind
  if (patch.amountNum !== undefined) body.amountNum = patch.amountNum
  if (patch.currency !== undefined) body.currency = patch.currency
  if (patch.name !== undefined) body.name = patch.name
  if (patch.category !== undefined) body.category = patch.category
  if (patch.bank !== undefined) body.bank = patch.bank
  if (patch.usd !== undefined) body.usd = patch.usd
  if (patch.rate !== undefined) body.rate = patch.rate
  if (patch.fxRateType !== undefined) body.fxRateType = patch.fxRateType
  if (patch.fxRateAsOf !== undefined) body.fxRateAsOf = patch.fxRateAsOf
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
