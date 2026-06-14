/**
 * Real Monotributo API client + DTO adapter (ADR-046, ADR-049, ADR-052).
 *
 * This is the single boundary between the backend's `/monotributo` REST contract
 * (`GET /api/v1/monotributo`, a `{ data }` envelope, camelCase field names,
 * Decimal-string money, four-band status, ISO dates) and the frontend's existing
 * Monotributo card shapes. The category WRITE path moved to `PATCH /settings`
 * (ADR-054/057), so this client is read-only now. The MeterHero,
 * CategoryLadder, ProjectionBreakdown, InvoiceDrilldown and ScaleTable keep
 * speaking the prototype shape unchanged; every contract difference (envelope
 * unwrap, Decimal-string → number, `percentUsed` → `ratio`, `limit` →
 * `annualLimit`, the invoice field renames, the prior-period comparison deltas)
 * is resolved here.
 *
 * Mirrors {@link summariesClient} / {@link transactionsClient} (ADR-033/043):
 * `apiUrl()` for the versioned URL, `ensureOk` throwing a status-carrying error
 * on non-2xx so TanStack Query treats it as a failure and the page can show the
 * calm error state (ADR-037).
 */

import { apiUrl } from '../config'
import type {
  MonotributoComparison,
  MonotributoInvoice,
  MonotributoScaleRow,
  MonotributoSnapshot,
  MonotributoStanding,
  StatusLevel,
} from '../mock/types'

/** The backend `{ data: T }` response envelope (ADR-030). */
interface ResponseEnvelope<T> {
  data: T
}

/** Backend status band keys (ADR-046). */
type StatusDto = 'safe' | 'watch' | 'close' | 'over'

/** One trailing-12-month standing as serialized by the backend (Decimal strings). */
export interface MonotributoStandingDto {
  category: string
  activityType: string
  /** Annual ceiling for the category, as a Decimal string. */
  limit: string
  /** ARS invoiced over the window, as a Decimal string. */
  used: string
  /** Remaining ARS before the ceiling, as a Decimal string. */
  remaining: string
  /** Percentage of the ceiling used (0–100+), as a Decimal string. */
  percentUsed: string
  status: StatusDto
  projectedCategory: string
  projectionNote: string
  /** ISO date (`YYYY-MM-DD`). */
  periodStart: string
  /** ISO date (`YYYY-MM-DD`). */
  periodEnd: string
}

/** One A–K scale row as serialized by the backend (Decimal strings). */
export interface MonotributoScaleRowDto {
  letter: string
  annualCeiling: string
  cuotaServicios: string
  cuotaBienes: string
}

/** One included invoice as serialized by the backend (Decimal strings). */
export interface MonotributoInvoiceDto {
  id: string
  /** ISO date the invoice occurred on (`YYYY-MM-DD`). */
  occurredOn: string
  name: string
  category: string | null
  /** ARS-equivalent amount counted toward the limit, as a Decimal string. */
  amount: string
  currency: string
  /** Running cumulative ARS total through this invoice, as a Decimal string. */
  cumulative: string
  /** Whether this was a foreign-currency (USD) invoice. */
  isForeignCurrency: boolean
}

/** The `data` payload of `GET /monotributo`. */
export interface MonotributoSnapshotDto {
  current: MonotributoStandingDto
  /** Prior trailing-12-month window; null when no prior period exists yet. */
  previous: MonotributoStandingDto | null
  scale: MonotributoScaleRowDto[]
  invoices: MonotributoInvoiceDto[]
}

/** An API error that carries the HTTP status so callers can branch on it. */
export class MonotributoApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'MonotributoApiError'
    this.status = status
  }
}

/** Throw a {@link MonotributoApiError} for any non-2xx response. */
async function ensureOk(response: Response): Promise<void> {
  if (response.ok) return
  let detail = ''
  try {
    detail = await response.text()
  } catch {
    // Ignore body-read failures; the status is enough for the calm error state.
  }
  throw new MonotributoApiError(
    response.status,
    `Monotributo API request failed with ${response.status}${
      detail ? `: ${detail}` : ''
    }`,
  )
}

/** Parse a Decimal string (e.g. "1700000.00") to a number; non-finite → 0. */
function parseDecimal(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Narrow the backend status band to the frontend {@link StatusLevel} union. */
function asStatus(value: StatusDto): StatusLevel {
  return value
}

/** Adapt one backend standing to the frontend {@link MonotributoStanding}. */
export function adaptStanding(dto: MonotributoStandingDto): MonotributoStanding {
  const percentUsed = parseDecimal(dto.percentUsed)
  return {
    category: dto.category,
    activityType: dto.activityType,
    annualLimit: parseDecimal(dto.limit),
    used: parseDecimal(dto.used),
    remaining: parseDecimal(dto.remaining),
    percentUsed,
    ratio: percentUsed / 100,
    status: asStatus(dto.status),
    projectedCategory: dto.projectedCategory,
    projectionNote: dto.projectionNote,
    periodStart: dto.periodStart,
    periodEnd: dto.periodEnd,
  }
}

/** Adapt one backend scale row to the frontend {@link MonotributoScaleRow}. */
export function adaptScaleRow(dto: MonotributoScaleRowDto): MonotributoScaleRow {
  return {
    letter: dto.letter,
    annualCeiling: parseDecimal(dto.annualCeiling),
    cuotaServicios: parseDecimal(dto.cuotaServicios),
    cuotaBienes: parseDecimal(dto.cuotaBienes),
  }
}

/**
 * Adapt one backend invoice to the frontend {@link MonotributoInvoice}. The
 * card shape predates the contract, so the field renames live here:
 * `occurredOn` → `dispDate` (a short display label), `name` → `client`,
 * `category` → `note`, `isForeignCurrency` → `fx`. The numeric `index` becomes
 * the list `id` (the contract id is a UUID string the card never displays).
 */
export function adaptInvoice(
  dto: MonotributoInvoiceDto,
  index: number,
): MonotributoInvoice {
  return {
    id: index + 1,
    dispDate: displayDate(dto.occurredOn),
    client: dto.name,
    note: dto.category ?? '',
    amountNum: parseDecimal(dto.amount),
    cumulative: parseDecimal(dto.cumulative),
    fx: dto.isForeignCurrency,
  }
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

/** Turn an ISO `YYYY-MM-DD` date into a short "Mon DD" display label. */
function displayDate(iso: string): string {
  const month = Number.parseInt(iso.slice(5, 7), 10)
  const day = Number.parseInt(iso.slice(8, 10), 10)
  const label = SHORT_MONTHS[month - 1]
  if (!label || !Number.isFinite(day)) return iso
  return `${label} ${day}`
}

/** Adapt the full backend snapshot payload to the page-ready shape. */
export function adaptSnapshot(dto: MonotributoSnapshotDto): MonotributoSnapshot {
  return {
    current: adaptStanding(dto.current),
    previous: dto.previous ? adaptStanding(dto.previous) : null,
    scale: dto.scale.map(adaptScaleRow),
    invoices: dto.invoices.map(adaptInvoice),
  }
}

/**
 * Derive the period-over-period comparison from a snapshot (ADR-052). Returns
 * null when there is no prior trailing-12-month period, so the page renders the
 * calm "no prior period" empty state instead of fabricating zero deltas.
 */
export function deriveComparison(
  snapshot: MonotributoSnapshot,
): MonotributoComparison | null {
  const { current, previous } = snapshot
  if (!previous) return null
  return {
    used: {
      current: current.used,
      previous: previous.used,
      diff: current.used - previous.used,
    },
    percentUsed: {
      current: current.percentUsed,
      previous: previous.percentUsed,
      diff: current.percentUsed - previous.percentUsed,
    },
    category: {
      current: current.category,
      previous: previous.category,
      changed: current.category !== previous.category,
    },
    status: {
      current: current.status,
      previous: previous.status,
      changed: current.status !== previous.status,
    },
  }
}

/**
 * GET the Monotributo snapshot (trailing-12-month standing + prior window +
 * scale + included invoices), unwrap the `{ data }` envelope, and adapt it to
 * the page shapes. Throws {@link MonotributoApiError} on a non-2xx response.
 */
export async function fetchMonotributo(): Promise<MonotributoSnapshot> {
  const response = await fetch(apiUrl('/monotributo'), {
    headers: { Accept: 'application/json' },
  })
  await ensureOk(response)
  const envelope =
    (await response.json()) as ResponseEnvelope<MonotributoSnapshotDto>
  return adaptSnapshot(envelope.data)
}

/**
 * The Monotributo API client, grouped for ergonomic import. Read-only since the
 * category write path moved to `PATCH /settings` (ADR-054/057).
 */
export const monotributoClient = {
  fetchMonotributo,
} as const
