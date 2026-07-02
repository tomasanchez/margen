/**
 * Net-worth-over-time chart for Reports (ADR-163, ADR-164, ADR-166).
 *
 * A responsive Recharts line chart of the monthly net-worth trajectory. The
 * backend returns NATIVE per-currency subtotals with no FX (ADR-164); this
 * component converts each month to the user's preferred display currency at the
 * SAME live rate the Home net-worth snapshot uses (the preferred-rate source,
 * ADR-151), so the "current" point matches the snapshot card (ADR-123).
 *
 * Calm states (ADR-037): a skeleton while the history OR the live rate loads; the
 * calm {@link ErrorState} when the history query fails; an empty note when there
 * is no history; and a "rate unavailable" degrade note when a cross-currency
 * balance exists but no live rate could be fetched (we never fabricate one). The
 * chart is wrapped in a `ResponsiveContainer` so it never overflows on mobile.
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@mui/material/styles'
import Box from '@mui/material/Box'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { visuallyHidden } from '@mui/utils'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { SectionCard } from '../../components/SectionCard'
import { ErrorState } from '../../components/ErrorState'
import { formatCurrency } from '../../lib/format'
import { localizeShortMonthToken } from '../../i18n/locale'
import { shortMonthLabel } from '../../api/summariesClient'
import type { DisplayCurrency } from '../../api/settingsClient'
import type { NetWorthHistory } from '../../api/reportsClient'
import {
  convertNetWorthSeries,
  hasAnyConvertedValue,
} from './netWorthSeries'

/** Fixed plot height; the width is responsive so the chart never overflows. */
const CHART_HEIGHT = 240

export interface NetWorthChartProps {
  /** The net-worth history read model, or undefined while loading. */
  history: NetWorthHistory | undefined
  /** Whether the history query is pending. */
  loading: boolean
  /** Whether the history query errored (renders the calm fallback). */
  isError?: boolean
  /** Retry handler for the error state. */
  onRetry?: () => void
  /** The user's preferred display currency (ARS / USD). */
  displayCurrency: DisplayCurrency
  /** The live rate (ARS per USD) from the preferred source, or null when unavailable. */
  rate: number | null
  /** Whether the live-rate query is still pending (drives the loading skeleton). */
  rateLoading: boolean
}

/** One point in the localized-label chart data Recharts renders. */
interface ChartDatum {
  /** Localized short month label (e.g. "Jun"). */
  label: string
  /** Net worth in the display currency, or null when unconvertible (degrade). */
  value: number | null
}

export function NetWorthChart({
  history,
  loading,
  isError = false,
  onRetry,
  displayCurrency,
  rate,
  rateLoading,
}: NetWorthChartProps) {
  const { t } = useTranslation('reports')
  const theme = useTheme()

  // Convert the native series to the display currency at the single live rate
  // (ADR-164). Memoized so a re-render doesn't recompute unnecessarily.
  const series = useMemo(
    () =>
      history
        ? convertNetWorthSeries(history.months, displayCurrency, rate)
        : [],
    [history, displayCurrency, rate],
  )

  const data = useMemo<ChartDatum[]>(
    () =>
      series.map((point) => ({
        label: localizeShortMonthToken(shortMonthLabel(point.month)),
        value: point.value,
      })),
    [series],
  )

  if (isError) {
    return (
      <ErrorState
        title={t('netWorth.errorTitle')}
        description={t('netWorth.errorDescription')}
        onRetry={onRetry}
      />
    )
  }

  // Wait on BOTH the history AND the live rate so the chart never shows figures
  // at the wrong (pre-conversion) value (ADR-164/037).
  if (loading || !history || rateLoading) {
    return (
      <SectionCard title={t('netWorth.title')} subtitle={t('netWorth.subtitle')}>
        <Skeleton
          variant="rounded"
          height={CHART_HEIGHT}
          sx={{ borderRadius: '10px' }}
        />
      </SectionCard>
    )
  }

  if (history.months.length === 0) {
    return (
      <SectionCard title={t('netWorth.title')} subtitle={t('netWorth.subtitle')}>
        <Typography sx={{ fontSize: 13.5 }} color="text.disabled" role="status">
          {t('netWorth.empty')}
        </Typography>
      </SectionCard>
    )
  }

  // A cross-currency balance with no usable rate leaves every value null; show a
  // calm degrade note instead of an empty chart (ADR-037/164).
  if (!hasAnyConvertedValue(series)) {
    return (
      <SectionCard title={t('netWorth.title')} subtitle={t('netWorth.subtitle')}>
        <Typography sx={{ fontSize: 13 }} color="text.secondary" role="note">
          {t('netWorth.rateUnavailable')}
        </Typography>
      </SectionCard>
    )
  }

  // Accessible equivalent of the visual line (ADR-019): the same numbers as text.
  const accessibleSummary = series
    .filter((point) => point.value != null)
    .map((point) =>
      t('netWorth.accessibleItem', {
        month: localizeShortMonthToken(shortMonthLabel(point.month)),
        amount: formatCurrency(point.value ?? 0, displayCurrency),
      }),
    )
    .join(', ')

  const lineColor = theme.palette.primary.main
  const axisColor = theme.palette.text.secondary
  const gridColor = theme.palette.divider

  // Recharts 3.x types the formatter value as `ValueType` (number | string |
  // array); coerce to a number defensively before the shared money formatter.
  const asNumber = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0

  return (
    <SectionCard title={t('netWorth.title')} subtitle={t('netWorth.subtitle')}>
      <Box component="p" sx={visuallyHidden}>
        {t('netWorth.accessibleSummary', { summary: accessibleSummary })}
      </Box>

      <Box aria-hidden sx={{ width: '100%', height: CHART_HEIGHT }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
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
              tickFormatter={(value) =>
                formatCurrency(asNumber(value), displayCurrency)
              }
            />
            <Tooltip
              formatter={(value) => [
                formatCurrency(asNumber(value), displayCurrency),
                t('netWorth.tooltipLabel'),
              ]}
              contentStyle={{
                background: theme.palette.background.paper,
                border: `1px solid ${gridColor}`,
                borderRadius: 10,
                fontSize: 12,
              }}
              labelStyle={{ color: theme.palette.text.primary }}
            />
            <Line
              type="monotone"
              dataKey="value"
              stroke={lineColor}
              strokeWidth={2}
              dot={{ r: 3, fill: lineColor }}
              activeDot={{ r: 5 }}
              connectNulls
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </Box>
    </SectionCard>
  )
}

export default NetWorthChart
