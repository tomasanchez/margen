/**
 * Accounts + net-worth API client + DTO boundary (ADR-122/123/130/133).
 *
 * The single boundary between the backend's `/accounts` REST contract
 * (`GET|POST|PUT /api/v1/accounts`, `GET /api/v1/accounts/net-worth`, a `{ data }`
 * envelope, camelCase fields, UUID string ids, Decimal-string money) and the
 * frontend's {@link Account} shape. Mirrors {@link settingsClient} /
 * {@link transactionsClient} (ADR-033): `apiUrl()` for the versioned URL,
 * `authedFetch` for the bearer token (ADR-092), and a status-carrying error on
 * any non-2xx so TanStack Query treats it as a failure and the Accounts page can
 * show a calm error state (ADR-037).
 *
 * Money stays a Decimal STRING end-to-end (ADR-025/034): `openingBalance` and the
 * net-worth balances cross the boundary as strings and are parsed to numbers only
 * at the display edge (the net-worth card / formatters). This client renames
 * nothing on the account itself (the contract is already camelCase + flat); it
 * unwraps the envelope and forwards the typed shapes.
 *
 * Net worth (ADR-123/133): the reader returns the user's total in their display
 * currency plus a per-account breakdown carrying each account's native `balance`
 * AND a `balanceConverted` in the display currency. When the user has no USD row
 * to derive a MEP rate from, the backend degrades to native and
 * `balanceConverted === balance` (ADR-133); the UI just renders whatever the API
 * returns and never computes FX client-side for net worth.
 */

import { apiUrl } from '../config'
import { authedFetch } from './http'
import type { Account, AccountType, Currency } from '../mock/types'

/** The backend `{ data: T }` response envelope (ADR-030). */
interface ResponseEnvelope<T> {
  data: T
}

/**
 * The account DTO as serialized by the backend (ADR-122). Already camelCase +
 * flat and matching {@link Account} (money as a Decimal string), so the adapter
 * narrows the enum-ish fields and forwards the rest unchanged.
 */
export interface AccountDto {
  id: string
  name: string
  type: string
  currency: string
  openingBalance: string
}

/** Request body accepted by `POST` / `PUT /accounts` (camelCase, ADR-122). */
export interface AccountWriteBody {
  name: string
  type: AccountType
  currency: Currency
  /** Opening balance as a Decimal string (ADR-025/034), e.g. "150000.00". */
  openingBalance: string
}

/** Input the Accounts form produces for a create. Mirrors {@link AccountWriteBody}. */
export type NewAccountInput = AccountWriteBody

/** Input for an update — the writable account fields (id is the path param). */
export type AccountUpdateInput = AccountWriteBody

/**
 * One account row in the net-worth breakdown (ADR-123/133). `balance` is the
 * account's NATIVE balance (in its own `currency`); `balanceConverted` is that
 * balance expressed in the user's display currency. They are EQUAL when the
 * backend degraded to native (no MEP rate available, ADR-133) — the card renders
 * whatever the API returns and never converts client-side.
 */
export interface NetWorthAccount {
  id: string
  name: string
  /** The account's native currency (ARS / USD). */
  currency: string
  /** Native balance as a Decimal string. */
  balance: string
  /** Balance in the display currency as a Decimal string (=== balance when degraded). */
  balanceConverted: string
}

/**
 * The net-worth read model (ADR-122/123/133): the user's total in their display
 * `currency` plus the per-account breakdown. Money fields are Decimal strings.
 */
export interface NetWorth {
  /** Total net worth as a Decimal string, in the display `currency`. */
  total: string
  /** Display currency the `total` (and each `balanceConverted`) is expressed in. */
  currency: string
  /** Per-account breakdown, native + converted balances. */
  accounts: NetWorthAccount[]
}

/** An API error that carries the HTTP status so callers can branch on it. */
export class AccountApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'AccountApiError'
    this.status = status
  }
}

/** Throw an {@link AccountApiError} for any non-2xx response. */
async function ensureOk(response: Response): Promise<void> {
  if (response.ok) return
  let detail = ''
  try {
    detail = await response.text()
  } catch {
    // Ignore body-read failures; the status is enough for the calm error state.
  }
  throw new AccountApiError(
    response.status,
    `Accounts API request failed with ${response.status}${
      detail ? `: ${detail}` : ''
    }`,
  )
}

/** Narrow the backend account `type` string to {@link AccountType} (default bank). */
function asAccountType(value: string): AccountType {
  return value === 'cash' || value === 'card' ? value : 'bank'
}

/** Narrow the backend `currency` string to {@link Currency} (default ARS). */
function asCurrency(value: string): Currency {
  return value === 'USD' ? 'USD' : 'ARS'
}

/**
 * Adapt a backend {@link AccountDto} to the frontend {@link Account}.
 *
 * Narrows the enum-ish `type` / `currency` to their unions and keeps the money
 * field as the Decimal STRING it arrived as (ADR-025/034) — the form edits it as
 * a string and only the net-worth card parses balances to numbers for display.
 */
export function adaptAccount(dto: AccountDto): Account {
  return {
    id: dto.id,
    name: dto.name,
    type: asAccountType(dto.type),
    currency: asCurrency(dto.currency),
    openingBalance: dto.openingBalance,
  }
}

/** Build the create/update body from a form input (currency + type already narrowed). */
export function toWriteBody(input: AccountWriteBody): AccountWriteBody {
  return {
    name: input.name,
    type: input.type,
    currency: input.currency,
    openingBalance: input.openingBalance,
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const

/** GET all accounts (owner-scoped), adapted to the frontend shape. */
async function list(): Promise<Account[]> {
  const response = await authedFetch(apiUrl('/accounts'), {
    headers: { Accept: 'application/json' },
  })
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<AccountDto[]>
  return envelope.data.map(adaptAccount)
}

/** POST a new account; returns the persisted, adapted account. */
async function create(input: NewAccountInput): Promise<Account> {
  const response = await authedFetch(apiUrl('/accounts'), {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(toWriteBody(input)),
  })
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<AccountDto>
  return adaptAccount(envelope.data)
}

/** PUT an account update by UUID; returns the refreshed, adapted account. */
async function update(
  id: string,
  input: AccountUpdateInput,
): Promise<Account> {
  const response = await authedFetch(apiUrl(`/accounts/${id}`), {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(toWriteBody(input)),
  })
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<AccountDto>
  return adaptAccount(envelope.data)
}

/**
 * GET the net-worth read model (ADR-123/133). Unwraps the `{ data }` envelope;
 * the balances stay Decimal strings (the card parses them at the display edge).
 */
async function netWorth(): Promise<NetWorth> {
  const response = await authedFetch(apiUrl('/accounts/net-worth'), {
    headers: { Accept: 'application/json' },
  })
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<NetWorth>
  return envelope.data
}

/** The accounts API client, grouped for ergonomic import. */
export const accountsClient = {
  list,
  create,
  update,
  netWorth,
} as const
