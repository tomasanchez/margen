/**
 * Real monthly-insights API client + DTO adapter (ADR-061, ADR-062).
 *
 * This is the single boundary between the backend's `/insights` REST contract
 * (`GET /api/v1/insights?month=YYYY-MM`, a `{ data }` envelope, camelCase field
 * names, Decimal-string money/percentage values) and the frontend's
 * {@link MonthlyInsights} facts object. The backend returns STRUCTURED FACTS,
 * not prose: every Decimal string is parsed to a number here, and the Insights
 * card formats the calm sentences with the es-AR formatters + display-currency
 * preference (ADR-016/ADR-056). Optional facts are `null` when absent.
 *
 * Mirrors {@link summariesClient} (ADR-033/ADR-043): `apiUrl()` for the
 * versioned URL, `ensureOk` throwing a status-carrying error on non-2xx so
 * TanStack Query treats it as a failure and Home can show a calm state
 * (ADR-037).
 */

import { apiUrl } from '../config'
import { authedFetch } from './http'
import type { Category, FxRateType } from '../mock/types'

/** The backend `{ data: T }` response envelope (ADR-030). */
interface ResponseEnvelope<T> {
  data: T
}

/** Biggest positive expense category mover vs the prior month (Decimal strings). */
interface TopCategoryMoverDto {
  category: string
  /** Month-over-month percentage move, as a Decimal string (e.g. "22.00"). */
  deltaPct: string
}

/** Recurring expenses this month (count + Decimal total). */
interface RecurringDto {
  count: number
  /** ARS total of the recurring expenses, as a Decimal string. */
  total: string
}

/** Savings this month — projected for the current month, actual for a past one. */
interface SavingsDto {
  /** ARS amount, as a Decimal string. */
  amount: string
  /** Whether the figure is a projection (current month) vs actual (past month). */
  isProjected: boolean
  /** Fraction of the month elapsed [0, 1], as a Decimal string. */
  elapsedFraction: string
}

/** The latest USD invoice this month (Decimal strings + ISO date). */
interface LatestUsdInvoiceDto {
  /** Original USD amount, as a Decimal string. */
  usd: string
  /** ARS-per-USD rate applied, as a Decimal string. */
  rate: string
  /** Source of the rate (e.g. "MEP", "manual"). */
  rateType: string
  /** ISO calendar date the invoice occurred on (`YYYY-MM-DD`). */
  occurredOn: string
}

/**
 * One near-term card-payment due date, in a single native currency (ADR-192).
 * The backend groups per (due date, currency) and never sums across currencies
 * (ADR-133), so a due date with both ARS and USD charges yields two entries.
 */
interface UpcomingCardDueDto {
  /** ISO calendar date the payment is due on (`YYYY-MM-DD`). */
  dueDate: string
  /** Native ARS amount due on this date, as a Decimal string (may be "0"). */
  ars: string
  /** Native USD amount due on this date, as a Decimal string (may be "0"). */
  usd: string
}

/** The `data` payload of `GET /insights`. */
export interface MonthlyInsightsDto {
  /** Requested calendar month as `YYYY-MM`. */
  month: string
  topCategoryMover: TopCategoryMoverDto | null
  recurring: RecurringDto | null
  savings: SavingsDto
  latestUsdInvoice: LatestUsdInvoiceDto | null
  /**
   * Card payments due within the next 3 days (ADR-192), one entry per due date,
   * ordered ascending; `null` when nothing is due in the window.
   */
  upcomingCardDue: UpcomingCardDueDto[] | null
}

/** Biggest positive expense category mover, parsed to numbers. */
export interface TopCategoryMover {
  category: Category
  /** Month-over-month percentage move (e.g. 22 for +22%). */
  deltaPct: number
}

/** Recurring expenses this month, parsed to numbers. */
export interface RecurringFact {
  count: number
  /** ARS total of the recurring expenses. */
  total: number
}

/** Savings this month, parsed to numbers. */
export interface SavingsFact {
  /** ARS amount. */
  amount: number
  /** Whether the figure is a projection (current month) vs actual. */
  isProjected: boolean
  /** Fraction of the month elapsed [0, 1]. */
  elapsedFraction: number
}

/** The latest USD invoice this month, parsed to numbers. */
export interface LatestUsdInvoiceFact {
  /** Original USD amount. */
  usd: number
  /** ARS-per-USD rate applied. */
  rate: number
  /** Source of the rate (`MEP` / `manual` / …). */
  rateType: FxRateType
  /** ISO calendar date the invoice occurred on (`YYYY-MM-DD`). */
  occurredOn: string
}

/** One near-term card-payment due date, parsed to numbers (ADR-192). */
export interface UpcomingCardDueFact {
  /** ISO calendar date the payment is due on (`YYYY-MM-DD`). */
  dueDate: string
  /** Native ARS amount due on this date (may be 0). */
  ars: number
  /** Native USD amount due on this date (may be 0). */
  usd: number
}

/**
 * The adapted monthly insights the Home card consumes directly (ADR-061/062).
 * Optional facts are `null` when their underlying data is absent; the card
 * composes one calm sentence per non-null fact and falls back to its empty
 * state when none apply.
 */
export interface MonthlyInsights {
  /** Requested calendar month as `YYYY-MM`. */
  month: string
  topCategoryMover: TopCategoryMover | null
  recurring: RecurringFact | null
  /** Always present — projected for the current month, actual for a past one. */
  savings: SavingsFact
  latestUsdInvoice: LatestUsdInvoiceFact | null
  /**
   * Card payments due within the next 3 days (ADR-192), each in native ARS +
   * USD (never a cross-currency total); `null` when nothing is due soon.
   */
  upcomingCardDue: UpcomingCardDueFact[] | null
}

/** An API error that carries the HTTP status so callers can branch on it. */
export class InsightsApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'InsightsApiError'
    this.status = status
  }
}

/** Throw an {@link InsightsApiError} for any non-2xx response. */
async function ensureOk(response: Response): Promise<void> {
  if (response.ok) return
  let detail = ''
  try {
    detail = await response.text()
  } catch {
    // Ignore body-read failures; the status is enough for the calm state.
  }
  throw new InsightsApiError(
    response.status,
    `Insights API request failed with ${response.status}${
      detail ? `: ${detail}` : ''
    }`,
  )
}

/** Parse a Decimal string (e.g. "300.00") to a number; non-finite → 0. */
function parseDecimal(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Narrow an arbitrary backend category string to the prototype's union. */
function asCategory(value: string): Category {
  return value as Category
}

/** Narrow an arbitrary backend rate-type string to the FX union. */
function asFxRateType(value: string): FxRateType {
  return value as FxRateType
}

/** Adapt the full backend insights payload to the card-ready facts object. */
export function adaptInsights(dto: MonthlyInsightsDto): MonthlyInsights {
  return {
    month: dto.month,
    topCategoryMover: dto.topCategoryMover
      ? {
          category: asCategory(dto.topCategoryMover.category),
          deltaPct: parseDecimal(dto.topCategoryMover.deltaPct),
        }
      : null,
    recurring: dto.recurring
      ? {
          count: dto.recurring.count,
          total: parseDecimal(dto.recurring.total),
        }
      : null,
    savings: {
      amount: parseDecimal(dto.savings.amount),
      isProjected: dto.savings.isProjected,
      elapsedFraction: parseDecimal(dto.savings.elapsedFraction),
    },
    latestUsdInvoice: dto.latestUsdInvoice
      ? {
          usd: parseDecimal(dto.latestUsdInvoice.usd),
          rate: parseDecimal(dto.latestUsdInvoice.rate),
          rateType: asFxRateType(dto.latestUsdInvoice.rateType),
          occurredOn: dto.latestUsdInvoice.occurredOn,
        }
      : null,
    // Preserve order (ascending due date) and keep each currency native — the
    // Decimal strings are parsed here so downstream rendering never re-parses.
    upcomingCardDue: dto.upcomingCardDue
      ? dto.upcomingCardDue.map((entry) => ({
          dueDate: entry.dueDate,
          ars: parseDecimal(entry.ars),
          usd: parseDecimal(entry.usd),
        }))
      : null,
  }
}

/**
 * GET the monthly insights for `month` (`YYYY-MM`), unwrap the `{ data }`
 * envelope, and adapt the structured facts to numbers. Throws
 * {@link InsightsApiError} on a non-2xx response.
 */
export async function fetchInsights(month: string): Promise<MonthlyInsights> {
  const response = await authedFetch(
    apiUrl(`/insights?month=${encodeURIComponent(month)}`),
    { headers: { Accept: 'application/json' } },
  )
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<MonthlyInsightsDto>
  return adaptInsights(envelope.data)
}

/** The insights API client, grouped for ergonomic import. */
export const insightsClient = {
  fetchInsights,
} as const
