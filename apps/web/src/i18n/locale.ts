/**
 * Locale resolution for `Intl` formatting (ADR-102).
 *
 * Bridges the i18n UI language to a BCP-47 locale that `Intl.DateTimeFormat` /
 * `Intl.NumberFormat` understand. Month/date names and other locale-reactive
 * formatting key off the ACTIVE UI language via {@link activeIntlLocale}, which
 * reads the i18next singleton at call time so plain (non-hook) formatters stay
 * reactive across a language switch without changing their signatures.
 *
 * NOTE: ARS/USD numeric grouping is intentionally NOT driven by this — it is a
 * domain constant (`es-AR`) in both languages (see `src/lib/format.ts`).
 */

import i18n from 'i18next'
import { FALLBACK_LANGUAGE, type Language } from './resources'

/** BCP-47 locale used for `Intl` formatting per supported UI language. */
const INTL_LOCALE: Record<Language, string> = {
  en: 'en-US',
  es: 'es-AR',
}

/**
 * Map an explicit supported language to its `Intl` locale, e.g. `'es'` →
 * `'es-AR'`. Pure and side-effect free, so it is trivial to unit test.
 */
export function localeForLanguage(language: Language): string {
  return INTL_LOCALE[language]
}

/**
 * The `Intl` locale for the CURRENTLY active UI language, read from the i18next
 * singleton at call time. Region codes collapse to their base (`'es-AR'` →
 * `'es'`) and unknown languages fall back to the default locale. Call this from
 * inside date/month formatters so they react to a language switch.
 */
export function activeIntlLocale(): string {
  const resolved = i18n.resolvedLanguage ?? i18n.language ?? FALLBACK_LANGUAGE
  const base = resolved.split('-')[0]
  return base in INTL_LOCALE
    ? INTL_LOCALE[base as Language]
    : INTL_LOCALE[FALLBACK_LANGUAGE]
}

/**
 * Capitalize the first letter of a locale-formatted month name (ADR-102), e.g.
 * `Intl` yields "julio" / "jun" in `es-AR` but the UI wants "Julio" / "Jun". The
 * uppercasing is locale-aware via `toLocaleUpperCase` so locale-specific casing
 * rules apply. Idempotent on already-capitalized names, so English month names
 * ("June", "Jun") pass through byte-for-byte unchanged. Pass the same `locale`
 * used to format the month so casing matches the script.
 */
export function capitalizeMonth(month: string, locale: string): string {
  if (month.length === 0) return month
  return month.charAt(0).toLocaleUpperCase(locale) + month.slice(1)
}

/** Options for {@link localizedMonth}. */
export interface LocalizedMonthOptions {
  /** `'long'` → "June"/"Junio"; `'short'` → "Jun". Defaults to `'long'`. */
  style?: 'long' | 'short'
  /**
   * Format the month/year fields in UTC. Pass `true` for `Date`s built from an
   * ISO calendar date (e.g. `Date.UTC(y, m, 1)`) so the runtime timezone never
   * shifts the rendered month. Defaults to `false` (local time).
   */
  utc?: boolean
}

/**
 * The single locale-aware month-name formatter (ADR-102): reads the ACTIVE UI
 * locale at call time, formats `date`'s month via `Intl.DateTimeFormat`, and
 * capitalizes it (so the Spanish "junio"/"jun" reads "Junio"/"Jun"). English
 * output is byte-identical to the prior hardcoded tables ("June"/"Jun"). This
 * is the one place month names are produced — `months.ts` and the monotributo
 * derivations both call it instead of inlining `Intl` + `capitalizeMonth`.
 */
export function localizedMonth(
  date: Date,
  options: LocalizedMonthOptions = {},
): string {
  const { style = 'long', utc = false } = options
  const locale = activeIntlLocale()
  const month = new Intl.DateTimeFormat(locale, {
    month: style,
    ...(utc ? { timeZone: 'UTC' } : {}),
  }).format(date)
  return capitalizeMonth(month, locale)
}

/**
 * Format an ISO `YYYY-MM-DD` calendar date to a readable, locale-aware date in
 * the ACTIVE UI language (ADR-102), e.g. `"2026-07-09"` → "Jul 9, 2026" (en) /
 * "9 jul 2026" (es). Reads the active `Intl` locale at call time so it reacts to
 * a language switch. The ISO string is anchored to local midnight so the day
 * field never rolls over; a malformed input passes through verbatim so the
 * helper is a safe no-op on non-conforming values. This is the shared home for
 * formatting a bare ISO date (previously inlined per call site).
 */
export function localizedIsoDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat(activeIntlLocale(), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

/**
 * English short month tokens by 0-based index, the canonical form the backend
 * adapters bake into pre-formatted labels (e.g. `TrendPoint.month` = "Jun",
 * `Transaction.dispDate` = "Jun 12"). Used to recover the month index so a
 * baked English token can be re-localized for display (ADR-102).
 */
const EN_SHORT_MONTHS = [
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
 * Re-localize a baked English short-month token (e.g. "Jun") to the active UI
 * language (ADR-102): "Jun" → "Jun" (en) / "Jun" (es). Unknown tokens pass
 * through unchanged so a non-month string is never mangled. English output is
 * byte-identical because the token already IS the English short month.
 */
export function localizeShortMonthToken(token: string): string {
  const index = EN_SHORT_MONTHS.indexOf(token as (typeof EN_SHORT_MONTHS)[number])
  if (index < 0) return token
  // Day 1, local time — only the month field is read.
  return localizedMonth(new Date(2000, index, 1), { style: 'short' })
}

/**
 * Re-localize a baked English "Mon DD" display date (e.g. "Jun 12") to the
 * active UI language while keeping the day (ADR-102): "Jun 12" → "Jun 12" (en) /
 * "Jun 12" (es). Anything that is not a recognized "Mon DD" token (e.g. a raw
 * ISO fragment, an em-dash placeholder, or empty) passes through unchanged, so
 * the helper is a safe no-op on non-conforming inputs. English output stays
 * byte-identical.
 */
export function localizeDispDate(disp: string): string {
  const trimmed = disp.trim()
  const match = /^([A-Za-z]{3})\s+(\d{1,2})$/.exec(trimmed)
  if (!match) return disp
  const [, token, day] = match
  const localizedToken = localizeShortMonthToken(token)
  if (localizedToken === token && !EN_SHORT_MONTHS.includes(token as never)) {
    return disp
  }
  return `${localizedToken} ${day}`
}
