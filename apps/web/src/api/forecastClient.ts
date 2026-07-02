/**
 * Cash-flow forecast API client + DTO boundary (ADR-173, ADR-176, ADR-177).
 *
 * The single boundary between the backend's `GET /reports/forecast` contract and
 * the Reports forecast panel's read model. The forecast is COMMITTED-only in v1
 * (ADR-173/176): flagged recurring subscriptions repeated on their cadence,
 * installment tails (remaining cuotas), and the configured monotributo monthly
 * cuota as a committed AFIP-ARS tax outflow (ADR-177). There is no discretionary
 * band and no projected income yet, so a month's `total` equals its `committed`
 * and `confidence` is always `'committed'`.
 *
 * Every figure is ALREADY denominated in the requested currency by the backend
 * (ADR-168): this client only unwraps the `{ data }` envelope (ADR-030) and
 * parses the Decimal STRINGS (ADR-025) to numbers at the display edge (ADR-102) —
 * it NEVER re-converts. The monotributo `tax` commitment is AFIP-ARS
 * (`arsFixed:true`, `currency:'ARS'`) and is reported at its ARS value on both
 * paths (ADR-177); it is summed into the month `committed`/`total` only on an ARS
 * request — on a USD request the backend EXCLUDES it from the totals and returns
 * it only as its own ARS commitment line, so the panel surfaces it separately and
 * never adds it back in. `unconverted` surfaces the committed rows
 * a USD denomination dropped for lacking an FX snapshot, so a USD total is never
 * silently understated (ADR-152/168) — the panel shows a calm caveat when it > 0.
 *
 * Mirrors {@link reportsClient} (ADR-033): `apiUrl()` for the versioned URL,
 * `authedFetch` for the bearer token (ADR-092), and a status-carrying error on any
 * non-2xx so TanStack Query treats it as a failure and the panel can show the calm
 * error state (ADR-037).
 */

import { apiUrl } from '../config'
import { authedFetch } from './http'
import type { Currency } from '../mock/types'

/** The backend `{ data: T }` response envelope (ADR-030). */
interface ResponseEnvelope<T> {
  data: T
}

/** Where a forecast commitment line comes from (ADR-176/177). */
export type CommitmentSource = 'subscription' | 'installment' | 'tax'

/** The forecast confidence tier (ADR-176). Always `'committed'` in v1. */
export type ForecastConfidence = 'committed' | 'estimated'

/** One forecast month's committed outflow total as serialized by the backend. */
export interface ForecastMonthDto {
  /** Calendar month as `YYYY-MM`. */
  month: string
  /** SUM of committed outflows in the requested currency, as a Decimal string. */
  committed: string
  /** Total projected outflow; equals `committed` in v1 (Decimal string). */
  total: string
  /** `'committed'` in v1; `'estimated'` reserved for a later discretionary band. */
  confidence: string
}

/** One committed stream feeding the forecast as serialized by the backend. */
export interface CommitmentLineDto {
  /** Whether this is a subscription, an installment tail, or the tax cuota. */
  source: CommitmentSource
  /** Human label for the stream (the transaction name, or a tax label). */
  label: string
  /** The per-occurrence committed amount in the requested currency (Decimal string). */
  amount: string
  /** The denomination the amount is expressed in (`ARS` / `USD`). */
  currency: string
  /**
   * Whether this stream is a fixed AFIP-ARS obligation (the monotributo cuota,
   * ADR-177). When `true` the line is ALWAYS ARS and is summed into the month
   * totals only on an ARS request; on a USD request it is EXCLUDED from
   * `committed`/`total` and returned only as its own ARS commitment line.
   */
  arsFixed: boolean
  /** The forecast months (`YYYY-MM`, oldest-first) this stream lands a payment in. */
  months: string[]
  /**
   * For an installment tail, the number of payments still to come
   * (`installmentsTotal - installmentsIndex`); `null` for a subscription or the tax.
   */
  remainingCount: number | null
}

/** The `data` payload of `GET /reports/forecast` (ADR-176). */
export interface ForecastSeriesDto {
  /** Number of forward months projected (1..12). */
  horizon: number
  /** The denomination currency (`ARS` / `USD`), echoed back. */
  currency: string
  /** Oldest-first per-month committed-outflow series over the horizon. */
  months: ForecastMonthDto[]
  /** The distinct committed streams feeding the series. */
  commitments: CommitmentLineDto[]
  /** Count of committed rows excluded from a USD denomination for lacking a snapshot. */
  unconverted: number
}

/** One adapted forecast month (numbers) the chart consumes. */
export interface ForecastMonth {
  /** Calendar month as `YYYY-MM` (kept raw; the chart localizes the label). */
  month: string
  /** Committed outflow total for the month (finite number, 0 on garbage). */
  committed: number
  /** Total projected outflow; equals `committed` in v1. */
  total: number
  /** Confidence tier; `'committed'` in v1, else the reserved `'estimated'`. */
  confidence: ForecastConfidence
}

/** One adapted committed stream (numbers) the commitments/installments list consumes. */
export interface CommitmentLine {
  source: CommitmentSource
  label: string
  /** Per-occurrence committed amount in the requested currency (finite number). */
  amount: number
  /** The denomination the amount is expressed in (`ARS` / `USD`). */
  currency: Currency
  /**
   * Whether this stream is a fixed AFIP-ARS obligation (the monotributo cuota,
   * ADR-177) — always ARS, in the month totals only on the ARS request and
   * excluded from a USD total (surfaced separately). Defaults to `false`.
   */
  arsFixed: boolean
  /** The forecast months (`YYYY-MM`, oldest-first) this stream lands a payment in. */
  months: string[]
  /** Remaining payments for an installment tail; `null` for a subscription/tax. */
  remainingCount: number | null
}

/** The adapted forecast the panel consumes (ADR-176). Money already in `currency`. */
export interface ForecastSeries {
  horizon: number
  currency: Currency
  months: ForecastMonth[]
  commitments: CommitmentLine[]
  unconverted: number
}

/** An API error that carries the HTTP status so callers can branch on it. */
export class ForecastApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ForecastApiError'
    this.status = status
  }
}

/** Throw a {@link ForecastApiError} for any non-2xx response. */
async function ensureOk(response: Response): Promise<void> {
  if (response.ok) return
  let detail = ''
  try {
    detail = await response.text()
  } catch {
    // Ignore body-read failures; the status is enough for the calm error state.
  }
  throw new ForecastApiError(
    response.status,
    `Forecast API request failed with ${response.status}${
      detail ? `: ${detail}` : ''
    }`,
  )
}

/** Parse a Decimal string (e.g. "120000.00") to a number; non-finite → 0. */
function parseDecimal(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Narrow the backend confidence string to the union; unknown → `'committed'`. */
function asConfidence(value: string): ForecastConfidence {
  return value === 'estimated' ? 'estimated' : 'committed'
}

/** Narrow a line's currency string to the union; anything but USD → ARS. */
function asCurrency(value: string): Currency {
  return value === 'USD' ? 'USD' : 'ARS'
}

/** Adapt one forecast month: parse both Decimal totals + narrow the tier. */
export function adaptForecastMonth(dto: ForecastMonthDto): ForecastMonth {
  return {
    month: dto.month,
    committed: parseDecimal(dto.committed),
    total: parseDecimal(dto.total),
    confidence: asConfidence(dto.confidence),
  }
}

/** Adapt one committed stream: parse the amount, keep the months, pass the count. */
export function adaptCommitmentLine(dto: CommitmentLineDto): CommitmentLine {
  return {
    source: dto.source,
    label: dto.label,
    amount: parseDecimal(dto.amount),
    currency: asCurrency(dto.currency),
    // A fixed AFIP-ARS obligation (the monotributo cuota, ADR-177); default false
    // so pre-flag payloads and non-tax streams read as regular committed lines.
    arsFixed: dto.arsFixed === true,
    months: dto.months ?? [],
    // A null remaining count is meaningful ("not an installment"); keep it null.
    remainingCount:
      typeof dto.remainingCount === 'number' &&
      Number.isFinite(dto.remainingCount)
        ? dto.remainingCount
        : null,
  }
}

/**
 * Adapt the full backend forecast payload to the panel-ready read model
 * (ADR-176/177). Money is parsed to numbers at this single boundary (ADR-102);
 * the figures are ALREADY in the requested currency (ADR-168), so nothing here
 * converts.
 */
export function adaptForecastSeries(dto: ForecastSeriesDto): ForecastSeries {
  return {
    horizon: dto.horizon,
    currency: asCurrency(dto.currency),
    months: (dto.months ?? []).map(adaptForecastMonth),
    commitments: (dto.commitments ?? []).map(adaptCommitmentLine),
    unconverted: dto.unconverted ?? 0,
  }
}

/**
 * GET the schedule/commitment-driven cash-flow forecast (ADR-176/177): a forward
 * per-month committed-outflow series over `horizon` months plus the distinct
 * committed streams (subscriptions, installment tails, the monotributo cuota) —
 * every figure denominated in `currency` (ADR-168). Unwraps the `{ data }`
 * envelope (ADR-030) and adapts it to numbers. An out-of-range `horizon` or
 * out-of-set `currency` yields a 422, which surfaces as a {@link ForecastApiError}
 * for the calm error state.
 */
export async function fetchForecast(
  horizon: number,
  currency: Currency,
): Promise<ForecastSeries> {
  const params = new URLSearchParams({
    horizon: String(horizon),
    currency,
  })
  const response = await authedFetch(
    apiUrl(`/reports/forecast?${params.toString()}`),
    { headers: { Accept: 'application/json' } },
  )
  await ensureOk(response)
  const { data } = (await response.json()) as ResponseEnvelope<ForecastSeriesDto>
  return adaptForecastSeries(data)
}

/** The forecast API client, grouped for ergonomic import. */
export const forecastClient = {
  fetchForecast,
} as const
