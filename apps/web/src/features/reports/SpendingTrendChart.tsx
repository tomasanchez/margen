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
import { useDisplayMoney } from '../settings/displayCurrencyContext'
import { localizeShortMonthToken } from '../../i18n/locale'
import type { TrendPoint } from '../../mock/types'

/** Fixed plot height; the width is responsive so the chart never overflows. */
const CHART_HEIGHT = 220

export interface SpendingTrendChartProps {
  /** The 6-month trend (from the summaries reader), or undefined while loading. */
  trend: TrendPoint[] | undefined
  /** Whether the summary query is pending. */
  loading?: boolean
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
            margin={{ top: 8, right: 12, bottom: 4, left: 4 }}
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
            <Bar dataKey="value" radius={[5, 5, 0, 0]} isAnimationActive={false}>
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
