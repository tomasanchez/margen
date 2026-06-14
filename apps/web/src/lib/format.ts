/**
 * Centralized money / number formatting for Margen (ADR-016).
 *
 * The single source of truth for how amounts read across the app: es-AR
 * grouping (1.234,56), currency prefixes, sign handling, and deltas. Call sites
 * (and the <Amount> component) use these helpers instead of inlining
 * Intl.NumberFormat, so styling and sign rules never drift.
 */

import type { Currency, FxRateType, TxType } from '../mock/types'

/** Unicode minus (U+2212) — visually balanced with `+` and the digits. */
export const MINUS = '−'
export const PLUS = '+'

/**
 * es-AR integer formatter: 1234567 -> "1.234.567". Used for whole-peso amounts,
 * which is how the concept renders ARS (no cents on the dashboard).
 */
const arsInteger = new Intl.NumberFormat('es-AR', {
  maximumFractionDigits: 0,
})

/** es-AR formatter allowing up to 2 decimals, for fractional values when needed. */
const arsDecimal = new Intl.NumberFormat('es-AR', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
})

/** USD formatter: up to 2 decimals, es-AR grouping for visual consistency. */
const usdDecimal = new Intl.NumberFormat('es-AR', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
})

/** Coerce nullish / NaN / non-finite inputs to 0 so rendering never breaks. */
function safe(n: number | null | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

/**
 * Format an ARS amount as a grouped string WITHOUT a currency prefix or sign.
 * Negative inputs are formatted by magnitude; callers add the sign via the
 * signed helpers. e.g. 1234567 -> "1.234.567".
 */
export function formatARS(n: number | null | undefined): string {
  const value = Math.abs(safe(n))
  return Number.isInteger(value)
    ? arsInteger.format(value)
    : arsDecimal.format(value)
}

/**
 * Format a USD amount as a grouped string without a currency prefix or sign.
 * Keeps up to 2 decimals (e.g. 2.99 -> "2,99", 500 -> "500").
 */
export function formatUSD(n: number | null | undefined): string {
  return usdDecimal.format(Math.abs(safe(n)))
}

/** Currency prefix used in amount strings, e.g. "ARS 1.234". */
function currencyPrefix(currency: Currency): string {
  return `${currency} `
}

/**
 * Format a magnitude with its currency prefix but no sign, e.g.
 * formatCurrency(1234, 'ARS') -> "ARS 1.234".
 */
export function formatCurrency(
  n: number | null | undefined,
  currency: Currency,
): string {
  const body = currency === 'USD' ? formatUSD(n) : formatARS(n)
  return `${currencyPrefix(currency)}${body}`
}

/**
 * Sign-aware currency string driven by transaction direction:
 * income -> "+ARS 1.234", expense -> "−ARS 1.234". The amount is rendered by
 * magnitude; the sign comes from `type`. Display amounts are shown in ARS by
 * default (the dashboard's base currency), matching the concept.
 */
export function formatSignedAmount(
  n: number | null | undefined,
  type: TxType,
  currency: Currency = 'ARS',
): string {
  const sign = type === 'income' ? PLUS : MINUS
  return `${sign}${formatCurrency(n, currency)}`
}

/**
 * Build the accessible label for an amount, spelling out sign + currency so
 * screen readers announce e.g. "plus 1.234 Argentine pesos" / "minus 38.400
 * Argentine pesos" (ADR-019). Avoids relying on the visual +/− glyphs alone.
 */
export function amountAccessibleLabel(
  n: number | null | undefined,
  type: TxType,
  currency: Currency = 'ARS',
): string {
  const signWord = type === 'income' ? 'plus' : 'minus'
  const currencyWord =
    currency === 'USD' ? 'US dollars' : 'Argentine pesos'
  const body = currency === 'USD' ? formatUSD(n) : formatARS(n)
  return `${signWord} ${body} ${currencyWord}`
}

/**
 * Format a signed percentage delta, e.g. 12 -> "+12%", -3 -> "−3%", 0 -> "0%".
 * `digits` controls decimal places (default 0). Used for month-over-month
 * deltas on metric cards and category rows.
 */
export function formatDelta(
  pct: number | null | undefined,
  digits = 0,
): string {
  const value = safe(pct)
  const rounded = Number(value.toFixed(digits))
  if (rounded === 0) return `0%`
  const sign = rounded > 0 ? PLUS : MINUS
  return `${sign}${Math.abs(rounded).toFixed(digits)}%`
}

/**
 * Format a ratio in [0, 1] as a whole-number percentage, e.g. 0.6 -> "60%".
 * Clamps out-of-range inputs so a meter never shows negative or >100%.
 */
export function formatPercent(
  ratio: number | null | undefined,
  digits = 0,
): string {
  const clamped = Math.min(Math.max(safe(ratio), 0), 1)
  return `${(clamped * 100).toFixed(digits)}%`
}

/**
 * Human label for an FX rate source (ADR-044/045). `MEP` reads as "MEP";
 * everything else reads as "manual" — the UI only distinguishes the confirmed
 * suggestion from a user-entered value (`official`/`configured_default` are
 * future backend stubs and fall through to "manual" until they ship).
 */
export function fxSourceLabel(
  source: FxRateType | null | undefined,
): string {
  return source === 'MEP' ? 'MEP' : 'manual'
}

/**
 * FX subline for USD transactions, e.g. "USD 500 · MEP 1.245" for a confirmed
 * MEP suggestion or "USD 500 · manual 1.300" for a user-entered rate. The source
 * defaults to MEP when not supplied (legacy rows). Returns an empty string when
 * either money value is missing so callers can render it conditionally.
 */
export function formatFxSubline(
  usd: number | null | undefined,
  rate: number | null | undefined,
  source?: FxRateType | null,
): string {
  if (usd == null || rate == null) return ''
  return `USD ${formatUSD(usd)} · ${fxSourceLabel(source ?? 'MEP')} ${formatARS(
    rate,
  )}`
}

/** es-AR 1-decimal formatter for the compact millions label (10277988 -> "10,3"). */
const millionsCompact = new Intl.NumberFormat('es-AR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

/**
 * Compact "millions" label used in the category ladder / cap chips, e.g.
 * 21113697 -> "21,1M", 108357084 -> "108,4M". es-AR decimal comma; no currency
 * prefix (callers add "ARS" / "cap" context).
 */
export function formatMillionsCompact(n: number | null | undefined): string {
  return `${millionsCompact.format(safe(n) / 1_000_000)}M`
}

/**
 * Display helper for the seeded short date. The mock stores dates as already
 * human-friendly strings (e.g. "Jun 12"); this pass-through trims and provides a
 * stable em-dash placeholder for empty values, keeping call sites uniform.
 */
export function formatDispDate(dispDate: string | null | undefined): string {
  const trimmed = dispDate?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : '—'
}
