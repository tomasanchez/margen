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
 * currency for the MVP (ADR-125). Like the summaries/accounts clients, every
 * budgets read is wrapped in the backend `{ data: T }` envelope (ADR-030), so
 * this client unwraps `.data` before adapting to the frontend read model.
 */

import { apiUrl } from '../config'
import { authedFetch } from './http'
import type { Category, Currency } from '../mock/types'

/** The backend `{ data: T }` response envelope (ADR-030). */
interface ResponseEnvelope<T> {
  data: T
}

/** Row discriminator (ADR-138): spend targets vs saving allocations. */
export type BudgetKind = 'spend' | 'saving'

/**
 * The seven closed saving buckets (ADR-138). Reused as the `category` key on
 * `kind='saving'` rows; never collides with a spend {@link Category}.
 */
export type SavingBucket =
  | 'EmergencyFund'
  | 'DebtAcceleration'
  | 'ShortTermGoals'
  | 'MediumTermGoals'
  | 'LongTermInvestment'
  | 'FxHedge'
  | 'MaintenanceReserve'

/** The three research-fixed saving-rate templates (ADR-138). */
export type SavingProfile = 'conservative' | 'balanced' | 'aggressive'

/** Income-pressure segment from the income/floor ratio (ADR-143). */
export type IncomePressure = 'Constrained' | 'Stable' | 'Comfortable'

/** Source of the household floor amount (ADR-139). */
export type FloorSource = 'manual' | 'computed'

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

/**
 * One saving-bucket line as serialized by the backend (ADR-138). Saving rows
 * live in the same budgets table under `kind='saving'`; `bucket` is a key from
 * the closed `SAVING_BUCKETS` set, `percent` is the profile percentage of net
 * income (a number, e.g. 5 for 5%), and `amount` is the resulting ARS allocation
 * as a Decimal string.
 */
export interface SavingLineDto {
  bucket: string
  /** Percentage of net income for this bucket (e.g. `5` for 5%). */
  percent: number
  /** Allocation amount as a Decimal string (`base × percent`). */
  amount: string
}

/**
 * The household floor co-located on the income row (ADR-139). `amount` is the
 * essentials floor as a Decimal string; `source` is `manual` (user-typed) or
 * `computed` (Σ of essential spend targets).
 */
export interface BudgetFloorDto {
  amount: string
  source: string
}

/** The budgets period payload of `GET /budgets` (no `{ data }` envelope). */
export interface BudgetPeriodDto {
  /** Requested calendar month as `YYYY-MM`. */
  month: string
  /** Currency the targets + spend are expressed in (ARS for the MVP). */
  currency: string
  /** Every expense category, with its target / spent / remaining. */
  categories: BudgetCategoryDto[]
  /** Saving-bucket rows (ADR-138); empty until a profile is applied. */
  savings?: SavingLineDto[]
  /** The household essentials floor + its source (ADR-139), or `null` if unset. */
  floor?: BudgetFloorDto | null
  /** Suggested saving profile from the floor/income ratio (ADR-143), or `null`. */
  suggestedStrategy?: string | null
  /** Income-pressure segment (`Constrained`/`Stable`/`Comfortable`), or `null`. */
  pressure?: string | null
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
  /** Row discriminator (ADR-138); defaults to `'spend'` server-side. */
  kind?: BudgetKind
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

/** One saving-bucket line in the frontend read model (ADR-138). */
export interface SavingLine {
  bucket: SavingBucket
  /** Percentage of net income for this bucket (e.g. `5`). */
  percent: number
  /** Allocation amount as a Decimal string. */
  amount: string
}

/** The household essentials floor in the read model (ADR-139). */
export interface BudgetFloor {
  amount: string
  source: FloorSource
}

/** The adapted budgets period the page + Home card consume. */
export interface BudgetPeriod {
  month: string
  currency: Currency
  categories: BudgetCategory[]
  /** Saving-bucket rows (ADR-138); empty array when none applied. */
  savings: SavingLine[]
  /** The household essentials floor (ADR-139), or `null` when unset. */
  floor: BudgetFloor | null
  /** Suggested saving profile (ADR-143), or `null`. */
  suggestedStrategy: SavingProfile | null
  /** Income-pressure segment (ADR-143), or `null`. */
  pressure: IncomePressure | null
}

/** `GET /budget-income` payload — the per-month net-income base + floor (ADR-139). */
export interface BudgetIncomeDto {
  /** Requested calendar month as `YYYY-MM`. */
  month: string
  /** Net spendable income as a Decimal string, or `null` when unset. */
  amount: string | null
  currency: string
  /** `manual` for the MVP; `monotributo` is Phase 3. */
  source: string
  /** The co-located household floor + its source. */
  floor: BudgetFloorDto | null
}

/** The adapted per-month net-income base the header consumes (ADR-139). */
export interface BudgetIncome {
  month: string
  /** Net spendable income as a Decimal string, or `null` when unset. */
  amount: string | null
  currency: Currency
  source: string
  /** The household essentials floor, or `null` when unset. */
  floor: BudgetFloor | null
}

/** Request body for `PUT /budget-income` (upsert the net-income base + floor). */
export interface BudgetIncomeWriteBody {
  /** Period month as `YYYY-MM`. */
  month: string
  /** Net spendable income as a Decimal string. */
  amount: string
  /** Budget currency; ARS for the MVP. */
  currency?: Currency
  /** Optional manual household-floor override as a Decimal string. */
  floorAmount?: string
  /** Source of the floor when `floorAmount` is sent (`manual` for the MVP). */
  floorSource?: FloorSource
}

/** `POST /budgets/apply-profile` response — the refreshed month + the floor guard. */
export interface ApplyProfileResult {
  period: BudgetPeriod
  /** Whether the preset pushed essentials below the floor (ADR-138). */
  floorBreached: boolean
  /** The shortfall amount as a Decimal string when breached, else `null`. */
  gap: string | null
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

/** Narrow the backend floor `source` string to {@link FloorSource} (default manual). */
function asFloorSource(value: string): FloorSource {
  return value === 'computed' ? 'computed' : 'manual'
}

/**
 * Adapt a backend floor DTO to a {@link BudgetFloor} or `null`. The budgets
 * surface always sends a `floor` object (ADR-143) but with a `null` amount when
 * unset, so treat a missing DTO or a null amount alike as "no floor".
 */
function adaptFloor(dto: BudgetFloorDto | null | undefined): BudgetFloor | null {
  if (dto == null || dto.amount == null) return null
  return { amount: dto.amount, source: asFloorSource(dto.source) }
}

/** Narrow a backend strategy string to {@link SavingProfile}, else `null`. */
function asSavingProfile(value: string | null | undefined): SavingProfile | null {
  return value === 'conservative' || value === 'balanced' || value === 'aggressive'
    ? value
    : null
}

/** Narrow a backend pressure string to {@link IncomePressure}, else `null`. */
function asPressure(value: string | null | undefined): IncomePressure | null {
  return value === 'Constrained' || value === 'Stable' || value === 'Comfortable'
    ? value
    : null
}

/** Adapt one backend {@link SavingLineDto} to a {@link SavingLine}. */
export function adaptSavingLine(dto: SavingLineDto): SavingLine {
  return {
    bucket: dto.bucket as SavingBucket,
    percent: dto.percent,
    amount: dto.amount,
  }
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
    savings: (dto.savings ?? []).map(adaptSavingLine),
    floor: adaptFloor(dto.floor),
    suggestedStrategy: asSavingProfile(dto.suggestedStrategy),
    pressure: asPressure(dto.pressure),
  }
}

/** Adapt the backend net-income payload to the {@link BudgetIncome} read model. */
export function adaptBudgetIncome(dto: BudgetIncomeDto): BudgetIncome {
  return {
    month: dto.month,
    amount: dto.amount,
    currency: asCurrency(dto.currency),
    source: dto.source,
    floor: adaptFloor(dto.floor),
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
  const { data } = (await response.json()) as ResponseEnvelope<BudgetPeriodDto>
  return adaptBudgetPeriod(data)
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
      // Default 'spend' so existing target editing is unaffected (ADR-138).
      kind: body.kind ?? 'spend',
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

/**
 * GET the per-month net-income base + household floor (ADR-139). Adapts the
 * payload; throws {@link BudgetApiError} on a non-2xx.
 */
async function fetchBudgetIncome(month: string): Promise<BudgetIncome> {
  const response = await authedFetch(
    apiUrl(`/budget-income?month=${encodeURIComponent(month)}`),
    { headers: { Accept: 'application/json' } },
  )
  await ensureOk(response)
  const { data } = (await response.json()) as ResponseEnvelope<BudgetIncomeDto>
  return adaptBudgetIncome(data)
}

/**
 * PUT the net-income base + optional manual floor for a month (upsert, ADR-139).
 * Currency defaults to ARS. Resolves on success; throws on a non-2xx.
 */
async function setBudgetIncome(body: BudgetIncomeWriteBody): Promise<void> {
  const response = await authedFetch(apiUrl('/budget-income'), {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      month: body.month,
      amount: body.amount,
      currency: body.currency ?? 'ARS',
      // Only send floor fields when the user supplied a manual override; an
      // omitted floor lets the backend keep the computed-from-essentials value.
      ...(body.floorAmount != null ? { floorAmount: body.floorAmount } : {}),
      ...(body.floorSource != null ? { floorSource: body.floorSource } : {}),
    }),
  })
  await ensureOk(response)
}

/**
 * GET the suggested variable-income base for a month (ADR-139). Returns the
 * Decimal-string suggestion, or `null` when there is <12 months of history.
 */
async function fetchSuggestedBase(month: string): Promise<string | null> {
  const response = await authedFetch(
    apiUrl(`/budget-income/suggested?month=${encodeURIComponent(month)}`),
    { headers: { Accept: 'application/json' } },
  )
  await ensureOk(response)
  const { data } = (await response.json()) as ResponseEnvelope<{
    suggestedBase: string | null
  }>
  return data.suggestedBase
}

/**
 * POST a saving profile for a month (ADR-138). Writes the saving rows server-side
 * and returns the refreshed month surface plus the floor-guard result
 * (`floorBreached` + `gap`). Throws {@link BudgetApiError} on a non-2xx.
 */
async function applyProfile(
  month: string,
  profile: SavingProfile,
): Promise<ApplyProfileResult> {
  const response = await authedFetch(apiUrl('/budgets/apply-profile'), {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ month, profile }),
  })
  await ensureOk(response)
  const { data } = (await response.json()) as ResponseEnvelope<
    BudgetPeriodDto & {
      floorBreached?: boolean
      gap?: string | null
    }
  >
  return {
    period: adaptBudgetPeriod(data),
    floorBreached: data.floorBreached === true,
    gap: data.gap ?? null,
  }
}

/** Per-category inflation step-up amounts (rent/ICL, tariffs) as Decimal strings. */
export type RepriceStepUps = Record<string, string>

/** Request payload for `POST /budgets/reprice` (ADR-137). */
export interface RepriceBody {
  /** Month to reprice FROM (the month that has spend rows), `YYYY-MM`. */
  fromMonth: string
  /** Month to reprice INTO (the new, empty month), `YYYY-MM`. */
  toMonth: string
  /** Monthly inflation as a percentage (e.g. `2` for 2%). */
  monthlyInflation: number
  /** Optional per-category step-up amounts (Decimal strings). */
  stepUps?: RepriceStepUps
}

/**
 * POST a reprice from one month to another (ADR-137): reprices only `kind='spend'`
 * rows by `cap × (1 + inflation/100) + stepUp`. Never auto-applies — the page
 * confirms first. Returns the repriced target month; throws on a non-2xx.
 */
async function reprice(body: RepriceBody): Promise<BudgetPeriod> {
  const response = await authedFetch(apiUrl('/budgets/reprice'), {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      fromMonth: body.fromMonth,
      toMonth: body.toMonth,
      monthlyInflation: body.monthlyInflation,
      ...(body.stepUps && Object.keys(body.stepUps).length > 0
        ? { stepUps: body.stepUps }
        : {}),
    }),
  })
  await ensureOk(response)
  const { data } = (await response.json()) as ResponseEnvelope<BudgetPeriodDto>
  return adaptBudgetPeriod(data)
}

/** The budgets API client, grouped for ergonomic import. */
export const budgetsClient = {
  fetchBudgets,
  setTarget,
  clearTarget,
  fetchBudgetIncome,
  setBudgetIncome,
  fetchSuggestedBase,
  applyProfile,
  reprice,
} as const
