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
import { authedFetch } from './http'
import type {
  Bank,
  Category,
  Currency,
  FxRateType,
  MonthName,
  NewTransactionInput,
  RecurringCadence,
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
  /**
   * Card-level display detail (ADR-117), e.g. "AMEX ·1234" / "Visa"; `null` when
   * none. Distinct from the normalized, filterable `bank`. May be absent on
   * legacy rows.
   */
  card?: string | null
  /**
   * The account this transaction is attributed to (ADR-122/133), or `null` when
   * unlinked. Nullable per ADR-133; absent on legacy rows. Supersedes the bank
   * tag for attribution while `bank`/`card` stay for display (ADR-117).
   */
  accountId?: string | null
  currency: Currency
  type: TxType
  kind: TxKind
  /**
   * The EXPENSE a reimbursement offsets (ADR-159), or `null` when this isn't a
   * reimbursement. For a `kind='reimbursement'` row `type` is `'income'` and the
   * FX fields (`usd`/`rate`/`fxSource`) are `null` — its USD value inherits the
   * linked expense's rate (ADR-161). Absent on legacy payloads.
   */
  offsetsTransactionId?: string | null
  amountNum: string
  usd?: string | null
  rate?: string | null
  /** Materialized USD equivalent of the FX snapshot (ADR-148); absent pre-snapshot. */
  usdAmount?: string | null
  /** The captured FX snapshot rate, ARS per 1 USD as a Decimal string (ADR-148). */
  fxRate?: string | null
  /** Provenance of the FX snapshot rate (ADR-148): 'bolsa'/'oficial'/'manual'/'backfill'. */
  fxSource?: string | null
  fxRateType?: string | null
  fxRateAsOf?: string | null
  recurring: boolean
  /** Recurrence cadence for the forecast (ADR-174); null/absent for a one-off. */
  recurringCadence?: string | null
  /** Total cuotas of an installment plan (ADR-174); null/absent otherwise. */
  installmentsTotal?: number | null
  /** 1-based position in the installment plan (ADR-174); null/absent otherwise. */
  installmentsIndex?: number | null
  countsTowardMonotributo: boolean
  createdAt: string
  updatedAt: string
}

/**
 * The optional imported-invoice attachment sent on create (ADR-070/071). The PDF
 * crosses the boundary as base64 (`pdfBase64`); the rest is the parsed fiscal
 * record the backend stores alongside it. Built by `api/invoicesClient`.
 */
interface TransactionDocumentBody {
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

/** Request body accepted by `POST /transactions` (camelCase, ADR-024). */
interface TransactionCreateBody {
  occurredOn: string
  kind: TxKind
  amountNum: number
  currency: Currency
  name: string
  category?: string
  bank?: string
  /** Card-level display detail (ADR-117); import-set, preserved on edit. */
  card?: string
  /**
   * The account to attribute the transaction to (ADR-122/133), or `null` for
   * none. Ownership is enforced server-side — a user may only link their own
   * account (ADR-130).
   */
  accountId?: string | null
  /**
   * The source EXPENSE a reimbursement pays back (ADR-159). Sent ONLY for a
   * `kind='reimbursement'` create so the backend links the payback and nets the
   * category-month spend (ADR-160). Omitted for every other kind.
   */
  offsetsTransactionId?: string
  usd?: number
  rate?: number
  /** Client-supplied FX snapshot rate as a Decimal string (ARS per 1 USD, ADR-148/149). */
  fxRate?: string
  /** Provenance of the FX snapshot rate (ADR-148): 'bolsa'/'oficial'/'manual'/'backfill'. */
  fxSource?: string
  fxRateType?: FxRateType
  fxRateAsOf?: string
  recurring?: boolean
  /** Recurrence cadence for the forecast (ADR-174); omitted for a one-off. */
  recurringCadence?: RecurringCadence | null
  /** Total cuotas of an installment plan (ADR-174); omitted otherwise. */
  installmentsTotal?: number | null
  /** 1-based position in the installment plan (ADR-174); omitted otherwise. */
  installmentsIndex?: number | null
  countsTowardMonotributo?: boolean
  notes?: string
  /** Optional imported-invoice PDF + record to store and link (ADR-070/071). */
  document?: TransactionDocumentBody
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

/**
 * Whether a client-supplied `fxRate` Decimal string is a valid POSITIVE rate.
 * The FX snapshot only materializes `usd_amount` when the rate is > 0 (ADR-148);
 * an absent, empty, non-numeric, or non-positive rate means "no snapshot".
 */
function hasPositiveFxRate(value: string | undefined): value is string {
  if (value === undefined) return false
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed > 0
}

/** Narrow an arbitrary string to one of the prototype's known categories. */
function asCategory(value: string | null | undefined): Category {
  return (value ?? 'Other') as Category
}

/**
 * Narrow an arbitrary string to one of the normalized banks (ADR-117). The
 * `bank` column was DECOMMISSIONED (ADR-136): attribution now comes from the
 * linked account, and the backend no longer sends `bank` for manual rows. An
 * absent value therefore maps to the EMPTY "no bank" sentinel (`''`) — NOT to
 * `'Transfer'`, which would fabricate a bogus tag on every unlinked row. A
 * genuine legacy `bank` string is still tolerated (cast through) so imported /
 * historical rows keep their tag; only a real 'Transfer' value renders as one.
 */
function asBank(value: string | null | undefined): Bank {
  return (value ?? '') as Bank
}

/** Narrow the backend month name to the prototype's {@link MonthName} union. */
function asMonth(value: string): MonthName {
  return value as MonthName
}

/** The known recurrence cadences, for narrowing an arbitrary backend string. */
const RECURRING_CADENCES: readonly RecurringCadence[] = [
  'monthly',
  'quarterly',
  'annual',
  'installment',
] as const

/**
 * Narrow the backend `recurring_cadence` string to the {@link RecurringCadence}
 * union (ADR-174). A null/absent/unknown value → undefined (a one-off row), so an
 * unrecognized cadence never fabricates an installment tag.
 */
function asRecurringCadence(
  value: string | null | undefined,
): RecurringCadence | undefined {
  return value != null && (RECURRING_CADENCES as readonly string[]).includes(value)
    ? (value as RecurringCadence)
    : undefined
}

/**
 * Parse a nullable installment count to a positive integer, or undefined. Guards
 * the forecast/installment UI against a null, non-finite, or non-positive value
 * (ADR-174): only a real positive integer counts as a captured installment field.
 */
function asInstallmentCount(value: number | null | undefined): number | undefined {
  if (value == null || !Number.isFinite(value) || value <= 0) return undefined
  return Math.trunc(value)
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
 * carries the optional free-text `notes` (ADR-088, mirrors `name`), and drops the
 * contract-only fields the UI does not consume (FX rate metadata, timestamps) —
 * the screens stay untouched.
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
    // Card-level display detail (ADR-117); only present on imported rows. Kept off
    // rows with no card so the shape stays clean (null/empty → absent).
    ...(dto.card ? { card: dto.card } : {}),
    // The attributed account (ADR-122/133); carried through when present (incl.
    // null for an explicitly-unlinked row), absent when the contract omits it.
    ...(dto.accountId !== undefined ? { accountId: dto.accountId } : {}),
    currency: dto.currency,
    type: dto.type,
    kind: dto.kind,
    // The offset link (ADR-159): carried through when present (incl. null for a
    // non-reimbursement row), so a reimbursement row can read as a payback linked
    // to its expense. Absent on legacy payloads → left off the shape.
    ...(dto.offsetsTransactionId !== undefined
      ? { offsetsTransactionId: dto.offsetsTransactionId }
      : {}),
    amountNum: parseMoney(dto.amountNum) ?? 0,
    ...(usd !== undefined ? { usd } : {}),
    ...(rate !== undefined ? { rate } : {}),
    // FX source/as-of drive the row's source indicator (ADR-045); only USD rows
    // carry them, so keep them off ARS rows to keep the shape clean.
    ...(fxRateType !== undefined ? { fxRateType } : {}),
    ...(fxRateAsOf !== undefined ? { fxRateAsOf } : {}),
    // FX snapshot provenance + rate (ADR-148): present once a row carries a
    // snapshot; the budgets surface uses `fxSource`'s presence to count
    // unconverted rows (ADR-152), and the Add/Edit form re-seeds the stored
    // `fxRate` so an edit shows the rate that was captured.
    ...(dto.fxSource ? { fxSource: dto.fxSource } : {}),
    ...(dto.fxRate ? { fxRate: dto.fxRate } : {}),
    ...(dto.recurring ? { recurring: dto.recurring } : {}),
    // Forecast recurrence metadata (ADR-174): carried through when the backend
    // sends a recognized cadence so the Add/Edit form can re-seed it on edit and
    // the ledger can distinguish committed streams. An unknown/absent cadence is
    // left off the shape (a one-off row). The installment counts ride along only
    // when a real positive integer is present.
    ...(asRecurringCadence(dto.recurringCadence) !== undefined
      ? { recurringCadence: asRecurringCadence(dto.recurringCadence) }
      : {}),
    ...(asInstallmentCount(dto.installmentsTotal) !== undefined
      ? { installmentsTotal: asInstallmentCount(dto.installmentsTotal) }
      : {}),
    ...(asInstallmentCount(dto.installmentsIndex) !== undefined
      ? { installmentsIndex: asInstallmentCount(dto.installmentsIndex) }
      : {}),
    ...(dto.notes ? { notes: dto.notes } : {}),
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
    countsTowardMonotributo: input.countsTowardMonotributo ?? false,
  }
  // The legacy bank tag is no longer set by the Add/Edit form (ADR-136
  // extension): attribution comes from `accountId`. Sent only when an input
  // still carries it (e.g. a statement-import create path), omitted otherwise.
  if (input.bank !== undefined) body.bank = input.bank
  if (input.card !== undefined) body.card = input.card
  // The attributed account (ADR-122/133); sent when the input carries it (incl.
  // null for an explicitly-unlinked row). The lenient backend defaults a missing
  // value, so we only send it when present.
  if (input.accountId !== undefined) body.accountId = input.accountId
  // The offset link (ADR-159): sent ONLY when the input carries a target — a
  // reimbursement create. The backend links the payback to its expense and nets
  // the category-month spend (ADR-160); it drops the FX fields itself (ADR-161),
  // and the form never supplies them for a reimbursement anyway.
  if (input.offsetsTransactionId != null) {
    body.offsetsTransactionId = input.offsetsTransactionId
  }
  if (input.usd !== undefined) body.usd = input.usd
  if (input.rate !== undefined) body.rate = input.rate
  // The per-transaction FX snapshot (ADR-148/149): the client supplies the rate
  // + provenance so the backend materializes `usd_amount`. Sent when captured
  // (the add mutation stamps the day's preferred-source rate, ADR-151).
  //
  // INVARIANT (ADR-148): `fxRate` and `fxSource` travel TOGETHER. The backend
  // only materializes `usd_amount` when BOTH a `fx_source` AND a positive
  // `fx_rate` are present; a source without a rate tags the row but leaves it
  // permanently unconverted. So we only include the pair when a valid positive
  // rate accompanies it; absent/non-positive rate → send NEITHER (the row is
  // created without a snapshot and backfilled later, ADR-150/152).
  if (hasPositiveFxRate(input.fxRate)) {
    body.fxRate = input.fxRate
    if (input.fxSource !== undefined) body.fxSource = input.fxSource
  }
  if (input.fxRateType !== undefined) body.fxRateType = input.fxRateType
  if (input.fxRateAsOf !== undefined) body.fxRateAsOf = input.fxRateAsOf
  if (input.recurring !== undefined) body.recurring = input.recurring
  // Forecast recurrence metadata (ADR-174). The cadence is sent when the form
  // set one; the installment counts are sent ONLY for an installment cadence (the
  // form clears them for the other cadences, so they never travel with a
  // monthly/quarterly/annual stream). A null cadence explicitly clears any prior
  // recurrence on the backend.
  if (input.recurringCadence !== undefined) {
    body.recurringCadence = input.recurringCadence
  }
  if (input.recurringCadence === 'installment') {
    if (input.installmentsTotal != null) {
      body.installmentsTotal = input.installmentsTotal
    }
    if (input.installmentsIndex != null) {
      body.installmentsIndex = input.installmentsIndex
    }
  } else if (input.recurringCadence !== undefined) {
    // A non-installment cadence (or an explicit null) must not carry installment
    // counts — send null so the backend clears any stale plan on this row.
    body.installmentsTotal = null
    body.installmentsIndex = null
  }
  if (input.notes) body.notes = input.notes
  // Imported invoice: carry the base64 PDF + parsed record so the backend stores
  // and links the attachment (ADR-070/071). Omitted for manual entries.
  if (input.document) body.document = input.document
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
  // Card detail is import-set (ADR-117); send it back unchanged on edit so an
  // imported row's card survives a re-save (omitted when the patch carries none).
  if (patch.card !== undefined) body.card = patch.card
  // The attributed account (ADR-122/133); a present value (incl. null) updates
  // the link, an omitted one leaves it unchanged (ADR-028).
  if (patch.accountId !== undefined) body.accountId = patch.accountId
  if (patch.usd !== undefined) body.usd = patch.usd
  if (patch.rate !== undefined) body.rate = patch.rate
  // Same FX pairing invariant as the create body (ADR-148): only send the
  // snapshot when a positive `fxRate` accompanies its `fxSource`, so a patch can
  // never tag a row with a source-without-rate (which would leave `usd_amount`
  // null). A patch carrying neither leaves the stored snapshot unchanged.
  if (hasPositiveFxRate(patch.fxRate)) {
    body.fxRate = patch.fxRate
    if (patch.fxSource !== undefined) body.fxSource = patch.fxSource
  }
  if (patch.fxRateType !== undefined) body.fxRateType = patch.fxRateType
  if (patch.fxRateAsOf !== undefined) body.fxRateAsOf = patch.fxRateAsOf
  if (patch.recurring !== undefined) body.recurring = patch.recurring
  // Forecast recurrence metadata (ADR-174): a present cadence updates the stream;
  // installment counts ride along only for an installment cadence, else are
  // cleared to null so switching a plan back to a plain cadence (or one-off)
  // drops its stale cuota shape (ADR-028 leaves an omitted field unchanged, so we
  // send null explicitly to clear).
  if (patch.recurringCadence !== undefined) {
    body.recurringCadence = patch.recurringCadence
    if (patch.recurringCadence === 'installment') {
      if (patch.installmentsTotal != null) {
        body.installmentsTotal = patch.installmentsTotal
      }
      if (patch.installmentsIndex != null) {
        body.installmentsIndex = patch.installmentsIndex
      }
    } else {
      body.installmentsTotal = null
      body.installmentsIndex = null
    }
  }
  if (patch.notes !== undefined) body.notes = patch.notes
  if (patch.countsTowardMonotributo !== undefined) {
    body.countsTowardMonotributo = patch.countsTowardMonotributo
  }
  return body
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const

/** GET all transactions (newest-first), adapted to the frontend shape. */
async function list(): Promise<Transaction[]> {
  const response = await authedFetch(apiUrl('/transactions'), {
    headers: { Accept: 'application/json' },
  })
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<TransactionDto[]>
  return envelope.data.map(adaptTransaction)
}

/** POST a new transaction; returns the persisted, adapted row. */
async function create(input: NewTransactionInput): Promise<Transaction> {
  const response = await authedFetch(apiUrl('/transactions'), {
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
  const response = await authedFetch(apiUrl(`/transactions/${id}`), {
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
  const response = await authedFetch(apiUrl(`/transactions/${id}`), {
    method: 'DELETE',
  })
  await ensureOk(response)
}

/** Body for `PUT /transactions/{id}/fx` — the client-captured FX snapshot (ADR-148/149). */
export interface FxSnapshotBody {
  /** ARS per 1 USD as a Decimal string; must be positive (the backend 422s otherwise). */
  fxRate: string
  /** Provenance of the rate (ADR-148): 'bolsa'/'oficial'/'manual'/'backfill'. */
  fxSource?: string
}

/**
 * PUT the FX snapshot on an existing transaction (ADR-148/149). The client
 * supplies the captured ARS-per-1-USD `fxRate` + its `fxSource`; the backend
 * re-materializes `usd_amount` and returns the full refreshed row. Powers the
 * statement-import rate-fill (ADR-149) and the one-time historical backfill
 * (ADR-150). A cross-tenant/absent id is a 404; a non-positive rate a 422.
 */
async function setFxSnapshot(
  id: string,
  body: FxSnapshotBody,
): Promise<Transaction> {
  const response = await authedFetch(apiUrl(`/transactions/${id}/fx`), {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      fxRate: body.fxRate,
      ...(body.fxSource != null ? { fxSource: body.fxSource } : {}),
    }),
  })
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<TransactionDto>
  return adaptTransaction(envelope.data)
}

/** The transactions API client, grouped for ergonomic import. */
export const transactionsClient = {
  list,
  create,
  update,
  remove,
  setFxSnapshot,
} as const
