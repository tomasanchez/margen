/**
 * Pure cuota-schedule math for receivable installments (ADR-214/215/216).
 *
 * React-free so the even split, the monthly due dates, the per-cuota override
 * diffing and the plan-lock rule are unit-testable and shared by the item form's
 * live preview and the person's cuota list.
 *
 * The split MIRRORS the backend exactly (`split_evenly` / `monthly_due_date`):
 * the total is taken to cents, every cuota but the last is `total / count`
 * rounded DOWN to cents, and the last absorbs the remainder — so the preview the
 * owner sees is the schedule the server will store (e.g. 1000 / 3 →
 * 333,33 · 333,33 · 333,34). Due dates fall monthly from the first one, keeping
 * its day of the month clamped to each month's end (a plan starting on the 31st
 * falls due on the 28th/29th in February and back on the 31st in March).
 *
 * Money is handled in integer CENTS here to avoid float drift; the API boundary
 * stays a Decimal string (ADR-025/034) via {@link centsToDecimal}.
 */

import type {
  ReceivableInstallment,
  ReceivableItem,
  ScheduleLockReason,
} from '../../api/receivablesClient'

/** The fewest cuotas a plan may have (ADR-216). */
export const MIN_INSTALLMENTS = 2
/** The most cuotas a plan may have (the API's `MAX_INSTALLMENTS`). */
export const MAX_INSTALLMENTS = 120

/** The earliest date the receivables API accepts (else 422). */
export const EARLIEST_DATE = '2000-01-01'
/** The latest date the receivables API accepts (else 422). */
export const LATEST_DATE = '2100-12-31'

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Zero-pad a positive integer to `width` digits. */
function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/** Days in a 1-based month of a year (handles leap years). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * Today as an ISO `YYYY-MM-DD` in LOCAL time. Local parts avoid the UTC
 * off-by-one `toISOString()` causes late in the evening in Argentina (UTC−3).
 */
export function todayIso(now: Date = new Date()): string {
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Parse a strict, real calendar `YYYY-MM-DD` date, or null. */
export function parseIsoDate(
  iso: string,
): { year: number; month: number; day: number } | null {
  const match = ISO_DATE.exec(iso.trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null
  }
  return { year, month, day }
}

/** True for a strict, real calendar `YYYY-MM-DD` date. */
export function isIsoDate(iso: string): boolean {
  return parseIsoDate(iso) !== null
}

/**
 * True for a real calendar date the receivables API accepts:
 * {@link EARLIEST_DATE}..{@link LATEST_DATE} (item dates, due dates, payment
 * dates — anything else is a 422).
 */
export function isReceivableDate(iso: string): boolean {
  const value = iso.trim()
  return isIsoDate(value) && value >= EARLIEST_DATE && value <= LATEST_DATE
}

/**
 * The date `months` months after `iso`, keeping the day of the month clamped to
 * the target month's last day — the backend's `monthly_due_date` (ADR-216). Each
 * date derives from the ORIGINAL day, so clamping never accumulates. Null for an
 * invalid input date.
 */
export function addMonthsClamped(iso: string, months: number): string | null {
  const parsed = parseIsoDate(iso)
  if (!parsed) return null
  const monthIndex = parsed.month - 1 + months
  const year = parsed.year + Math.floor(monthIndex / 12)
  const month = (((monthIndex % 12) + 12) % 12) + 1
  const day = Math.min(parsed.day, daysInMonth(year, month))
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`
}

/**
 * A finite number → integer cents via its 2-decimal string (the SAME string the
 * forms send with `toDecimalString`), so the preview math matches the payload
 * byte-for-byte. Null for a non-finite input.
 */
export function toCents(value: number): number | null {
  if (!Number.isFinite(value)) return null
  const [whole, fraction = '0'] = Math.abs(value).toFixed(2).split('.')
  const cents = Number(whole) * 100 + Number(fraction)
  return value < 0 ? -cents : cents
}

/** An API Decimal string (e.g. `"10000.00"`) → integer cents (0 when unparsable). */
export function decimalToCents(decimal: string): number {
  return toCents(Number.parseFloat(decimal)) ?? 0
}

/** Integer cents → the fixed 2-decimal Decimal string the API expects. */
export function centsToDecimal(cents: number): string {
  const abs = Math.abs(Math.trunc(cents))
  const body = `${Math.floor(abs / 100)}.${pad(abs % 100)}`
  return cents < 0 ? `-${body}` : body
}

/** Integer cents → a plain number for the display edge (formatCurrency). */
export function centsToNumber(cents: number): number {
  return cents / 100
}

/**
 * A Decimal string → the short text seeded into an amount input: trailing
 * zero cents are dropped (`"10000.00"` → `"10000"`, `"333.30"` → `"333.3"`).
 */
export function toInputAmount(decimal: string): string {
  const cents = decimalToCents(decimal)
  const text = centsToDecimal(cents)
  return text.replace(/\.?0+$/, '')
}

/**
 * Split `totalCents` into `count` cents shares, the rounding remainder on the
 * LAST — the backend's `split_evenly` (ADR-216): every share but the last is
 * `total / count` rounded down, the last takes what remains.
 */
export function splitEvenlyCents(totalCents: number, count: number): number[] {
  const share = Math.floor(totalCents / count)
  return Array.from({ length: count }, (_, offset) =>
    offset === count - 1 ? totalCents - share * (count - 1) : share,
  )
}

/** One cuota of a planned (or persisted) schedule, money in cents. */
export interface PlannedCuota {
  /** 1-based position in the plan. */
  index: number
  /** The due date (`YYYY-MM-DD`). */
  dueOn: string
  amountCents: number
}

/** True when `count` is a whole number of cuotas the API accepts (2..120). */
export function isValidCount(count: number): boolean {
  return (
    Number.isInteger(count) &&
    count >= MIN_INSTALLMENTS &&
    count <= MAX_INSTALLMENTS
  )
}

/**
 * The even-split schedule the server will generate for a plan, or null when the
 * plan is not one the API accepts: a count outside 2..120, an invalid first due
 * date, or a total too small to give every cuota at least one cent (ADR-216).
 */
export function planSchedule(
  totalCents: number,
  count: number,
  firstDueOn: string,
): PlannedCuota[] | null {
  if (!isValidCount(count) || !isReceivableDate(firstDueOn)) return null
  if (!Number.isInteger(totalCents) || totalCents < count) return null
  return splitEvenlyCents(totalCents, count).map((amountCents, offset) => ({
    index: offset + 1,
    dueOn: addMonthsClamped(firstDueOn, offset) ?? firstDueOn,
    amountCents,
  }))
}

/** A persisted cuota list as {@link PlannedCuota}s (ordered by index). */
export function scheduleFromInstallments(
  installments: readonly ReceivableInstallment[],
): PlannedCuota[] {
  return [...installments]
    .sort((a, b) => a.index - b.index)
    .map((cuota) => ({
      index: cuota.index,
      dueOn: cuota.dueOn,
      amountCents: decimalToCents(cuota.amount),
    }))
}

/** A user's per-cuota tweak on top of a base schedule (ADR-216). */
export interface CuotaOverride {
  amountCents?: number
  dueOn?: string
}

/** A schedule row after overrides, flagged when the user changed it. */
export interface ScheduleRowModel extends PlannedCuota {
  edited: boolean
}

/** Overlay the user's per-cuota overrides (keyed by index) onto a base schedule. */
export function applyOverrides(
  base: readonly PlannedCuota[],
  overrides: Readonly<Record<number, CuotaOverride>>,
): ScheduleRowModel[] {
  return base.map((cuota) => {
    const override = overrides[cuota.index]
    const amountCents = override?.amountCents ?? cuota.amountCents
    const dueOn = override?.dueOn ?? cuota.dueOn
    return {
      index: cuota.index,
      dueOn,
      amountCents,
      edited: amountCents !== cuota.amountCents || dueOn !== cuota.dueOn,
    }
  })
}

/** One cuota PATCH to send after the item is saved (only the changed fields). */
export interface CuotaEdit {
  index: number
  /** New amount, a Decimal string. */
  amount?: string
  /** New due date (`YYYY-MM-DD`). */
  dueOn?: string
}

/**
 * The cuota PATCHes that turn `base` into what the user sees: one per overridden
 * cuota, carrying only the fields that actually differ (ADR-216). Overrides for
 * indexes past the plan's end are ignored.
 */
export function cuotaEditsFor(
  base: readonly PlannedCuota[],
  overrides: Readonly<Record<number, CuotaOverride>>,
): CuotaEdit[] {
  const edits: CuotaEdit[] = []
  for (const cuota of base) {
    const override = overrides[cuota.index]
    if (!override) continue
    const edit: CuotaEdit = { index: cuota.index }
    if (
      override.amountCents !== undefined &&
      override.amountCents !== cuota.amountCents
    ) {
      edit.amount = centsToDecimal(override.amountCents)
    }
    if (override.dueOn !== undefined && override.dueOn !== cuota.dueOn) {
      edit.dueOn = override.dueOn
    }
    if (edit.amount !== undefined || edit.dueOn !== undefined) edits.push(edit)
  }
  return edits
}

/** Σ of a schedule's amounts, in cents. */
export function scheduleTotalCents(rows: readonly PlannedCuota[]): number {
  return rows.reduce((sum, row) => sum + row.amountCents, 0)
}

/**
 * Why an item's plan SHAPE can't change right now (ADR-216), or null when it
 * can: any payment allocated to it, or a pardon on the item or any cuota.
 * Per-cuota amount/date edits stay allowed either way. Mirrors the backend's
 * `_ensure_schedule_can_change` so the form can disable the locked fields up
 * front (the API still answers 409 if the data went stale).
 */
export function scheduleLockReason(
  item: ReceivableItem,
): ScheduleLockReason | null {
  if (decimalToCents(item.allocated) > 0) return 'allocations'
  if (item.pardoned || item.installments.some((cuota) => cuota.pardoned)) {
    return 'pardons'
  }
  return null
}

/**
 * How many of a plan's cuotas are DUE — fallen due and still owed — for the
 * "1/6 cuotas due" summary ("cuotas vencidas"). Derived from the server's own
 * as-of status only (ADR-215): never from the browser's clock, which can sit on
 * the other side of midnight from the server's "today".
 */
export function dueCuotaCount(
  installments: readonly ReceivableInstallment[],
): number {
  return installments.filter((cuota) => cuota.status === 'due').length
}
