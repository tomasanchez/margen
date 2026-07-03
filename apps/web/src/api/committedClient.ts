/**
 * Committed-spend accent API client + DTO boundary (ADR-179).
 *
 * The single boundary between the backend's `GET /reports/committed` contract
 * and the committed-spend accent's read model. The accent enriches the EXISTING
 * monthly Expenses figures (Home Expense card + Budget page) with how much of the
 * month's spend is committed/obligated, split into two states (ADR-179):
 *
 *  - `paid` — committed rows (recurring subscriptions, installment cuotas, the
 *    monotributo cuota) already POSTED this month and therefore already INSIDE the
 *    month's Expenses total. This is the obligated share of what's already spent.
 *  - `pending` — expected-this-month committed outflows not yet posted, computed
 *    per stream at offset 0 (ADR-176). This is ADDITIVE context shown alongside
 *    the Expenses total — it is NEVER re-added to the spent number.
 *
 * Every figure is ALREADY denominated in the requested currency by the backend
 * (ADR-168): this client only unwraps the `{ data }` envelope (ADR-030) and
 * parses the Decimal STRINGS (ADR-025) to numbers at the display edge (ADR-102) —
 * it NEVER re-converts. The monotributo `tax` portion is AFIP-ARS and is summed
 * into the totals only on an ARS request; on a USD request the backend excludes it
 * (ADR-177). `unconverted` surfaces the committed streams a USD denomination
 * dropped for lacking an FX snapshot, so a USD figure is never silently
 * understated (ADR-152/168) — the surface shows a calm caveat when it > 0, unless
 * that caveat is already present from another source on the same surface.
 *
 * Mirrors {@link forecastClient} (ADR-033): `apiUrl()` for the versioned URL,
 * `authedFetch` for the bearer token (ADR-092), and a status-carrying error on any
 * non-2xx so TanStack Query treats it as a failure and the accent can degrade
 * quietly (ADR-037).
 */

import { apiUrl } from '../config'
import { authedFetch } from './http'
import type { Currency } from '../mock/types'

/** The backend `{ data: T }` response envelope (ADR-030). */
interface ResponseEnvelope<T> {
  data: T
}

/**
 * One committed figure broken out by source as serialized by the backend
 * (Decimal strings). `total` is `subscription + installment + tax` and is kept
 * explicit so the accent never recomputes it.
 */
export interface CommittedBySourceDto {
  subscription: string
  installment: string
  tax: string
  total: string
}

/** The `data` payload of `GET /reports/committed` (ADR-179). */
export interface CommittedDto {
  /** The target month as `YYYY-MM`, echoed back. */
  month: string
  /** The denomination currency (`ARS` / `USD`), echoed back. */
  currency: string
  /** Committed rows already posted this month — already inside the Expenses total. */
  paid: CommittedBySourceDto
  /** Expected-this-month committed outflows not yet posted (additive context). */
  pending: CommittedBySourceDto
  /** Count of committed streams excluded from a USD denomination for lacking a snapshot. */
  unconverted: number
}

/** One adapted committed figure (numbers) the accent consumes. */
export interface CommittedBySource {
  subscription: number
  installment: number
  tax: number
  /** subscription + installment + tax, in the requested currency (finite number). */
  total: number
}

/** The adapted committed split the accent consumes (ADR-179). Money already in `currency`. */
export interface CommittedSplit {
  /** The target month as `YYYY-MM`. */
  month: string
  /** The denomination currency (`ARS` / `USD`). */
  currency: Currency
  /** The obligated share ALREADY inside the month's Expenses total. */
  paid: CommittedBySource
  /** Expected-this-month committed outflows not yet posted (NOT in the spent total). */
  pending: CommittedBySource
  /** Count of committed streams a USD denomination dropped for lacking a snapshot; 0 on ARS. */
  unconverted: number
}

/** An API error that carries the HTTP status so callers can branch on it. */
export class CommittedApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'CommittedApiError'
    this.status = status
  }
}

/** Throw a {@link CommittedApiError} for any non-2xx response. */
async function ensureOk(response: Response): Promise<void> {
  if (response.ok) return
  let detail = ''
  try {
    detail = await response.text()
  } catch {
    // Ignore body-read failures; the status is enough for the calm degrade.
  }
  throw new CommittedApiError(
    response.status,
    `Committed API request failed with ${response.status}${
      detail ? `: ${detail}` : ''
    }`,
  )
}

/** Parse a Decimal string (e.g. "120000.00") to a number; non-finite → 0. */
function parseDecimal(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Narrow the backend currency string to the union; anything but USD → ARS. */
function asCurrency(value: string): Currency {
  return value === 'USD' ? 'USD' : 'ARS'
}

/** Adapt one per-source committed figure: parse each Decimal portion + total. */
export function adaptCommittedBySource(
  dto: CommittedBySourceDto,
): CommittedBySource {
  return {
    subscription: parseDecimal(dto.subscription),
    installment: parseDecimal(dto.installment),
    tax: parseDecimal(dto.tax),
    total: parseDecimal(dto.total),
  }
}

/**
 * Adapt the full backend committed payload to the accent-ready read model
 * (ADR-179). Money is parsed to numbers at this single boundary (ADR-102); the
 * figures are ALREADY in the requested currency (ADR-168), so nothing here
 * converts.
 */
export function adaptCommittedSplit(dto: CommittedDto): CommittedSplit {
  return {
    month: dto.month,
    currency: asCurrency(dto.currency),
    paid: adaptCommittedBySource(dto.paid),
    pending: adaptCommittedBySource(dto.pending),
    unconverted: dto.unconverted ?? 0,
  }
}

/**
 * GET the committed-spend paid/pending split for a month (ADR-179): the obligated
 * share already inside the month's Expenses total (`paid`) and the expected-but-
 * not-yet-posted committed outflows (`pending`) — every figure denominated in
 * `currency` (ADR-168). Unwraps the `{ data }` envelope (ADR-030) and adapts it to
 * numbers. An out-of-set `currency` or malformed `month` yields a 422, which
 * surfaces as a {@link CommittedApiError} so the accent can degrade quietly.
 */
export async function fetchCommitted(
  month: string,
  currency: Currency,
): Promise<CommittedSplit> {
  const params = new URLSearchParams({ month, currency })
  const response = await authedFetch(
    apiUrl(`/reports/committed?${params.toString()}`),
    { headers: { Accept: 'application/json' } },
  )
  await ensureOk(response)
  const { data } = (await response.json()) as ResponseEnvelope<CommittedDto>
  return adaptCommittedSplit(data)
}

/** The committed-spend accent API client, grouped for ergonomic import. */
export const committedClient = {
  fetchCommitted,
} as const
