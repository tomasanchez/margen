/**
 * Centralized money / number formatting for Margen (ADR-016, ADR-102).
 *
 * The single source of truth for how amounts read across the app: es-AR
 * grouping (1.234,56), currency prefixes, sign handling, and deltas. Call sites
 * (and the <Amount> component) use these helpers instead of inlining
 * Intl.NumberFormat, so styling and sign rules never drift.
 *
 * ADR-102 clarification: ARS/USD numeric GROUPING is a domain constant
 * ({@link MONEY_LOCALE} = `es-AR`) in BOTH languages — Argentine peso/USD
 * figures read as `622.500` / `21,1M` regardless of UI language. Only the
 * human-readable label WORDS (currency names, FX source, sign words) and the
 * date helper localize off the active UI language.
 */

import i18n from 'i18next'
import type { Currency, FxRateType, TxType } from '../mock/types'

/** Unicode minus (U+2212) — visually balanced with `+` and the digits. */
export const MINUS = '−'
export const PLUS = '+'

/**
 * Locale for ARS/USD numeric grouping — a DOMAIN constant, not the UI language
 * (ADR-102). Argentine money figures use Argentine grouping in both English and
 * Spanish, so this never tracks the active locale.
 */
const MONEY_LOCALE = 'es-AR'

/**
 * Integer money formatter: 1234567 -> "1.234.567". Used for whole-peso amounts,
 * which is how the concept renders ARS (no cents on the dashboard).
 */
const arsInteger = new Intl.NumberFormat(MONEY_LOCALE, {
  maximumFractionDigits: 0,
})

/**
 * Money formatter allowing up to 2 decimals (es-AR grouping). Shared by both ARS
 * fractional amounts and USD — they were byte-identical formatters (same locale,
 * 0–2 fraction digits), so there is a single source of truth here.
 */
const decimal = new Intl.NumberFormat(MONEY_LOCALE, {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
})

/** Coerce nullish / NaN / non-finite inputs to 0 so rendering never breaks. */
function safe(n: number | null | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

/**
 * The privacy mask string shown in place of a headline figure when the Home
 * "hide amounts" toggle is on (ADR-157). A short run of bullets that preserves
 * the row's layout without hinting at magnitude; the value is still fetched, so
 * this masks display only. A single source of truth so the mask reads
 * identically across every card and stays testable.
 */
export function maskAmount(): string {
  return '••••••'
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
    : decimal.format(value)
}

/**
 * Format a USD amount as a grouped string without a currency prefix or sign.
 * Keeps up to 2 decimals (e.g. 2.99 -> "2,99", 500 -> "500").
 */
export function formatUSD(n: number | null | undefined): string {
  return decimal.format(Math.abs(safe(n)))
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
 * screen readers announce e.g. "plus 1.234 Argentine pesos" / "más 1.234 pesos
 * argentinos" (ADR-019, ADR-102). The sign + currency WORDS localize off the
 * active UI language; the numeric body keeps es-AR grouping (domain constant).
 */
export function amountAccessibleLabel(
  n: number | null | undefined,
  type: TxType,
  currency: Currency = 'ARS',
): string {
  const signWord = i18n.t(
    type === 'income' ? 'common:sign.plus' : 'common:sign.minus',
  )
  const currencyWord = i18n.t(
    currency === 'USD' ? 'common:currency.usd' : 'common:currency.ars',
  )
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
 * Human label for an FX rate source (ADR-044/045, ADR-102). `MEP` reads as
 * "MEP", `official` reads as "official"/"oficial", and everything else
 * (`manual`, `configured_default`, or unknown) reads as "manual" — so a USD row
 * always declares which dollar it used. The word localizes off the active UI
 * language.
 */
export function fxSourceLabel(
  source: FxRateType | null | undefined,
): string {
  if (source === 'MEP') return i18n.t('common:fxSource.mep')
  if (source === 'official') return i18n.t('common:fxSource.official')
  return i18n.t('common:fxSource.manual')
}

/**
 * Human label for a per-transaction FX SNAPSHOT source (ADR-148): the provenance
 * vocabulary `'bolsa' | 'oficial' | 'manual' | 'backfill' | 'import'` (distinct
 * from the ADR-044 {@link FxRateType} family). Looks up `common:fxSource.<value>`
 * and falls back to "manual" for an unknown/absent value, so the ARS snapshot
 * field always declares which dollar it used. Localizes off the active language.
 */
export function fxSnapshotSourceLabel(source: string | null | undefined): string {
  if (!source) return i18n.t('common:fxSource.manual')
  return i18n.t(`common:fxSource.${source}`, {
    defaultValue: i18n.t('common:fxSource.manual'),
  })
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
const millionsCompact = new Intl.NumberFormat(MONEY_LOCALE, {
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
 * Compact magnitude formatter for CHART AXIS TICKS (ADR-166). A full
 * {@link formatCurrency} tick ("USD 1.854,3") is too wide for a Y-axis and wraps
 * or clips; this abbreviates the magnitude with `Intl.NumberFormat`
 * `notation: 'compact'` in the es-AR domain locale (ADR-102) — e.g.
 * `1_854_300 -> "$1,9 M"`, `2_000 -> "$2 mil"`, `9_500_000_000 ->
 * "$9500 M"`. The `$` prefix keeps the axis narrow (the tooltip + the
 * accessible summary still use the FULL {@link formatCurrency}, which names the
 * currency, so ARS vs USD is never ambiguous). Only for axis ticks.
 *
 * es-AR compact notation emits its own suffix WORDS ("mil", "M") with a NBSP
 * separator; we keep them rather than forcing English "k"/"M" so the axis reads
 * consistently with the rest of the app's es-AR figures in both UI languages.
 */
const compactMagnitude = new Intl.NumberFormat(MONEY_LOCALE, {
  notation: 'compact',
  maximumFractionDigits: 1,
})

/**
 * Compact axis-tick label for a money magnitude, prefixed with the display
 * currency's symbol: `formatCompactAxis(1854300, 'ARS')` yields a short
 * "$1,9 M"-style token. The magnitude is taken by absolute value (axes render
 * non-negative ticks). ARS uses the bare `$` (Argentine peso convention); USD
 * uses `US$` so a USD axis is never mistaken for pesos. The narrow prefix keeps
 * the axis compact while the tooltip + accessible summary keep the FULL
 * {@link formatCurrency}. A pure, unit-testable helper — never inline this in a
 * `tickFormatter`.
 */
export function formatCompactAxis(
  n: number | null | undefined,
  currency: Currency = 'ARS',
): string {
  const prefix = currency === 'USD' ? 'US$' : '$'
  return `${prefix}${compactMagnitude.format(Math.abs(safe(n)))}`
}

/**
 * Display helper for the seeded short date. The mock stores dates as already
 * human-friendly / literal strings (e.g. "Jun 12", or an ISO `occurredOn` shown
 * verbatim); this pass-through trims and provides a stable em-dash placeholder
 * for empty values, keeping call sites uniform. Date-name localization for the
 * month navigator lives in `months.ts` (ADR-102); this helper intentionally
 * stays a literal pass-through so the ledger's compact dates render exactly as
 * stored.
 */
export function formatDispDate(dispDate: string | null | undefined): string {
  const trimmed = dispDate?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : '—'
}
