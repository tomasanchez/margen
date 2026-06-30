/**
 * Budgets API client + DTO boundary (ADR-125, ADR-130).
 *
 * The single boundary between the backend's budgets REST contract and the
 * frontend's {@link Budget} read model. A budget is a per-category target amount
 * for a month, aligned to the month navigator (ADR-040/125); actuals (`spent`)
 * come from the SAME category-summaries source server-side (ADR-042/043), so the
 * frontend never re-aggregates spend.
 *
 * Mirrors {@link summariesClient} / {@link accountsClient} (ADR-033): `apiUrl()`
 * for the versioned URL, `authedFetch` for the bearer token (ADR-092), and a
 * status-carrying error on any non-2xx so TanStack Query treats it as a failure
 * and the page can show the calm error state (ADR-037).
 *
 * Money stays a Decimal STRING end-to-end (ADR-025/034); ARS is the only budget
 * currency for the MVP (ADR-125). Unlike the summaries `{ data }` envelope, the
 * budgets reader returns the period object DIRECTLY (`{ month, currency,
 * categories }`) — there is no `data` wrapper — so this client reads the JSON as
 * the period shape without unwrapping.
 */

import { apiUrl } from '../config'
import { authedFetch } from './http'
import type { Category, Currency } from '../mock/types'

/**
 * One category's budget line as serialized by the backend. Every expense
 * category appears (ADR-125). `target` is `null` when the user has not set one;
 * `spent` is the category's actual expense total for the month (ARS, ADR-042);
 * `remaining` is `target − spent` when a target exists, else `null`. All money
 * values are Decimal strings.
 */
export interface BudgetCategoryDto {
  category: string
  /** Target for the month as a Decimal string, or `null` when unset. */
  target: string | null
  /** Actual expense total for the category this month, as a Decimal string. */
  spent: string
  /** `target − spent` as a Decimal string when a target exists, else `null`. */
  remaining: string | null
}

/** The budgets period payload of `GET /budgets` (no `{ data }` envelope). */
export interface BudgetPeriodDto {
  /** Requested calendar month as `YYYY-MM`. */
  month: string
  /** Currency the targets + spend are expressed in (ARS for the MVP). */
  currency: string
  /** Every expense category, with its target / spent / remaining. */
  categories: BudgetCategoryDto[]
}

/** Request body for `PUT /budgets` (upsert a category target). */
export interface BudgetWriteBody {
  category: Category
  /** Period month as `YYYY-MM`. */
  month: string
  /** Target amount as a Decimal string (ADR-025/034), e.g. "120000.00". */
  amount: string
  /** Budget currency; ARS for the MVP (ADR-125). */
  currency?: Currency
}

/**
 * One category's budget line in the frontend read model. Mirrors the DTO but
 * narrows `category` to the {@link Category} union; money stays a Decimal string
 * and is parsed only at the display edge (ADR-102).
 */
export interface BudgetCategory {
  category: Category
  target: string | null
  spent: string
  remaining: string | null
}

/** The adapted budgets period the page + Home card consume. */
export interface BudgetPeriod {
  month: string
  currency: Currency
  categories: BudgetCategory[]
}

/** An API error that carries the HTTP status so callers can branch on it. */
export class BudgetApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'BudgetApiError'
    this.status = status
  }
}

/** Throw a {@link BudgetApiError} for any non-2xx response. */
async function ensureOk(response: Response): Promise<void> {
  if (response.ok) return
  let detail = ''
  try {
    detail = await response.text()
  } catch {
    // Ignore body-read failures; the status is enough for the calm error state.
  }
  throw new BudgetApiError(
    response.status,
    `Budgets API request failed with ${response.status}${
      detail ? `: ${detail}` : ''
    }`,
  )
}

/** Narrow the backend `currency` string to {@link Currency} (default ARS). */
function asCurrency(value: string): Currency {
  return value === 'USD' ? 'USD' : 'ARS'
}

/** Narrow an arbitrary backend category string to the {@link Category} union. */
function asCategory(value: string): Category {
  return value as Category
}

/** Adapt one backend {@link BudgetCategoryDto} to a {@link BudgetCategory}. */
export function adaptBudgetCategory(dto: BudgetCategoryDto): BudgetCategory {
  return {
    category: asCategory(dto.category),
    target: dto.target,
    spent: dto.spent,
    remaining: dto.remaining,
  }
}

/** Adapt the full backend budgets period to the {@link BudgetPeriod}. */
export function adaptBudgetPeriod(dto: BudgetPeriodDto): BudgetPeriod {
  return {
    month: dto.month,
    currency: asCurrency(dto.currency),
    categories: dto.categories.map(adaptBudgetCategory),
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const

/**
 * GET the budgets period for `month` (`YYYY-MM`): every expense category with
 * its target / spent / remaining (ADR-125). Reads the period object directly (no
 * `{ data }` envelope) and adapts it. Throws {@link BudgetApiError} on a non-2xx.
 */
async function fetchBudgets(month: string): Promise<BudgetPeriod> {
  const response = await authedFetch(
    apiUrl(`/budgets?month=${encodeURIComponent(month)}`),
    { headers: { Accept: 'application/json' } },
  )
  await ensureOk(response)
  const period = (await response.json()) as BudgetPeriodDto
  return adaptBudgetPeriod(period)
}

/**
 * PUT a category's target for a month (upsert, ADR-125). The currency defaults
 * to ARS (the only budget currency for the MVP). Resolves on success; throws
 * {@link BudgetApiError} on a non-2xx.
 */
async function setTarget(body: BudgetWriteBody): Promise<void> {
  const response = await authedFetch(apiUrl('/budgets'), {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      category: body.category,
      month: body.month,
      amount: body.amount,
      currency: body.currency ?? 'ARS',
    }),
  })
  await ensureOk(response)
}

/**
 * DELETE a category's target for a month (clear it, ADR-125). Resolves on
 * success; throws {@link BudgetApiError} on a non-2xx.
 */
async function clearTarget(category: Category, month: string): Promise<void> {
  const response = await authedFetch(
    apiUrl(
      `/budgets?category=${encodeURIComponent(category)}&month=${encodeURIComponent(
        month,
      )}`,
    ),
    { method: 'DELETE' },
  )
  await ensureOk(response)
}

/** The budgets API client, grouped for ergonomic import. */
export const budgetsClient = {
  fetchBudgets,
  setTarget,
  clearTarget,
} as const
