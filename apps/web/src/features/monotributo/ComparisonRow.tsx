/**
 * Period-over-period comparison — "Compared to the previous period" (ADR-052).
 *
 * Shown only when the "Compare to previous period" toggle is on. When a prior
 * trailing-12-month snapshot exists it lays out current vs previous figures with
 * signed deltas for used, % used, status band, and category. When no prior
 * period exists yet it shows a calm "No prior period to compare yet." empty
 * state. Deltas pair an explicit signed value with a tone token — never color
 * alone (ADR-019): the sign text carries the direction.
 */

import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { monoFontFamily } from '../../theme'
import {
  MINUS,
  PLUS,
  formatCurrency,
} from '../../lib/format'
import type {
  MonotributoComparison,
  MonotributoStanding,
} from '../../mock/types'
import { SectionCard } from '../../components/SectionCard'

/**
 * Status band → calm word for the comparison cells (ADR-046). Resolved against
 * the `monotributo` namespace's own comparison-status copy (distinct from the
 * shared `common:status.*` meter bands).
 */
function statusWord(t: TFunction<'monotributo'>, band: string): string {
  const key = `comparison.status.${band}` as const
  const word = t(key)
  // Fall back to the raw band when an unexpected value has no mapped word.
  return word === key ? band : word
}

/** A signed currency delta, e.g. 1000 → "+ARS 1.000", -500 → "−ARS 500". */
function signedCurrency(diff: number): string {
  const sign = diff > 0 ? PLUS : diff < 0 ? MINUS : ''
  return `${sign}${formatCurrency(diff, 'ARS')}`
}

/** A signed percentage-point delta, e.g. 4.2 → "+4.2 pts", -1 → "−1 pts". */
function signedPoints(t: TFunction<'monotributo'>, diff: number): string {
  const sign = diff > 0 ? PLUS : diff < 0 ? MINUS : ''
  return t('comparison.points', { value: `${sign}${Math.abs(diff).toFixed(1)}` })
}

/** One labeled current/previous/delta column. */
function CompareCell({
  label,
  current,
  previous,
  delta,
}: {
  label: string
  current: string
  previous: string
  delta: string
}) {
  const { t } = useTranslation('monotributo')
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography
        component="p"
        sx={{
          fontSize: 10.5,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          fontWeight: 600,
        }}
        color="text.disabled"
      >
        {label}
      </Typography>
      <Typography
        component="p"
        sx={{
          fontFamily: monoFontFamily,
          fontVariantNumeric: 'tabular-nums',
          fontSize: 15,
          fontWeight: 600,
          mt: 0.5,
        }}
        color="text.primary"
      >
        {current}
      </Typography>
      <Typography
        component="p"
        sx={{ fontFamily: monoFontFamily, fontSize: 11.5, mt: 0.25 }}
        color="text.disabled"
      >
        {t('comparison.wasValue', { value: previous })}
      </Typography>
      <Typography
        component="p"
        sx={{ fontSize: 12, mt: 0.5, fontWeight: 600 }}
        color="var(--mg-text-mid)"
      >
        {delta}
      </Typography>
    </Box>
  )
}

export interface ComparisonRowProps {
  comparison: MonotributoComparison | null
  /** The previous standing, used for the period dates in the subtitle. */
  previous: MonotributoStanding | null
}

export function ComparisonRow({ comparison, previous }: ComparisonRowProps) {
  const { t } = useTranslation('monotributo')

  if (!comparison || !previous) {
    return (
      <SectionCard title={t('comparison.title')}>
        <Typography
          sx={{ fontSize: 13.5, lineHeight: 1.5, textWrap: 'pretty' }}
          color="text.secondary"
        >
          {t('comparison.empty')}
        </Typography>
      </SectionCard>
    )
  }

  const categoryDelta = comparison.category.changed
    ? t('comparison.delta', {
        previous: comparison.category.previous,
        current: comparison.category.current,
      })
    : t('comparison.unchanged')
  const statusDelta = comparison.status.changed
    ? t('comparison.delta', {
        previous: statusWord(t, comparison.status.previous),
        current: statusWord(t, comparison.status.current),
      })
    : t('comparison.unchanged')

  return (
    <SectionCard
      title={t('comparison.title')}
      subtitle={t('comparison.subtitle', { date: previous.periodEnd })}
    >
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: {
            xs: '1fr 1fr',
            md: 'repeat(4, 1fr)',
          },
          gap: { xs: 2, md: 2.5 },
        }}
      >
        <CompareCell
          label={t('comparison.labelInvoiced')}
          current={formatCurrency(comparison.used.current, 'ARS')}
          previous={formatCurrency(comparison.used.previous, 'ARS')}
          delta={signedCurrency(comparison.used.diff)}
        />
        <CompareCell
          label={t('comparison.labelPercent')}
          current={`${comparison.percentUsed.current.toFixed(1)}%`}
          previous={`${comparison.percentUsed.previous.toFixed(1)}%`}
          delta={signedPoints(t, comparison.percentUsed.diff)}
        />
        <CompareCell
          label={t('comparison.labelCategory')}
          current={t('comparison.categoryCell', {
            letter: comparison.category.current,
          })}
          previous={t('comparison.categoryCell', {
            letter: comparison.category.previous,
          })}
          delta={categoryDelta}
        />
        <CompareCell
          label={t('comparison.labelStatus')}
          current={statusWord(t, comparison.status.current)}
          previous={statusWord(t, comparison.status.previous)}
          delta={statusDelta}
        />
      </Box>
    </SectionCard>
  )
}

export default ComparisonRow
