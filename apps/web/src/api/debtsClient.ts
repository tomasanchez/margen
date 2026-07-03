/**
 * Debts API client + DTO boundary (ADR-187, ADR-183).
 *
 * A `Debt` is a manual, balance-bearing liability the user maintains by hand — a
 * loan or personal debt that is neither an installment tail (ADR-181) nor an
 * unpaid card balance (ADR-185). Its `currentBalance` feeds the net-worth
 * `liabilities.other` leg (ADR-187): the backend sums every debt by native
 * currency into `otherNative {ars, usd}`, which the net-worth card converts at
 * the SAME live MEP rate as the assets headline (ADR-183 amendment).
 *
 * Mirrors {@link accountsClient} / {@link transfersClient} (ADR-033): `apiUrl()`
 * for the versioned URL, `authedFetch` for the bearer token (ADR-092), a
 * `{ data }` envelope (ADR-030), and a status-carrying error on any non-2xx so
 * TanStack Query treats it as a failure and the view can render a calm error
 * state (ADR-037/130). Money stays a Decimal STRING end-to-end (ADR-025/034),
 * parsed to a number only at the display edge.
 *
 * PATCH semantics (ADR-028): an OMITTED field leaves the stored value unchanged.
 * A consequence (accepted, ADR-187) is that once `monthlyMinimum` / `rate` are
 * set they can't be cleared back to null via patch — there is no clear-to-null
 * affordance in the form.
 */

import { apiUrl } from '../config'
import { authedFetch } from './http'
import type { Currency } from '../mock/types'

/** The backend `{ data: T }` response envelope (ADR-030). */
interface ResponseEnvelope<T> {
  data: T
}

/**
 * The debt DTO as serialized by the backend (ADR-187), camelCase + Decimal-string
 * money. `monthlyMinimum` / `rate` are optional extension points (null when unset).
 */
export interface DebtDto {
  id: string
  name: string
  currency: string
  currentBalance: string
  monthlyMinimum: string | null
  rate: string | null
}

/**
 * A debt in the frontend shape (ADR-187). Money stays a Decimal STRING (parsed at
 * the display edge, ADR-102); `currency` is narrowed to {@link Currency}.
 */
export interface Debt {
  id: string
  name: string
  currency: Currency
  /** Outstanding native-currency amount owed, as a Decimal string (ADR-025/034). */
  currentBalance: string
  /** Optional minimum monthly payment (native currency), or null when unset. */
  monthlyMinimum: string | null
  /** Optional interest rate, or null when unset. */
  rate: string | null
}

/**
 * Request body for `POST /debts` (ADR-187). Only `name` is required; `currency`
 * defaults to ARS and `currentBalance` to "0" server-side. `monthlyMinimum` /
 * `rate` are omitted when unset (never sent as null). Money is a Decimal string.
 */
export interface DebtCreateBody {
  name: string
  currency?: Currency
  currentBalance?: string
  monthlyMinimum?: string
  rate?: string
}

/**
 * Request body for `PATCH /debts/{id}` (ADR-187/028). Every field is optional; an
 * OMITTED field leaves the stored value unchanged. We never send `null` — an
 * absent field means "leave as-is".
 */
export interface DebtPatchBody {
  name?: string
  currency?: Currency
  currentBalance?: string
  monthlyMinimum?: string
  rate?: string
}

/**
 * Input the Debts form produces. `name` + `currency` + `currentBalance` are always
 * present; `monthlyMinimum` / `rate` are the raw strings the user typed (empty ⇒
 * omitted). Used for BOTH create and edit — the page routes it to the right verb.
 */
export interface DebtFormInput {
  name: string
  currency: Currency
  currentBalance: string
  /** Raw monthly-minimum text; empty/blank ⇒ omitted from the body. */
  monthlyMinimum: string
  /** Raw rate text; empty/blank ⇒ omitted from the body. */
  rate: string
}

/** An API error that carries the HTTP status so callers can branch on it. */
export class DebtApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'DebtApiError'
    this.status = status
  }
}

/** Throw a {@link DebtApiError} for any non-2xx response. */
async function ensureOk(response: Response): Promise<void> {
  if (response.ok) return
  let detail = ''
  try {
    detail = await response.text()
  } catch {
    // Ignore body-read failures; the status is enough for the calm error state.
  }
  throw new DebtApiError(
    response.status,
    `Debts API request failed with ${response.status}${
      detail ? `: ${detail}` : ''
    }`,
  )
}

/** Narrow the backend `currency` string to {@link Currency} (default ARS). */
function asCurrency(value: string): Currency {
  return value === 'USD' ? 'USD' : 'ARS'
}

/**
 * Adapt a backend {@link DebtDto} to the frontend {@link Debt}. Narrows the
 * enum-ish `currency` to its union and keeps money as the Decimal STRING it
 * arrived as (ADR-025/034); the display edge parses to a number.
 */
export function adaptDebt(dto: DebtDto): Debt {
  return {
    id: dto.id,
    name: dto.name,
    currency: asCurrency(dto.currency),
    currentBalance: dto.currentBalance,
    monthlyMinimum: dto.monthlyMinimum ?? null,
    rate: dto.rate ?? null,
  }
}

/** True when a raw optional text field carries a non-blank value to send. */
function present(value: string): boolean {
  return value.trim().length > 0
}

/**
 * Build the `POST /debts` body from a form input. `name` is trimmed; the optional
 * `monthlyMinimum` / `rate` are included only when non-blank (never null, ADR-187).
 * `currency` + `currentBalance` are always sent (the form always supplies them).
 */
export function toDebtCreateBody(input: DebtFormInput): DebtCreateBody {
  const body: DebtCreateBody = {
    name: input.name.trim(),
    currency: input.currency,
    currentBalance: input.currentBalance,
  }
  if (present(input.monthlyMinimum)) body.monthlyMinimum = input.monthlyMinimum.trim()
  if (present(input.rate)) body.rate = input.rate.trim()
  return body
}

/**
 * Build the `PATCH /debts/{id}` body from a form input (ADR-028): send every
 * always-present field (name/currency/currentBalance) plus the optionals only when
 * non-blank. An omitted optional leaves the stored value unchanged — a blank field
 * is treated as "leave as-is", NOT "clear to null" (accepted limitation, ADR-187).
 */
export function toDebtPatchBody(input: DebtFormInput): DebtPatchBody {
  const body: DebtPatchBody = {
    name: input.name.trim(),
    currency: input.currency,
    currentBalance: input.currentBalance,
  }
  if (present(input.monthlyMinimum)) body.monthlyMinimum = input.monthlyMinimum.trim()
  if (present(input.rate)) body.rate = input.rate.trim()
  return body
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const

/** GET all debts (owner-scoped, newest-first), adapted to the frontend shape. */
async function list(): Promise<Debt[]> {
  const response = await authedFetch(apiUrl('/debts'), {
    headers: { Accept: 'application/json' },
  })
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<DebtDto[]>
  return envelope.data.map(adaptDebt)
}

/** POST a new debt (201); returns the persisted, adapted debt. */
async function create(input: DebtFormInput): Promise<Debt> {
  const response = await authedFetch(apiUrl('/debts'), {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(toDebtCreateBody(input)),
  })
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<DebtDto>
  return adaptDebt(envelope.data)
}

/** PATCH a debt by UUID; returns the refreshed, adapted debt. */
async function update(id: string, input: DebtFormInput): Promise<Debt> {
  const response = await authedFetch(apiUrl(`/debts/${id}`), {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(toDebtPatchBody(input)),
  })
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<DebtDto>
  return adaptDebt(envelope.data)
}

/** DELETE a debt by UUID (204, no body). */
async function remove(id: string): Promise<void> {
  const response = await authedFetch(apiUrl(`/debts/${id}`), {
    method: 'DELETE',
  })
  await ensureOk(response)
}

/** The debts API client, grouped for ergonomic import. */
export const debtsClient = {
  list,
  create,
  update,
  remove,
} as const
