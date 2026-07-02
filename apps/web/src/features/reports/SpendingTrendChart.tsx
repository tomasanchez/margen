/**
 * Spending-trend (month-over-month) chart for Reports (ADR-163, ADR-166).
 *
 * A responsive Recharts bar chart of the 6-month expense trend from the EXISTING
 * summaries reader (ADR-042) — the same `trend` the Home {@link SpendingTrend}
 * card renders, reused as props (no extra backend call, ADR-163). The current
 * month's bar is highlighted in the theme gold; prior months use a muted token.
 *
 * Figures render in the user's preferred display currency via the shared
 * {@link useDisplayMoney} formatter (ADR-056). Calm states (ADR-037): a skeleton
 * while loading, and an accessible text summary of the same numbers (ADR-019).
 * The chart is wrapped in a `ResponsiveContainer` so it never overflows on mobile.
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@mui/material/styles'
import Box from '@mui/material/Box'
import Skeleton from '@mui/material/Skeleton'
import { visuallyHidden } from '@mui/utils'
import {
  Bar,
  BarChart,
  Cell,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { SectionCard } from '../../components/SectionCard'
import { ErrorState } from '../../components/ErrorState'
import { useDisplayMoney } from '../settings/displayCurrencyContext'
import { localizeShortMonthToken } from '../../i18n/locale'
import type { TrendPoint } from '../../mock/types'

/** Fixed plot height; the width is responsive so the chart never overflows. */
const CHART_HEIGHT = 208

/**
 * Cap on a single bar's width. With a sparse trend (e.g. the owner's data — one
 * populated month among six empty slots) an uncapped bar stretches to fill its
 * band and reads awkwardly wide; capping keeps every bar a consistent, balanced
 * width across the six slots so a lone month looks intentional, not clipped.
 */
const MAX_BAR_SIZE = 52

export interface SpendingTrendChartProps {
  /** The 6-month trend (from the summaries reader), or undefined while loading. */
  trend: TrendPoint[] | undefined
  /** Whether the summary query is pending. */
  loading?: boolean
  /** Whether the summary query errored (renders the calm fallback). */
  isError?: boolean
  /** Retry handler for the error state. */
  onRetry?: () => void
}

/** One localized bar datum Recharts renders. */
interface ChartDatum {
  label: string
  value: number
  current: boolean
}

export function SpendingTrendChart({
  trend,
  loading = false,
  isError = false,
  onRetry,
}: SpendingTrendChartProps) {
  const { t } = useTranslation('reports')
  const theme = useTheme()
  const formatMoney = useDisplayMoney()

  const data = useMemo<ChartDatum[]>(
    () =>
      (trend ?? []).map((point) => ({
        // The backend bakes an English short-month token (ADR-103); re-localize
        // it for display (ADR-102).
        label: localizeShortMonthToken(point.month),
        value: point.value,
        current: Boolean(point.current),
      })),
    [trend],
  )

  // A failed query gets the calm ErrorState — not an eternal skeleton (ADR-037).
  if (isError) {
    return (
      <ErrorState
        title={t('trend.errorTitle')}
        description={t('trend.errorDescription')}
        onRetry={onRetry}
      />
    )
  }

  if (loading || !trend) {
    return (
      <SectionCard title={t('trend.title')} subtitle={t('trend.subtitle')}>
        <Skeleton
          variant="rounded"
          height={CHART_HEIGHT}
          sx={{ borderRadius: '10px' }}
        />
      </SectionCard>
    )
  }

  const accessibleSummary = trend
    .map((point) =>
      t('trend.accessibleItem', {
        month: localizeShortMonthToken(point.month),
        amount: formatMoney(point.value),
      }),
    )
    .join(', ')

  const currentColor = theme.palette.primary.main
  const priorColor = theme.palette.action.disabled
  const axisColor = theme.palette.text.secondary
  const gridColor = theme.palette.divider

  // Recharts 3.x types the formatter value as `ValueType`; coerce to a number.
  const asNumber = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0

  return (
    <SectionCard title={t('trend.title')} subtitle={t('trend.subtitle')}>
      <Box component="p" sx={visuallyHidden}>
        {t('trend.accessibleSummary', { summary: accessibleSummary })}
      </Box>

      <Box aria-hidden sx={{ width: '100%', height: CHART_HEIGHT }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            barCategoryGap="18%"
            // A wider right margin keeps the rightmost (current-month) bar clear
            // of the container edge so it is never clipped; the left margin holds
            // the Y-axis labels.
            margin={{ top: 8, right: 16, bottom: 4, left: 4 }}
          >
            <CartesianGrid stroke={gridColor} strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="label"
              stroke={axisColor}
              tick={{ fontSize: 11, fill: axisColor }}
              tickLine={false}
              axisLine={{ stroke: gridColor }}
            />
            <YAxis
              stroke={axisColor}
              tick={{ fontSize: 11, fill: axisColor }}
              tickLine={false}
              axisLine={false}
              width={56}
              tickFormatter={(value) => formatMoney(asNumber(value))}
            />
            <Tooltip
              cursor={{ fill: theme.palette.action.hover }}
              formatter={(value) => [
                formatMoney(asNumber(value)),
                t('trend.tooltipLabel'),
              ]}
              contentStyle={{
                background: theme.palette.background.paper,
                border: `1px solid ${gridColor}`,
                borderRadius: 10,
                fontSize: 12,
              }}
              labelStyle={{ color: theme.palette.text.primary }}
            />
            <Bar
              dataKey="value"
              radius={[5, 5, 0, 0]}
              maxBarSize={MAX_BAR_SIZE}
              isAnimationActive={false}
            >
              {data.map((datum) => (
                <Cell
                  key={datum.label}
                  fill={datum.current ? currentColor : priorColor}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Box>
    </SectionCard>
  )
}

export default SpendingTrendChart
