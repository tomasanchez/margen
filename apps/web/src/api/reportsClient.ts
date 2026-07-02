/**
 * Reports API client + DTO boundary (ADR-163, ADR-164, ADR-165).
 *
 * The single boundary between the backend's `/reports` REST contract and the
 * Reports page read models. Two net-new pieces live here (ADR-163 reuses the
 * summaries/budgets/accounts readers directly, so those keep their own clients):
 *
 *  - `GET /reports/net-worth-history?months=` — the monthly net-worth series
 *    (ADR-164). The backend returns the cumulative month-END NATIVE per-currency
 *    subtotals (`arsTotal` / `usdTotal`) as Decimal STRINGS (ADR-025), oldest →
 *    newest, ending at the current month, wrapped in the `{ data }` envelope
 *    (ADR-030). The backend performs NO currency conversion; the frontend
 *    converts each point at the live MEP rate (ADR-164) — see the Reports
 *    net-worth chart. This client only unwraps + parses the Decimal strings to
 *    numbers at the display edge (ADR-102).
 *  - `GET /reports/export/transactions` and `GET /reports/export/summary` — CSV
 *    exports (ADR-165). These return `text/csv` behind the bearer guard, so a
 *    plain `<a href>` can't reach them; this client builds the authed URL and
 *    fetches the bytes as a Blob (the download hook triggers the save).
 *
 * Mirrors {@link summariesClient} / {@link budgetsClient} (ADR-033): `apiUrl()`
 * for the versioned URL, `authedFetch` for the bearer token (ADR-092), and a
 * status-carrying error on any non-2xx so TanStack Query treats it as a failure
 * and the panel can show the calm error state (ADR-037).
 */

import { apiUrl } from '../config'
import { authedFetch } from './http'

/** The backend `{ data: T }` response envelope (ADR-030). */
interface ResponseEnvelope<T> {
  data: T
}

/**
 * One month's cumulative month-END native net balance per currency as
 * serialized by the backend (Decimal strings, ADR-025/164).
 */
export interface NetWorthHistoryPointDto {
  /** Calendar month as `YYYY-MM`. */
  month: string
  /** Cumulative native ARS balance at month-end, as a Decimal string. */
  arsTotal: string
  /** Cumulative native USD balance at month-end, as a Decimal string. */
  usdTotal: string
}

/** The `data` payload of `GET /reports/net-worth-history` (ADR-164). */
export interface NetWorthHistoryDto {
  /** Per-month native subtotals, oldest-first, ending at the current month. */
  months: NetWorthHistoryPointDto[]
}

/**
 * One adapted history point in the frontend read model. Money stays NATIVE (per
 * currency) and is parsed to a number here so the chart can convert each point
 * at the live rate (ADR-164) — no conversion happens in this client.
 */
export interface NetWorthHistoryPoint {
  /** Calendar month as `YYYY-MM` (kept raw; the chart localizes the label). */
  month: string
  /** Cumulative native ARS balance at month-end (finite number, 0 on garbage). */
  arsTotal: number
  /** Cumulative native USD balance at month-end (finite number, 0 on garbage). */
  usdTotal: number
}

/** The adapted net-worth history series the chart consumes (ADR-164). */
export interface NetWorthHistory {
  months: NetWorthHistoryPoint[]
}

/** An API error that carries the HTTP status so callers can branch on it. */
export class ReportsApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ReportsApiError'
    this.status = status
  }
}

/** Throw a {@link ReportsApiError} for any non-2xx response. */
async function ensureOk(response: Response): Promise<void> {
  if (response.ok) return
  let detail = ''
  try {
    detail = await response.text()
  } catch {
    // Ignore body-read failures; the status is enough for the calm error state.
  }
  throw new ReportsApiError(
    response.status,
    `Reports API request failed with ${response.status}${
      detail ? `: ${detail}` : ''
    }`,
  )
}

/** Parse a Decimal string (e.g. "100000.00") to a number; non-finite → 0. */
function parseDecimal(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Adapt one backend history point: parse both Decimal subtotals to numbers. */
export function adaptNetWorthHistoryPoint(
  dto: NetWorthHistoryPointDto,
): NetWorthHistoryPoint {
  return {
    month: dto.month,
    arsTotal: parseDecimal(dto.arsTotal),
    usdTotal: parseDecimal(dto.usdTotal),
  }
}

/** Adapt the full backend history payload to the chart-ready read model. */
export function adaptNetWorthHistory(dto: NetWorthHistoryDto): NetWorthHistory {
  return { months: (dto.months ?? []).map(adaptNetWorthHistoryPoint) }
}

/**
 * GET the monthly net-worth history (ADR-164): the last `months` months of
 * cumulative month-END NATIVE per-currency subtotals, oldest → newest. Unwraps
 * the `{ data }` envelope (ADR-030) and adapts each point to numbers. Throws
 * {@link ReportsApiError} on a non-2xx.
 */
export async function fetchNetWorthHistory(
  months = 12,
): Promise<NetWorthHistory> {
  const response = await authedFetch(
    apiUrl(`/reports/net-worth-history?months=${encodeURIComponent(months)}`),
    { headers: { Accept: 'application/json' } },
  )
  await ensureOk(response)
  const { data } = (await response.json()) as ResponseEnvelope<NetWorthHistoryDto>
  return adaptNetWorthHistory(data)
}

/**
 * Build the `/reports/export/transactions` URL with the optional inclusive
 * `[from, to]` ISO (`YYYY-MM-DD`) date bounds (ADR-165). Both omitted → all-time.
 * The `from`/`to` params match the backend's aliased query names exactly.
 */
export function transactionsExportUrl(range: {
  from?: string
  to?: string
} = {}): string {
  const params = new URLSearchParams()
  if (range.from) params.set('from', range.from)
  if (range.to) params.set('to', range.to)
  const query = params.toString()
  return apiUrl(`/reports/export/transactions${query ? `?${query}` : ''}`)
}

/**
 * Build the `/reports/export/summary` URL for a `YYYY-MM` month (ADR-165). An
 * omitted month lets the backend default to the current server month.
 */
export function summaryExportUrl(month?: string): string {
  const query = month ? `?month=${encodeURIComponent(month)}` : ''
  return apiUrl(`/reports/export/summary${query}`)
}

/**
 * Fetch a CSV export as a Blob through the authed fetcher (ADR-165/092): the
 * export endpoints require the bearer token, so a plain `<a href>` 401s — the
 * caller wraps this Blob in an object URL and triggers a download. Throws
 * {@link ReportsApiError} on a non-2xx so the button can surface a calm error.
 */
async function fetchCsvBlob(url: string): Promise<Blob> {
  const response = await authedFetch(url, { headers: { Accept: 'text/csv' } })
  await ensureOk(response)
  return response.blob()
}

/**
 * Fetch the transactions CSV export as a Blob (ADR-165), optionally date-bounded.
 * Never returns a partial file — a non-2xx throws so the caller shows a calm error.
 */
export function fetchTransactionsCsv(
  range: { from?: string; to?: string } = {},
): Promise<Blob> {
  return fetchCsvBlob(transactionsExportUrl(range))
}

/** Fetch the monthly category-summary CSV export as a Blob (ADR-165). */
export function fetchSummaryCsv(month?: string): Promise<Blob> {
  return fetchCsvBlob(summaryExportUrl(month))
}

/** The reports API client, grouped for ergonomic import. */
export const reportsClient = {
  fetchNetWorthHistory,
  fetchTransactionsCsv,
  fetchSummaryCsv,
  transactionsExportUrl,
  summaryExportUrl,
} as const
