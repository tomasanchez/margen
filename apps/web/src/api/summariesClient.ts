/**
 * Real monthly-summaries API client + DTO adapter (ADR-042, ADR-043).
 *
 * This is the single boundary between the backend's `/summaries` REST contract
 * (`GET /api/v1/summaries?month=YYYY-MM`, a `{ data }` envelope, camelCase field
 * names, Decimal-string money/share/deltaPct) and the frontend's existing
 * {@link TrendPoint} / {@link CategorySpend} card shapes. The `SpendingTrend`
 * and `CategoryBreakdown` components keep speaking the prototype shape unchanged;
 * every contract difference (envelope unwrap, Decimal-string → number,
 * `YYYY-MM` → short month label, `deltaPct` → `+N%` badge) is resolved here.
 *
 * Mirrors {@link transactionsClient} (ADR-033): `apiUrl()` for the versioned URL,
 * `ensureOk` throwing a status-carrying error on non-2xx so TanStack Query treats
 * it as a failure and Home can show the calm error state (ADR-037).
 */

import { apiUrl } from '../config'
import { authedFetch } from './http'
import type { Category, CategorySpend, TrendPoint } from '../mock/types'

/** The backend `{ data: T }` response envelope (ADR-030). */
interface ResponseEnvelope<T> {
  data: T
}

/** One trend entry as serialized by the backend: month label + Decimal expenses. */
export interface SummaryTrendDto {
  /** Calendar month as `YYYY-MM`. */
  month: string
  /** ARS expenses for that month, as a Decimal string (ADR-025). */
  expenses: string
  /** Whether this is the requested (current) month. */
  current: boolean
}

/** One category entry as serialized by the backend (Decimal strings). */
export interface SummaryCategoryDto {
  category: string
  /** ARS spend for the category this month, as a Decimal string. */
  amount: string
  /** Share of the month's total expenses (0–100), as a Decimal string. */
  share: string
  /**
   * Month-over-month delta percentage vs the same category last month, as a
   * Decimal string; `null` when the prior month's total was 0 (ADR-042).
   */
  deltaPct: string | null
}

/** The `data` payload of `GET /summaries`. */
export interface SummaryDto {
  /** Requested calendar month as `YYYY-MM`. */
  month: string
  /** 6 months oldest → newest, the requested month flagged `current`. */
  trend: SummaryTrendDto[]
  /** Expenses grouped by category, sorted by amount descending. */
  categories: SummaryCategoryDto[]
}

/** The adapted summary the Home cards consume directly (ADR-043). */
export interface Summary {
  trend: TrendPoint[]
  categories: CategorySpend[]
}

/** An API error that carries the HTTP status so callers can branch on it. */
export class SummaryApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'SummaryApiError'
    this.status = status
  }
}

/** Throw a {@link SummaryApiError} for any non-2xx response. */
async function ensureOk(response: Response): Promise<void> {
  if (response.ok) return
  let detail = ''
  try {
    detail = await response.text()
  } catch {
    // Ignore body-read failures; the status is enough for the calm error state.
  }
  throw new SummaryApiError(
    response.status,
    `Summaries API request failed with ${response.status}${
      detail ? `: ${detail}` : ''
    }`,
  )
}

/** Parse a Decimal string (e.g. "300.00") to a number; non-finite → 0. */
function parseDecimal(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Short month labels indexed by 0-based month, e.g. 5 → "Jun". */
const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

/**
 * Derive a short month label from a `YYYY-MM` string, e.g. "2026-06" → "Jun".
 * Falls back to the raw input if the month part is out of range.
 */
export function shortMonthLabel(yyyyMm: string): string {
  const monthPart = Number.parseInt(yyyyMm.slice(5, 7), 10)
  const label = SHORT_MONTHS[monthPart - 1]
  return label ?? yyyyMm
}

/** Narrow an arbitrary backend category string to the prototype's union. */
function asCategory(value: string): Category {
  return value as Category
}

/**
 * Adapt one backend trend entry to a {@link TrendPoint}: parse the Decimal
 * expenses to a number and turn the `YYYY-MM` month into a short label.
 */
function adaptTrendPoint(dto: SummaryTrendDto): TrendPoint {
  return {
    month: shortMonthLabel(dto.month),
    value: parseDecimal(dto.expenses),
    ...(dto.current ? { current: true } : {}),
  }
}

/**
 * Adapt one backend category entry to a {@link CategorySpend}: parse Decimal
 * amount/share to numbers and turn a positive `deltaPct` into a `+N%` badge
 * (the card shows the `up` badge only when it is present). A null, zero or
 * negative delta yields no badge.
 */
function adaptCategorySpend(dto: SummaryCategoryDto): CategorySpend {
  const delta = dto.deltaPct === null ? null : parseDecimal(dto.deltaPct)
  const rose = delta !== null && delta > 0
  return {
    category: asCategory(dto.category),
    amount: parseDecimal(dto.amount),
    pct: parseDecimal(dto.share),
    ...(rose ? { up: `+${Math.round(delta)}%` } : {}),
  }
}

/** Adapt the full backend summary payload to the card-ready {@link Summary}. */
export function adaptSummary(dto: SummaryDto): Summary {
  return {
    trend: dto.trend.map(adaptTrendPoint),
    categories: dto.categories.map(adaptCategorySpend),
  }
}

/**
 * GET the monthly summary for `month` (`YYYY-MM`), unwrap the `{ data }`
 * envelope, and adapt it to the card shapes. Throws {@link SummaryApiError} on
 * a non-2xx response.
 */
export async function fetchSummary(month: string): Promise<Summary> {
  const response = await authedFetch(
    apiUrl(`/summaries?month=${encodeURIComponent(month)}`),
    { headers: { Accept: 'application/json' } },
  )
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<SummaryDto>
  return adaptSummary(envelope.data)
}

/** The summaries API client, grouped for ergonomic import. */
export const summariesClient = {
  fetchSummary,
} as const
