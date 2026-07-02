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
import type { Currency } from '../mock/types'

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

// ---------------------------------------------------------------------------
// Reports overview (ADR-167, ADR-168, ADR-169) — the range-based analytics
// payload. Every money field is a Decimal STRING (ADR-025) ALREADY denominated
// in the requested currency (ADR-168): the frontend never re-converts. Share /
// savings-rate / delta PERCENTAGES arrive as plain number-strings ("60",
// "-20", "37.5") — the adapter parses them verbatim at the display edge
// (ADR-102), never re-scaling them.
// ---------------------------------------------------------------------------

/** The allowed analytics windows (ADR-167). */
export type ReportsRange = '3M' | '6M' | '12M' | 'YTD'

/** One window's headline KPIs as serialized by the backend (Decimal strings). */
export interface ReportsKpiDto {
  income: string
  expenses: string
  netSaved: string
  /** net_saved / income as a PERCENTAGE (e.g. "57.1", "60"); "0" when income ≤ 0. */
  savingsRate: string
}

/** The KPI strip: the selected window plus the immediately-preceding one. */
export interface ReportsKpisDto {
  current: ReportsKpiDto
  previous: ReportsKpiDto
}

/** One month's income vs expenses in the requested currency (Decimal strings). */
export interface CashFlowPointDto {
  month: string
  income: string
  expenses: string
}

/** One expense category's trend over the current window. */
export interface CategoryTrendDto {
  category: string
  total: string
  /** Share of the window's total expenses as a percentage-string ("22"). */
  share: string
  /** Trailing-6-month monthly totals for a sparkline, oldest-first. */
  series: string[]
  /** Percent change vs the previous window as a PERCENTAGE-string ("-20", "100"); null when no base. */
  deltaPct: string | null
}

/** One month's average captured FX rate for the FX sparkline; null when none. */
export interface RateSeriesPointDto {
  month: string
  rate: string | null
}

/** The FX & purchasing-power summary over the current window. */
export interface FxSummaryDto {
  /** Mean of per-month average captured rates; null when no month has a rate. */
  avgMep: string | null
  usdInvoiced: string
  rateSeries: RateSeriesPointDto[]
}

/** The `data` payload of `GET /reports/overview` (ADR-169). */
export interface ReportsOverviewDto {
  range: string
  currency: string
  kpis: ReportsKpisDto
  cashFlow: CashFlowPointDto[]
  categoryTrends: CategoryTrendDto[]
  fxSummary: FxSummaryDto
  /** Count of rows excluded from a USD denomination for lacking a snapshot. */
  unconverted: number
}

/** One window's KPIs adapted to numbers for the KPI strip. */
export interface ReportsKpi {
  income: number
  expenses: number
  netSaved: number
  /** Savings rate as a PERCENTAGE (57.1 = 57.1%); 0 when income ≤ 0. */
  savingsRate: number
}

/** The current + previous KPI windows the strip computes deltas from. */
export interface ReportsKpis {
  current: ReportsKpi
  previous: ReportsKpi
}

/** One adapted cash-flow month (numbers) the grouped bar chart consumes. */
export interface CashFlowPoint {
  month: string
  income: number
  expenses: number
}

/** One adapted category-trend row (numbers) the trends table consumes. */
export interface CategoryTrend {
  category: string
  total: number
  /** Share of window expenses as a whole-ish percentage (22 = 22%). */
  share: number
  /** Trailing-6-month totals for the sparkline, oldest-first. */
  series: number[]
  /** Percent change vs the previous window as a PERCENTAGE (−6 = −6%); null when no base. */
  deltaPct: number | null
}

/** One adapted FX rate-series point (numbers); rate null when the month has none. */
export interface RateSeriesPoint {
  month: string
  rate: number | null
}

/** The adapted FX & purchasing-power summary the FX panel consumes. */
export interface FxSummary {
  avgMep: number | null
  usdInvoiced: number
  rateSeries: RateSeriesPoint[]
}

/** The adapted range-based Reports overview the page consumes (ADR-167). */
export interface ReportsOverview {
  range: string
  currency: string
  kpis: ReportsKpis
  cashFlow: CashFlowPoint[]
  categoryTrends: CategoryTrend[]
  fxSummary: FxSummary
  unconverted: number
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
 * Parse a nullable Decimal/number string. A null/absent value stays null (a
 * meaningful "no data" signal for avgMep and per-month rates); garbage → null.
 */
function parseNullableDecimal(value: string | null | undefined): number | null {
  if (value == null) return null
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Adapt one KPI window: parse all four Decimal/number strings to numbers. */
function adaptKpi(dto: ReportsKpiDto): ReportsKpi {
  return {
    income: parseDecimal(dto.income),
    expenses: parseDecimal(dto.expenses),
    netSaved: parseDecimal(dto.netSaved),
    savingsRate: parseDecimal(dto.savingsRate),
  }
}

/** Adapt one cash-flow month to numbers. */
function adaptCashFlowPoint(dto: CashFlowPointDto): CashFlowPoint {
  return {
    month: dto.month,
    income: parseDecimal(dto.income),
    expenses: parseDecimal(dto.expenses),
  }
}

/** Adapt one category-trend row: parse the total, share, series and delta. */
function adaptCategoryTrend(dto: CategoryTrendDto): CategoryTrend {
  return {
    category: dto.category,
    total: parseDecimal(dto.total),
    share: parseDecimal(dto.share),
    series: (dto.series ?? []).map(parseDecimal),
    deltaPct: parseNullableDecimal(dto.deltaPct),
  }
}

/** Adapt the FX summary: nullable avg/rate points stay null when absent. */
function adaptFxSummary(dto: FxSummaryDto): FxSummary {
  return {
    avgMep: parseNullableDecimal(dto.avgMep),
    usdInvoiced: parseDecimal(dto.usdInvoiced),
    rateSeries: (dto.rateSeries ?? []).map((point) => ({
      month: point.month,
      rate: parseNullableDecimal(point.rate),
    })),
  }
}

/**
 * Adapt the full backend overview payload to the page-ready read model
 * (ADR-167/169). Money + percentages are parsed to numbers at this single
 * boundary (ADR-102); the figures are ALREADY in the requested currency
 * (ADR-168), so nothing here converts.
 */
export function adaptReportsOverview(dto: ReportsOverviewDto): ReportsOverview {
  return {
    range: dto.range,
    currency: dto.currency,
    kpis: {
      current: adaptKpi(dto.kpis.current),
      previous: adaptKpi(dto.kpis.previous),
    },
    cashFlow: (dto.cashFlow ?? []).map(adaptCashFlowPoint),
    categoryTrends: (dto.categoryTrends ?? []).map(adaptCategoryTrend),
    fxSummary: adaptFxSummary(dto.fxSummary),
    unconverted: dto.unconverted ?? 0,
  }
}

/**
 * GET the range-based Reports overview (ADR-167/169): KPI strip (current +
 * previous), per-month cash flow, category trends, and the FX summary — every
 * figure denominated in `currency` (ADR-168). Unwraps the `{ data }` envelope
 * (ADR-030) and adapts it to numbers. An out-of-set `range`/`currency` yields a
 * 422, which surfaces as a {@link ReportsApiError} for the calm error state.
 */
export async function fetchReportsOverview(
  range: ReportsRange,
  currency: Currency,
): Promise<ReportsOverview> {
  const params = new URLSearchParams({ range, currency })
  const response = await authedFetch(
    apiUrl(`/reports/overview?${params.toString()}`),
    { headers: { Accept: 'application/json' } },
  )
  await ensureOk(response)
  const { data } = (await response.json()) as ResponseEnvelope<ReportsOverviewDto>
  return adaptReportsOverview(data)
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
  fetchReportsOverview,
  fetchTransactionsCsv,
  fetchSummaryCsv,
  transactionsExportUrl,
  summaryExportUrl,
} as const
