/**
 * The four headline metric cards (Issue #12): Income, Expenses, Est. savings,
 * Monotributo margin.
 *
 * Each card carries an uppercase letter-spaced eyebrow, a big mono figure, and a
 * delta/context line. Income/Expenses are derived from the live month metrics;
 * Est. savings is income − expenses with its USD-at-MEP equivalent; Monotributo
 * margin comes from the snapshot. Figures render in IBM Plex Mono via the shared
 * format helpers so number styling never drifts. The deltas pair a Safe/Watch
 * color with the explicit "+N% vs. May" text (never color alone — ADR-019).
 */

import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { monoFontFamily } from '../../theme'
import { formatCurrency, formatDelta } from '../../lib/format'
import type { MonotributoState } from '../../mock/types'
import type { MonthMetrics } from './homeMetrics'

/** Tone of a delta line — drives its token color but never carries meaning alone. */
type DeltaTone = 'safe' | 'watch' | 'neutral'

const DELTA_COLOR: Record<DeltaTone, string> = {
  safe: 'var(--mg-safe)',
  watch: 'var(--mg-watch)',
  neutral: 'var(--mg-text-2)',
}

interface MetricCardProps {
  label: string
  /** Pre-formatted figure string (already through format helpers). */
  figure: string
  /** Context / delta line under the figure. */
  caption: string
  captionTone?: DeltaTone
  /** Subtle gold tint used to set the Monotributo margin card apart. */
  highlight?: boolean
}

function MetricCard({
  label,
  figure,
  caption,
  captionTone = 'neutral',
  highlight = false,
}: MetricCardProps) {
  return (
    <Paper
      variant="outlined"
      sx={{
        p: 2.25,
        borderRadius: '14px',
        bgcolor: 'var(--mg-paper)',
        borderColor: highlight ? 'var(--mg-border-2)' : 'var(--mg-border)',
        ...(highlight
          ? {
              backgroundImage:
                'linear-gradient(180deg, color-mix(in srgb, var(--mg-gold) 6%, transparent), transparent 70%)',
            }
          : {}),
        minWidth: 0,
      }}
    >
      <Typography variant="overline" component="p" noWrap>
        {label}
      </Typography>
      <Typography
        component="p"
        sx={{
          fontFamily: monoFontFamily,
          fontVariantNumeric: 'tabular-nums',
          fontSize: { xs: '1.0625rem', md: '1.5rem' },
          fontWeight: 500,
          letterSpacing: '-0.01em',
          mt: 1.25,
          color: 'text.primary',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {figure}
      </Typography>
      <Typography
        component="p"
        sx={{ fontSize: 12.5, mt: 1, color: DELTA_COLOR[captionTone] }}
      >
        {caption}
      </Typography>
    </Paper>
  )
}

export interface MetricCardsProps {
  metrics: MonthMetrics | undefined
  monotributo: MonotributoState | undefined
  /** Month-over-month income delta (%). */
  incomeDeltaPct: number
  /** Month-over-month expense delta (%). */
  expenseDeltaPct: number
  /** Previous month label for the delta captions, e.g. "May". */
  previousMonthLabel: string
  loading?: boolean
}

/** Responsive 2-col (mobile) / 4-col (desktop) grid of the headline metrics. */
export function MetricCards({
  metrics,
  monotributo,
  incomeDeltaPct,
  expenseDeltaPct,
  previousMonthLabel,
  loading = false,
}: MetricCardsProps) {
  const gridSx = {
    display: 'grid',
    gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(4, 1fr)' },
    gap: { xs: 1.25, md: 2 },
    mb: { xs: 2, md: 3.25 },
  } as const

  if (loading || !metrics) {
    return (
      <Box sx={gridSx}>
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton
            key={i}
            variant="rounded"
            height={108}
            sx={{ borderRadius: '14px' }}
          />
        ))}
      </Box>
    )
  }

  const savingsUsdLine = `≈ ${formatCurrency(metrics.savingsUsd, 'USD')} at MEP`
  const marginCaption = monotributo
    ? `before Category ${monotributo.projectedCategory}`
    : 'set up your Monotributo category'

  return (
    <Box sx={gridSx}>
      <MetricCard
        label="Income"
        figure={formatCurrency(metrics.income, 'ARS')}
        caption={`${formatDelta(incomeDeltaPct)} vs. ${previousMonthLabel}`}
        captionTone={incomeDeltaPct >= 0 ? 'safe' : 'watch'}
      />
      <MetricCard
        label="Expenses"
        figure={formatCurrency(metrics.expenses, 'ARS')}
        caption={`${formatDelta(expenseDeltaPct)} vs. ${previousMonthLabel}`}
        captionTone={expenseDeltaPct > 0 ? 'watch' : 'safe'}
      />
      <MetricCard
        label="Est. savings"
        figure={formatCurrency(metrics.savings, 'ARS')}
        caption={savingsUsdLine}
        captionTone="neutral"
      />
      <MetricCard
        label="Monotributo margin"
        figure={
          monotributo ? formatCurrency(monotributo.margin, 'ARS') : '—'
        }
        caption={marginCaption}
        captionTone={monotributo ? 'watch' : 'neutral'}
        highlight
      />
    </Box>
  )
}

export default MetricCards
