/**
 * Institutions + Accounts + net-worth API client + DTO boundary
 * (ADR-122/123/130/133, restructured by ADR-134).
 *
 * The single boundary between the backend's REST contract and the frontend's
 * {@link Institution} / {@link Account} shapes. ADR-134 splits the old flat
 * account into a two-level model:
 *
 * - `Institution` = `{ id, name, type: bank|card|cash|wallet }` — CRUD at
 *   `/institutions` (list/create/update).
 * - `Account` = a per-currency leaf `{ id, institutionId, institutionName, type,
 *   currency, openingBalance }` — `/accounts` create `{ institutionId, currency,
 *   openingBalance }`, list, update. `institutionName` + `type` are denormalized
 *   into the account response for display.
 *
 * Mirrors {@link settingsClient} / {@link transactionsClient} (ADR-033):
 * `apiUrl()` for the versioned URL, `authedFetch` for the bearer token (ADR-092),
 * a `{ data }` envelope (ADR-030), and a status-carrying error on any non-2xx so
 * TanStack Query treats it as a failure and the page can show a calm error state
 * (ADR-037). Money stays a Decimal STRING end-to-end (ADR-025/034) and is parsed
 * to a number only at the display edge.
 *
 * Net worth (ADR-123/133): the reader returns the user's total in their display
 * currency plus a per-account breakdown carrying each account's native `balance`
 * AND a `balanceConverted` in the display currency. When there is no USD row to
 * derive a MEP rate from, the backend degrades to native and
 * `balanceConverted === balance` (ADR-133); the UI renders what the API returns
 * and never computes FX client-side for net worth. The breakdown carries the
 * institution name + type + currency (ADR-134), not a single account name.
 */

import { apiUrl } from '../config'
import { authedFetch } from './http'
import type {
  Account,
  AccountType,
  Currency,
  Institution,
  InstitutionWriteBody,
} from '../mock/types'

/** The backend `{ data: T }` response envelope (ADR-030). */
interface ResponseEnvelope<T> {
  data: T
}

/** The institution DTO as serialized by the backend (ADR-134). */
export interface InstitutionDto {
  id: string
  name: string
  type: string
}

/** Request body accepted by `POST` / `PUT /institutions` (camelCase, ADR-134). */
export interface InstitutionWriteDto {
  name: string
  type: AccountType
}

/** Input the Add-institution flow produces. Mirrors {@link InstitutionWriteBody}. */
export type NewInstitutionInput = InstitutionWriteBody
/** Input for an institution update — the writable fields (id is the path param). */
export type InstitutionUpdateInput = InstitutionWriteBody

/**
 * The account DTO as serialized by the backend (ADR-134). Denormalizes the
 * owning institution's `institutionName` + `type` for display; money is a
 * Decimal string.
 */
export interface AccountDto {
  id: string
  institutionId: string
  institutionName: string
  type: string
  currency: string
  openingBalance: string
}

/**
 * Request body accepted by `POST /accounts` (ADR-134): the institution to attach
 * to, the native currency, and the opening balance as a Decimal string. The
 * account's name + type come from the institution, so they are NOT sent here.
 */
export interface AccountWriteBody {
  institutionId: string
  currency: Currency
  /** Opening balance as a Decimal string (ADR-025/034), e.g. "150000.00". */
  openingBalance: string
}

/** Input the Accounts form produces for a create. Mirrors {@link AccountWriteBody}. */
export type NewAccountInput = AccountWriteBody
/** Input for an account update — the writable fields (id is the path param). */
export type AccountUpdateInput = AccountWriteBody

/**
 * One account row in the net-worth breakdown (ADR-123/133/134). Carries the
 * institution name + type + native `currency`; `balance` is the account's NATIVE
 * balance and `balanceConverted` is that balance expressed in the user's display
 * currency. They are EQUAL when the backend degraded to native (no MEP rate
 * available, ADR-133) — the card renders what the API returns and never converts
 * client-side.
 */
export interface NetWorthAccount {
  id: string
  /** The owning institution's id (for the account drilldown link, ADR-134). */
  institutionId: string
  /** The owning institution's name, for the breakdown row label. */
  institutionName: string
  /** The owning institution's type (bank/card/cash/wallet). */
  type: string
  /** The account's native currency (ARS / USD). */
  currency: string
  /** Native balance as a Decimal string. */
  balance: string
  /** Balance in the display currency as a Decimal string (=== balance when degraded). */
  balanceConverted: string
}

/**
 * The typed liabilities reservation carried alongside net worth (ADR-180/181/183).
 * A layered, ADDITIVE breakdown of locked-in obligations expressed in the same
 * display currency as the net-worth `total`, converted at the SAME MEP rate the
 * total uses (ADR-183) — so `netAfterLiabilities = total − liabilities.total` is
 * a meaningful subtraction. `installments` is the only populated field in Slice 1
 * (ADR-181); `ccBalance` and `other` are typed placeholders (null now, ADR-180).
 * Money fields are Decimal strings.
 */
export interface Liabilities {
  /** Full remaining installment tail (Σ remaining × cuota) in the display currency. */
  installments: string
  /** Unpaid credit-card balance liability; null in Slice 1 (typed placeholder, ADR-180). */
  ccBalance: string | null
  /** Catch-all for other debts; null in Slice 1 (typed placeholder, ADR-180). */
  other: string | null
  /** Sum of the present liability figures, in the display currency. */
  total: string
}

/**
 * The net-worth read model (ADR-122/123/133/134, ADR-180): the user's total in
 * their display `currency` plus the per-account breakdown, now LAYERED with a
 * typed liabilities reservation and the derived `netAfterLiabilities` (ADR-180).
 * The `total` (assets) stays UNCHANGED — `netAfterLiabilities` is an additive
 * secondary view, never a redefinition. Money fields are Decimal strings.
 */
export interface NetWorth {
  /** Total net worth (assets) as a Decimal string, in the display `currency`. */
  total: string
  /** Display currency the `total` (and each `balanceConverted`) is expressed in. */
  currency: string
  /** Per-account breakdown, native + converted balances. */
  accounts: NetWorthAccount[]
  /** Typed liabilities reservation in the display currency (ADR-180); installments only in Slice 1. */
  liabilities: Liabilities
  /** `total − liabilities.total`, in the display currency — a derived view (ADR-180). */
  netAfterLiabilities: string
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

/** Narrow the backend institution/account `type` string to {@link AccountType}. */
function asAccountType(value: string): AccountType {
  return value === 'cash' || value === 'card' || value === 'wallet'
    ? value
    : 'bank'
}

/** Narrow the backend `currency` string to {@link Currency} (default ARS). */
function asCurrency(value: string): Currency {
  return value === 'USD' ? 'USD' : 'ARS'
}

/** Adapt a backend {@link InstitutionDto} to the frontend {@link Institution}. */
export function adaptInstitution(dto: InstitutionDto): Institution {
  return { id: dto.id, name: dto.name, type: asAccountType(dto.type) }
}

/**
 * Adapt a backend {@link AccountDto} to the frontend {@link Account}.
 *
 * Narrows the enum-ish `type` / `currency` to their unions and keeps the money
 * field as the Decimal STRING it arrived as (ADR-025/034) — the form edits it as
 * a string and only the display edge parses balances to numbers.
 */
export function adaptAccount(dto: AccountDto): Account {
  return {
    id: dto.id,
    institutionId: dto.institutionId,
    institutionName: dto.institutionName,
    type: asAccountType(dto.type),
    currency: asCurrency(dto.currency),
    openingBalance: dto.openingBalance,
  }
}

/** Zero as a Decimal string — the safe default for an absent liability figure. */
const ZERO_DECIMAL = '0'

/**
 * Adapt the backend net-worth payload, defaulting a missing `liabilities` /
 * `netAfterLiabilities` (ADR-180) so a pre-liabilities or malformed response
 * still renders: liabilities collapse to zero (which suppresses the "Net of
 * commitments" line — nothing is committed) and `netAfterLiabilities` falls back
 * to the assets `total`. Money stays a Decimal STRING end-to-end (ADR-025/034);
 * the card parses at the display edge (ADR-102). No FX happens here — liability
 * amounts already arrive in the display currency at the MEP rate (ADR-183).
 */
export function adaptNetWorth(dto: NetWorth): NetWorth {
  const liabilities: Liabilities = dto.liabilities
    ? {
        installments: dto.liabilities.installments ?? ZERO_DECIMAL,
        ccBalance: dto.liabilities.ccBalance ?? null,
        other: dto.liabilities.other ?? null,
        total: dto.liabilities.total ?? ZERO_DECIMAL,
      }
    : {
        installments: ZERO_DECIMAL,
        ccBalance: null,
        other: null,
        total: ZERO_DECIMAL,
      }
  return {
    total: dto.total,
    currency: dto.currency,
    accounts: dto.accounts ?? [],
    liabilities,
    netAfterLiabilities: dto.netAfterLiabilities ?? dto.total,
  }
}

/** Build the institution create/update body from a form input. */
export function toInstitutionWriteBody(
  input: InstitutionWriteBody,
): InstitutionWriteDto {
  return { name: input.name, type: input.type }
}

/** Build the account create/update body from a form input. */
export function toAccountWriteBody(input: AccountWriteBody): AccountWriteBody {
  return {
    institutionId: input.institutionId,
    currency: input.currency,
    openingBalance: input.openingBalance,
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const

/** GET all institutions (owner-scoped), adapted to the frontend shape. */
async function listInstitutions(): Promise<Institution[]> {
  const response = await authedFetch(apiUrl('/institutions'), {
    headers: { Accept: 'application/json' },
  })
  await ensureOk(response)
  const envelope =
    (await response.json()) as ResponseEnvelope<InstitutionDto[]>
  return envelope.data.map(adaptInstitution)
}

/** POST a new institution; returns the persisted, adapted institution. */
async function createInstitution(
  input: NewInstitutionInput,
): Promise<Institution> {
  const response = await authedFetch(apiUrl('/institutions'), {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(toInstitutionWriteBody(input)),
  })
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<InstitutionDto>
  return adaptInstitution(envelope.data)
}

/** PUT an institution update by UUID; returns the refreshed institution. */
async function updateInstitution(
  id: string,
  input: InstitutionUpdateInput,
): Promise<Institution> {
  const response = await authedFetch(apiUrl(`/institutions/${id}`), {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(toInstitutionWriteBody(input)),
  })
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<InstitutionDto>
  return adaptInstitution(envelope.data)
}

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
    body: JSON.stringify(toAccountWriteBody(input)),
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
    body: JSON.stringify(toAccountWriteBody(input)),
  })
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<AccountDto>
  return adaptAccount(envelope.data)
}

/**
 * GET the net-worth read model (ADR-123/133/180). Unwraps the `{ data }` envelope
 * and adapts it (defaulting the layered `liabilities` + `netAfterLiabilities`,
 * ADR-180); the balances stay Decimal strings (the card parses at the display
 * edge). Liability amounts already arrive in the display currency (ADR-183).
 */
async function netWorth(): Promise<NetWorth> {
  const response = await authedFetch(apiUrl('/accounts/net-worth'), {
    headers: { Accept: 'application/json' },
  })
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<NetWorth>
  return adaptNetWorth(envelope.data)
}

/** The accounts + institutions API client, grouped for ergonomic import. */
export const accountsClient = {
  listInstitutions,
  createInstitution,
  updateInstitution,
  list,
  create,
  update,
  netWorth,
} as const
