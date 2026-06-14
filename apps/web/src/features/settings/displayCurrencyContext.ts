/**
 * Display-currency context value, default, and consumer hooks (ADR-056).
 *
 * Kept in a non-component module so the provider component file
 * ({@link DisplayCurrencyProvider}) stays Fast-Refresh-friendly (it must only
 * export components). The provider computes a {@link DisplayCurrencyValue} (the
 * single place the ARS→USD display transform lives) and feeds it through this
 * context; consumers read it via {@link useDisplayCurrency} /
 * {@link useDisplayMoney}.
 */

import { createContext, useContext } from 'react'
import { formatCurrency } from '../../lib/format'
import type { DisplayCurrency } from '../../api/settingsClient'

/** The shape every consumer of the display currency reads. */
export interface DisplayCurrencyValue {
  /**
   * The currency the user *prefers* to see (from settings). May differ from the
   * currency actually applied when a USD rate is unavailable — use
   * {@link DisplayCurrencyValue.effectiveCurrency} for what is actually rendered.
   */
  preferredCurrency: DisplayCurrency
  /**
   * The currency actually applied to figures: `USD` only when USD is preferred
   * AND a live rate is available; otherwise `ARS`.
   */
  effectiveCurrency: DisplayCurrency
  /** The live ARS-per-USD rate in effect, or `null` when unavailable. */
  rate: number | null
  /** Whether the USD rate is still being fetched (USD preferred only). */
  rateLoading: boolean
  /**
   * A calm note to show once on a converting surface when USD is preferred but
   * the rate couldn't be fetched, so figures fall back to ARS (ADR-037). `null`
   * in every other case.
   */
  fallbackNote: string | null
  /**
   * Format an ARS-stored amount for display: divides by the live rate and
   * prefixes `USD` when the effective currency is USD, otherwise renders ARS.
   * Sign is by magnitude (callers add direction); this matches `formatCurrency`.
   */
  formatMoney: (ars: number | null | undefined) => string
}

/** ARS-only default — used outside the provider and before settings resolve. */
export const DEFAULT_DISPLAY_CURRENCY_VALUE: DisplayCurrencyValue = {
  preferredCurrency: 'ARS',
  effectiveCurrency: 'ARS',
  rate: null,
  rateLoading: false,
  fallbackNote: null,
  formatMoney: (ars) => formatCurrency(ars, 'ARS'),
}

export const DisplayCurrencyContext = createContext<DisplayCurrencyValue>(
  DEFAULT_DISPLAY_CURRENCY_VALUE,
)

/**
 * Read the display-currency value (effective currency, live rate, calm fallback
 * note, and a currency-aware {@link DisplayCurrencyValue.formatMoney}). Safe to
 * call outside the provider — it returns the ARS-only default.
 */
export function useDisplayCurrency(): DisplayCurrencyValue {
  return useContext(DisplayCurrencyContext)
}

/**
 * Convenience hook returning just the currency-aware money formatter. Use on
 * Home cards + summaries so an ARS-stored figure renders in the user's preferred
 * currency (USD when a rate is available, ARS otherwise).
 */
export function useDisplayMoney(): (
  ars: number | null | undefined,
) => string {
  return useDisplayCurrency().formatMoney
}
