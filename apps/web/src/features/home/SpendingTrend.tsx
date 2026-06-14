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

import Box from '@mui/material/Box'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { visuallyHidden } from '@mui/utils'
import { monoFontFamily } from '../../theme'
import { useDisplayCurrency } from '../settings/displayCurrencyContext'
import type { TrendPoint } from '../../mock/types'
import { SectionCard } from '../../components/SectionCard'

/**
 * Compact label for the header total. ARS millions read as "ARS 2,85M"; small
 * ARS values and any USD-converted value fall through to {@link formatMoney},
 * which renders the user's preferred display currency (ADR-056).
 */
function compactTotal(
  value: number,
  isUsd: boolean,
  formatMoney: (ars: number | null | undefined) => string,
): string {
  if (!isUsd && value >= 1_000_000) {
    const millions = (value / 1_000_000).toFixed(2).replace('.', ',')
    return `ARS ${millions}M`
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
  const { formatMoney, effectiveCurrency } = useDisplayCurrency()
  const isUsd = effectiveCurrency === 'USD'

  if (loading || !trend) {
    return (
      <SectionCard
        title="Spending trend"
        subtitle="Monthly expenses · last 6 months"
        minHeight={BODY_MIN_HEIGHT}
      >
        <Skeleton variant="rounded" height={BAR_AREA_HEIGHT} />
      </SectionCard>
    )
  }

  const peak = trend.reduce((max, p) => Math.max(max, p.value), 0)
  const current = trend.find((p) => p.current)
  const accessibleSummary = trend
    .map((p) => `${p.month}: ${formatMoney(p.value)}`)
    .join(', ')

  return (
    <SectionCard
      title="Spending trend"
      subtitle="Monthly expenses · last 6 months"
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
        Monthly expenses, last six months. {accessibleSummary}.
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
                {point.month}
              </Typography>
            </Box>
          )
        })}
      </Box>
    </SectionCard>
  )
}

export default SpendingTrend
