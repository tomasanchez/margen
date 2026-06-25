/**
 * Display-currency provider — the ONE place the ARS→USD display transform lives
 * (ADR-056).
 *
 * All money in Margen is stored and aggregated in ARS (ADR-025); ARS is
 * authoritative. When the user sets `preferredDisplayCurrency = USD`, the Home
 * metric cards and the monthly summaries (trend + category breakdown) are shown
 * in US dollars by dividing each ARS figure by a SINGLE live rate fetched from
 * dolarapi.com at the configured `fxDefaultRateType` (MEP → suggested MEP,
 * official → suggested official; reusing the {@link fxClient} from ADR-044).
 *
 * This is a pure DISPLAY transform: the converted value is never written back,
 * never mutates stored or aggregated amounts. Keeping the conversion (and the
 * rate fetch) in this single provider bounds the blast radius — consumers call
 * {@link useDisplayMoney} and get a ready-to-render string plus the effective
 * currency, without touching the rate or fx logic themselves.
 *
 * Graceful fallback (ADR-037): if the rate can't be fetched (null / error)
 * while USD is preferred, consumers fall back to ARS display and the provider
 * exposes a calm `fallbackNote` so a surface can say so once. The settings still
 * loading, or ARS preferred, simply means ARS display with no note.
 *
 * The context, default value, and consumer hooks live in
 * {@link ./displayCurrencyContext} so this file only exports a component
 * (Fast-Refresh friendly).
 */

import { useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import {
  fetchSuggestedMepRate,
  fetchSuggestedOfficialRate,
} from '../../api/fxClient'
import { formatCurrency } from '../../lib/format'
import type {
  DisplayCurrency,
  FxDefaultRateType,
} from '../../api/settingsClient'
import { useSettings } from './queries'
import {
  DisplayCurrencyContext,
  type DisplayCurrencyValue,
} from './displayCurrencyContext'

/** Map the configured default rate type to its fxClient fetcher (ADR-056). */
function fetchRateFor(type: FxDefaultRateType): Promise<number | null> {
  return type === 'official'
    ? fetchSuggestedOfficialRate()
    : fetchSuggestedMepRate()
}

/**
 * Provider that reads `preferredDisplayCurrency` + `fxDefaultRateType` from
 * settings and, only when USD is preferred, fetches the single live conversion
 * rate. ARS-preferred users never trigger the rate fetch. The value is memoized
 * so consumers re-render only when the effective currency / rate changes.
 */
export function DisplayCurrencyProvider({
  children,
}: {
  children: ReactNode
}) {
  const { t } = useTranslation('settings')
  const settingsQuery = useSettings()
  const preferredCurrency: DisplayCurrency =
    settingsQuery.data?.preferredDisplayCurrency ?? 'ARS'
  const fxDefaultRateType: FxDefaultRateType =
    settingsQuery.data?.fxDefaultRateType ?? 'MEP'

  const wantsUsd = preferredCurrency === 'USD'

  // Only fetch the conversion rate when USD is actually preferred. Keyed by the
  // configured source so flipping MEP↔official refetches the right rate.
  const rateQuery = useQuery<number | null>({
    queryKey: ['display-currency', 'rate', fxDefaultRateType],
    queryFn: () => fetchRateFor(fxDefaultRateType),
    enabled: wantsUsd,
    staleTime: 5 * 60 * 1000,
    // fxClient never throws (null on failure); don't retry a benign null.
    retry: false,
  })

  const value = useMemo<DisplayCurrencyValue>(() => {
    const rate = wantsUsd ? rateQuery.data ?? null : null
    const rateLoading = wantsUsd && rateQuery.isPending
    const canConvert = wantsUsd && typeof rate === 'number' && rate > 0
    const effectiveCurrency: DisplayCurrency = canConvert ? 'USD' : 'ARS'
    // Only note a fallback once the fetch has settled and produced no usable
    // rate — never while it's still loading (that's just a transient ARS view).
    const fallbackNote =
      wantsUsd && !canConvert && !rateLoading
        ? t('displayCurrency.fallback')
        : null

    const formatMoney = (ars: number | null | undefined): string => {
      if (canConvert && rate) {
        return formatCurrency((ars ?? 0) / rate, 'USD')
      }
      return formatCurrency(ars, 'ARS')
    }

    return {
      preferredCurrency,
      effectiveCurrency,
      rate,
      rateLoading,
      fallbackNote,
      formatMoney,
    }
  }, [
    preferredCurrency,
    wantsUsd,
    rateQuery.data,
    rateQuery.isPending,
    t,
  ])

  return (
    <DisplayCurrencyContext.Provider value={value}>
      {children}
    </DisplayCurrencyContext.Provider>
  )
}
