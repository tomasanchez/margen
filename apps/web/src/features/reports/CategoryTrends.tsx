/**
 * Category trends table for Reports (ADR-167) — "what's moving, not just what's
 * big". Each row: the category (+ its share of spend), the window total (mono, in
 * the requested currency — figures arrive already denominated, ADR-168), a
 * 6-month sparkline (an inline SVG polyline mirroring the concept), and a
 * vs-previous delta chip. Colour follows spend direction — green when a category
 * fell, amber when it rose, muted when flat — and the chip always carries the
 * signed number (never colour alone, ADR-019).
 *
 * The sparkline path is computed by the pure {@link categorySparkline}; the whole
 * table renders inside a {@link SectionCard} with a real column-header row.
 */

import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { visuallyHidden } from '@mui/utils'
import { SectionCard } from '../../components/SectionCard'
import { monoFontFamily } from '../../theme'
import { formatCurrency, formatDelta } from '../../lib/format'
import { categoryLabel } from '../transactions/presentation'
import type { Category, Currency } from '../../mock/types'
import type { CategoryTrend } from '../../api/reportsClient'
import { categorySparkline, trendDirection, type TrendDirection } from './reportsFormat'

/** Grid template shared by the header + rows (category / total / spark / delta). */
const GRID_COLUMNS = '1.4fr 1fr 78px 80px'

/** Semantic colour for a trend direction (spend down = good/green, up = watch). */
function directionColor(direction: TrendDirection): string {
  if (direction === 'up') return 'var(--mg-watch-text)'
  if (direction === 'down') return 'var(--mg-safe-text)'
  return 'var(--mg-text-3)'
}

export interface CategoryTrendsProps {
  /** Per-category trends, already sorted by total descending (ADR-169). */
  trends: CategoryTrend[]
  /** The denomination the totals are already in (ADR-168). */
  currency: Currency
}

/** The header row of column labels. */
function HeaderRow() {
  const { t } = useTranslation('reports')
  return (
    <Box
      role="row"
      sx={{
        display: 'grid',
        gridTemplateColumns: GRID_COLUMNS,
        gap: 1.5,
        py: 1.25,
        borderBottom: '1px solid var(--mg-border)',
        fontSize: 11,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        fontWeight: 600,
        color: 'text.disabled',
      }}
    >
      <Box role="columnheader">{t('categoryTrends.colCategory')}</Box>
      <Box role="columnheader" sx={{ textAlign: 'right' }}>
        {t('categoryTrends.colTotal')}
      </Box>
      <Box role="columnheader" sx={{ textAlign: 'center' }}>
        {t('categoryTrends.colTrend')}
      </Box>
      <Box role="columnheader" sx={{ textAlign: 'right' }}>
        {t('categoryTrends.colDelta')}
      </Box>
    </Box>
  )
}

/** One category row: label + share, total, sparkline, delta chip. */
function TrendRow({
  trend,
  currency,
}: {
  trend: CategoryTrend
  currency: Currency
}) {
  const { t } = useTranslation('reports')
  const direction = trendDirection(trend.deltaPct)
  const color = directionColor(direction)
  const points = categorySparkline(trend)

  const deltaLabel =
    direction === 'flat' || trend.deltaPct == null
      ? t('categoryTrends.flat')
      : // deltaPct arrives already as a PERCENTAGE (−6 = −6%); render as a
        // signed whole percent with no scaling.
        formatDelta(trend.deltaPct, 0)

  return (
    <Box
      role="row"
      sx={{
        display: 'grid',
        gridTemplateColumns: GRID_COLUMNS,
        gap: 1.5,
        alignItems: 'center',
        py: 1.5,
        borderBottom: '1px solid var(--mg-border)',
      }}
    >
      <Box role="cell" sx={{ minWidth: 0 }}>
        <Typography sx={{ fontSize: 14 }} color="text.primary" noWrap>
          {categoryLabel(trend.category as Category)}
        </Typography>
        <Typography sx={{ fontSize: 11, mt: 0.25 }} color="text.disabled">
          {t('categoryTrends.share', { share: Math.round(trend.share) })}
        </Typography>
      </Box>
      <Box
        role="cell"
        sx={{
          fontFamily: monoFontFamily,
          fontVariantNumeric: 'tabular-nums',
          fontSize: 13.5,
          textAlign: 'right',
          color: 'var(--mg-text-mid)',
        }}
      >
        {formatCurrency(trend.total, currency)}
      </Box>
      <Box role="cell" sx={{ display: 'flex', justifyContent: 'center' }}>
        {points ? (
          <Box
            component="svg"
            viewBox="0 0 100 28"
            preserveAspectRatio="none"
            aria-hidden
            sx={{ width: 74, height: 24, overflow: 'visible' }}
          >
            <polyline
              fill="none"
              stroke={color}
              strokeWidth={2}
              points={points}
              vectorEffect="non-scaling-stroke"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </Box>
        ) : (
          <Typography sx={{ fontSize: 12 }} color="text.disabled">
            —
          </Typography>
        )}
      </Box>
      <Box
        role="cell"
        sx={{
          fontFamily: monoFontFamily,
          fontSize: 13,
          textAlign: 'right',
          color,
        }}
      >
        {deltaLabel}
      </Box>
    </Box>
  )
}

export function CategoryTrends({ trends, currency }: CategoryTrendsProps) {
  const { t } = useTranslation('reports')

  if (trends.length === 0) {
    return (
      <SectionCard
        title={t('categoryTrends.title')}
        subtitle={t('categoryTrends.subtitle')}
      >
        <Typography sx={{ fontSize: 13.5 }} color="text.disabled" role="status">
          {t('categoryTrends.empty')}
        </Typography>
      </SectionCard>
    )
  }

  // Accessible summary of the whole table (ADR-019): the same figures as text.
  const accessibleSummary = trends
    .map((trend) =>
      t('categoryTrends.accessibleItem', {
        category: categoryLabel(trend.category as Category),
        total: formatCurrency(trend.total, currency),
      }),
    )
    .join(', ')

  return (
    <SectionCard
      title={t('categoryTrends.title')}
      subtitle={t('categoryTrends.subtitle')}
    >
      <Box component="p" sx={visuallyHidden}>
        {t('categoryTrends.accessibleSummary', { summary: accessibleSummary })}
      </Box>
      <Box role="table" aria-label={t('categoryTrends.tableAria')}>
        <HeaderRow />
        {trends.map((trend) => (
          <TrendRow key={trend.category} trend={trend} currency={currency} />
        ))}
      </Box>
    </SectionCard>
  )
}

export default CategoryTrends
