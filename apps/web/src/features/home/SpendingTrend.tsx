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
import { formatCurrency } from '../../lib/format'
import type { TrendPoint } from '../../mock/types'
import { SectionCard } from './SectionCard'

/** Compact ARS label for the header total, e.g. 2_850_000 -> "ARS 2,85M". */
function compactArs(value: number): string {
  if (value >= 1_000_000) {
    const millions = (value / 1_000_000).toFixed(2).replace('.', ',')
    return `ARS ${millions}M`
  }
  return formatCurrency(value, 'ARS')
}

export interface SpendingTrendProps {
  trend: TrendPoint[] | undefined
  loading?: boolean
}

const BAR_AREA_HEIGHT = 150

export function SpendingTrend({ trend, loading = false }: SpendingTrendProps) {
  if (loading || !trend) {
    return (
      <SectionCard
        title="Spending trend"
        subtitle="Monthly expenses · last 6 months"
      >
        <Skeleton variant="rounded" height={BAR_AREA_HEIGHT} />
      </SectionCard>
    )
  }

  const peak = trend.reduce((max, p) => Math.max(max, p.value), 0)
  const current = trend.find((p) => p.current)
  const accessibleSummary = trend
    .map((p) => `${p.month}: ${formatCurrency(p.value, 'ARS')}`)
    .join(', ')

  return (
    <SectionCard
      title="Spending trend"
      subtitle="Monthly expenses · last 6 months"
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
            {compactArs(current.value)}
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
