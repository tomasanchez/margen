/**
 * Spending trend — six monthly-expense bars built with MUI Box + CSS, no chart
 * library (Issue #12 constraint).
 *
 * Each bar's height is proportional to its value against the peak in the series;
 * the current month renders in gold and the rest in a muted token. The bars are
 * decorative (aria-hidden) but the section exposes an accessible summary list so
 * the same numbers are available to assistive tech (ADR-019). The header total
 * shows the current month's expenses.
 */

import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { visuallyHidden } from '@mui/utils'
import { monoFontFamily } from '../../theme'
import { useDisplayCurrency } from '../settings/displayCurrencyContext'
import { formatMillionsCompact } from '../../lib/format'
import { localizeShortMonthToken } from '../../i18n/locale'
import type { TrendPoint } from '../../mock/types'
import { SectionCard } from '../../components/SectionCard'

/**
 * Compact label for the header total. ARS millions read as "ARS 2,8M" via the
 * shared {@link formatMillionsCompact} (es-AR grouping, 1-decimal, single source
 * of truth); small ARS values and any USD-converted value fall through to
 * {@link formatMoney}, which renders the user's preferred display currency
 * (ADR-056). The "ARS" prefix is the currency code (a domain constant, ADR-102),
 * not a localized word.
 */
function compactTotal(
  value: number,
  isUsd: boolean,
  formatMoney: (ars: number | null | undefined) => string,
): string {
  if (!isUsd && value >= 1_000_000) {
    return `ARS ${formatMillionsCompact(value)}`
  }
  return formatMoney(value)
}

export interface SpendingTrendProps {
  trend: TrendPoint[] | undefined
  loading?: boolean
}

const BAR_AREA_HEIGHT = 150

/**
 * Reserved body height so the card keeps the same footprint in every state
 * (loading, all-zero month, populated) and never collapses or jumps between
 * months. Covers the fixed bar area plus the month-label row beneath it.
 */
const BODY_MIN_HEIGHT = BAR_AREA_HEIGHT + 28

export function SpendingTrend({ trend, loading = false }: SpendingTrendProps) {
  const { t } = useTranslation('home')
  const { formatMoney, effectiveCurrency } = useDisplayCurrency()
  const isUsd = effectiveCurrency === 'USD'

  if (loading || !trend) {
    return (
      <SectionCard
        title={t('trend.title')}
        subtitle={t('trend.subtitle')}
        minHeight={BODY_MIN_HEIGHT}
      >
        <Skeleton variant="rounded" height={BAR_AREA_HEIGHT} />
      </SectionCard>
    )
  }

  const peak = trend.reduce((max, p) => Math.max(max, p.value), 0)
  const current = trend.find((p) => p.current)
  // Each item keeps the backend month token (ADR-103) and the display-aware
  // formatted amount; the items join into the localized accessible summary.
  const accessibleSummary = trend
    .map((p) =>
      t('trend.accessibleItem', {
        // The backend bakes an English short-month token (ADR-103); re-localize
        // it for display (ADR-102). English stays byte-identical ("Jun" → "Jun").
        month: localizeShortMonthToken(p.month),
        amount: formatMoney(p.value),
      }),
    )
    .join(', ')

  return (
    <SectionCard
      title={t('trend.title')}
      subtitle={t('trend.subtitle')}
      minHeight={BODY_MIN_HEIGHT}
      action={
        current ? (
          <Typography
            component="span"
            sx={{
              fontFamily: monoFontFamily,
              fontSize: 13,
              color: 'primary.main',
            }}
          >
            {compactTotal(current.value, isUsd, formatMoney)}
          </Typography>
        ) : null
      }
    >
      {/* Accessible equivalent of the visual bars. */}
      <Box component="p" sx={visuallyHidden}>
        {t('trend.accessibleSummary', { summary: accessibleSummary })}
      </Box>

      <Box
        aria-hidden
        sx={{
          display: 'flex',
          alignItems: 'stretch',
          gap: { xs: 1, md: 1.75 },
          height: BAR_AREA_HEIGHT,
          mt: 0.5,
        }}
      >
        {trend.map((point) => {
          const ratio = peak > 0 ? point.value / peak : 0
          const heightPct = Math.max(ratio * 100, 4)
          return (
            <Box
              key={point.month}
              sx={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'flex-end',
                minWidth: 0,
              }}
            >
              <Box
                sx={{
                  flex: 1,
                  width: '100%',
                  display: 'flex',
                  alignItems: 'flex-end',
                  justifyContent: 'center',
                }}
              >
                <Box
                  sx={{
                    width: '100%',
                    height: `${heightPct}%`,
                    borderRadius: '5px 5px 0 0',
                    bgcolor: point.current
                      ? 'var(--mg-gold)'
                      : 'var(--mg-border-2)',
                    transition: 'height 240ms ease',
                  }}
                />
              </Box>
              <Typography
                component="span"
                sx={{
                  fontFamily: monoFontFamily,
                  fontSize: 11,
                  mt: 1,
                  color: point.current ? 'primary.main' : 'text.disabled',
                }}
              >
                {localizeShortMonthToken(point.month)}
              </Typography>
            </Box>
          )
        })}
      </Box>
    </SectionCard>
  )
}

export default SpendingTrend
