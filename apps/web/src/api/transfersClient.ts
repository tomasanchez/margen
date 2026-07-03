/**
 * Account-to-account Transfers API client + DTO boundary (ADR-135).
 *
 * A transfer moves money between two of the user's own accounts; it is NOT a
 * transaction (not income/expense, untouched by the Monotributo reader). Fees,
 * however, ARE real costs: each fee on a transfer-create becomes a separate
 * `kind=expense`, category `"Fees"` transaction on the given account, created
 * atomically with the transfer server-side (the response carries the created
 * `feeTransactionIds`). Deleting a transfer does NOT delete those fee expenses —
 * they are independent rows (reflected in the delete-confirmation copy).
 *
 * Mirrors {@link accountsClient} / {@link transactionsClient} (ADR-033): `apiUrl()`
 * for the versioned URL, `authedFetch` for the bearer token (ADR-092), a `{ data }`
 * envelope (ADR-030), and a status-carrying error on any non-2xx so TanStack Query
 * treats it as a failure and the view can render a calm error state (ADR-037/130).
 * Money stays a Decimal STRING end-to-end (ADR-025/034); it is parsed to a number
 * only at the display edge.
 */

import { apiUrl } from '../config'
import { authedFetch } from './http'
import type { NewTransferInput, Transfer } from '../mock/types'

/** The backend `{ data: T }` response envelope (ADR-030). */
interface ResponseEnvelope<T> {
  data: T
}

/** The transfer DTO as serialized by the backend (ADR-135), camelCase + Decimal strings. */
export interface TransferDto {
  id: string
  fromAccountId: string
  toAccountId: string
  amountOut: string
  amountIn: string
  occurredOn: string
  note?: string | null
}

/** One fee line in the `POST /transfers` body (ADR-135). */
export interface TransferFeeBody {
  accountId: string
  amount: string
  label: string
  /**
   * Per-fee FX snapshot rate (ARS per 1 USD) as a Decimal string (ADR-148/149),
   * captured client-side like a normal expense. Sent for an ARS fee so the
   * backend materializes the fee expense's `usd_amount = amount ÷ rate`; omitted
   * when no rate was captured. Travels together with {@link TransferFeeBody.fxSource}.
   */
  rate?: string
  /** Provenance of {@link TransferFeeBody.rate} (ADR-148): 'bolsa'/'oficial'/'manual'. */
  fxSource?: string
}

/**
 * Request body accepted by `POST /transfers` (ADR-135): the two accounts, the
 * out/in amounts as Decimal strings, the date, an optional note, and zero or more
 * fee lines. Fees create category `"Fees"` expense transactions atomically.
 */
export interface TransferWriteBody {
  fromAccountId: string
  toAccountId: string
  amountOut: string
  amountIn: string
  occurredOn: string
  note?: string
  fees?: TransferFeeBody[]
}

/**
 * The `POST /transfers` response (ADR-135): the persisted transfer plus the ids
 * of the fee expense transactions created alongside it (empty when no fees).
 */
export interface TransferDtoWithFees extends TransferDto {
  feeTransactionIds: string[]
}

/** The persisted transfer plus its created fee transaction ids, adapted. */
export interface CreatedTransfer {
  transfer: Transfer
  feeTransactionIds: string[]
}

/** An API error that carries the HTTP status so callers can branch on it. */
export class TransferApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'TransferApiError'
    this.status = status
  }
}

/** Throw a {@link TransferApiError} for any non-2xx response. */
async function ensureOk(response: Response): Promise<void> {
  if (response.ok) return
  let detail = ''
  try {
    detail = await response.text()
  } catch {
    // Ignore body-read failures; the status is enough for the calm error state.
  }
  throw new TransferApiError(
    response.status,
    `Transfers API request failed with ${response.status}${
      detail ? `: ${detail}` : ''
    }`,
  )
}

/** Adapt a backend {@link TransferDto} to the frontend {@link Transfer}. */
export function adaptTransfer(dto: TransferDto): Transfer {
  return {
    id: dto.id,
    fromAccountId: dto.fromAccountId,
    toAccountId: dto.toAccountId,
    amountOut: dto.amountOut,
    amountIn: dto.amountIn,
    occurredOn: dto.occurredOn,
    ...(dto.note ? { note: dto.note } : {}),
  }
}

/** Build the `POST /transfers` body from a form input (drops empty optionals). */
export function toTransferWriteBody(input: NewTransferInput): TransferWriteBody {
  const body: TransferWriteBody = {
    fromAccountId: input.fromAccountId,
    toAccountId: input.toAccountId,
    amountOut: input.amountOut,
    amountIn: input.amountIn,
    occurredOn: input.occurredOn,
  }
  const note = input.note?.trim()
  if (note) body.note = note
  if (input.fees && input.fees.length > 0) {
    body.fees = input.fees.map((fee) => {
      const feeBody: TransferFeeBody = {
        accountId: fee.accountId,
        amount: fee.amount,
        label: fee.label,
      }
      // INVARIANT (ADR-148): `rate` and `fxSource` travel TOGETHER so the fee
      // expense can never be a source-without-rate. Sent only when a snapshot was
      // captured (an ARS fee with an available rate); a USD fee / unavailable
      // rate omits both and the fee is created without a snapshot (backfilled
      // later, ADR-150) — never a guessed rate.
      if (fee.rate) {
        feeBody.rate = fee.rate
        if (fee.fxSource) feeBody.fxSource = fee.fxSource
      }
      return feeBody
    })
  }
  return body
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const

/** GET all transfers (owner-scoped, newest-first), adapted to the frontend shape. */
async function list(): Promise<Transfer[]> {
  const response = await authedFetch(apiUrl('/transfers'), {
    headers: { Accept: 'application/json' },
  })
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<TransferDto[]>
  return envelope.data.map(adaptTransfer)
}

/**
 * POST a new transfer (+ optional fee lines). Returns the persisted transfer and
 * the ids of the fee expense transactions created atomically alongside it.
 */
async function create(input: NewTransferInput): Promise<CreatedTransfer> {
  const response = await authedFetch(apiUrl('/transfers'), {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(toTransferWriteBody(input)),
  })
  await ensureOk(response)
  const envelope =
    (await response.json()) as ResponseEnvelope<TransferDtoWithFees>
  return {
    transfer: adaptTransfer(envelope.data),
    feeTransactionIds: envelope.data.feeTransactionIds ?? [],
  }
}

/**
 * DELETE a transfer by UUID (204, no body). Does NOT delete the transfer's fee
 * expense transactions — they are independent rows (ADR-135).
 */
async function remove(id: string): Promise<void> {
  const response = await authedFetch(apiUrl(`/transfers/${id}`), {
    method: 'DELETE',
  })
  await ensureOk(response)
}

/** The transfers API client, grouped for ergonomic import. */
export const transfersClient = {
  list,
  create,
  remove,
} as const
