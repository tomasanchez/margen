/**
 * Cash-flow forecast chart for Reports (ADR-173, ADR-176, ADR-178) — a standalone
 * full-width card plotting the COMMITTED outflow projected for each future month
 * (subscriptions + installment tails + the monotributo cuota). v1 is committed-only
 * (ADR-176), so the bars are a single solid series; the confidence tier is
 * `committed` throughout and a discretionary band is deferred.
 *
 * Figures arrive ALREADY in the requested currency (ADR-168), so the axis/tooltip
 * format them directly with no conversion. This is a STANDALONE full-width card, so
 * the chart gets a DEFINITE height — a `flex:1` box would collapse the
 * ResponsiveContainer to 0 (ADR-166, the same bug the cash-flow chart avoids). The
 * tooltip sets `itemStyle`/`labelStyle` to theme tokens so it reads in dark mode,
 * and the Y-axis uses the compact-axis helper so ticks stay narrow. An empty
 * horizon (no committed streams) renders a calm inline note instead of an empty
 * plot, keeping the panel honest about the v1 commitment-tagging caveat (ADR-173).
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@mui/material/styles'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { visuallyHidden } from '@mui/utils'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { SectionCard } from '../../components/SectionCard'
import { monoFontFamily } from '../../theme'
import { formatCurrency, formatCompactAxis } from '../../lib/format'
import { localizeShortMonthToken } from '../../i18n/locale'
import { shortMonthLabel } from '../../api/summariesClient'
import type { Currency } from '../../mock/types'
import type { ForecastMonth } from '../../api/forecastClient'

/** Definite chart height (a standalone full-width card — ADR-166). */
const CHART_HEIGHT = 220

export interface ForecastChartProps {
  /** The oldest-first per-future-month committed-outflow series (ADR-176). */
  months: ForecastMonth[]
  /** The denomination the figures are already in (ADR-168). */
  currency: Currency
}

/** One localized bar datum Recharts renders. */
interface ChartDatum {
  label: string
  committed: number
}

/** Coerce a Recharts tooltip value to a finite number for formatting. */
function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function ForecastChart({ months, currency }: ForecastChartProps) {
  const { t } = useTranslation('reports')
  const theme = useTheme()

  const data = useMemo<ChartDatum[]>(
    () =>
      months.map((point) => ({
        label: localizeShortMonthToken(shortMonthLabel(point.month)),
        committed: point.committed,
      })),
    [months],
  )

  const committedColor = theme.palette.primary.main
  const axisColor = theme.palette.text.secondary
  const gridColor = theme.palette.divider

  // Committed total across the whole horizon, shown top-right as a mono figure.
  const total = useMemo(
    () => months.reduce((sum, point) => sum + point.committed, 0),
    [months],
  )

  // Accessible equivalent of the bars (ADR-019): the same numbers as text.
  const accessibleSummary = months
    .map((point) =>
      t('forecast.accessibleItem', {
        month: localizeShortMonthToken(shortMonthLabel(point.month)),
        committed: formatCurrency(point.committed, currency),
      }),
    )
    .join('; ')

  const isEmpty = months.length === 0

  const totalAction = (
    <Box sx={{ textAlign: 'right' }}>
      <Typography
        component="p"
        sx={{ fontFamily: monoFontFamily, fontSize: 15, fontWeight: 600 }}
        color="text.primary"
      >
        {formatCurrency(total, currency)}
      </Typography>
      <Typography sx={{ fontSize: 11 }} color="text.disabled">
        {t('forecast.committedTotal')}
      </Typography>
    </Box>
  )

  return (
    <SectionCard
      title={t('forecast.title')}
      subtitle={t('forecast.subtitle')}
      action={isEmpty ? undefined : totalAction}
    >
      {isEmpty ? (
        <Typography
          role="note"
          sx={{ fontSize: 13, py: 3, textAlign: 'center' }}
          color="text.secondary"
        >
          {t('forecast.empty')}
        </Typography>
      ) : (
        <>
          <Box component="p" sx={visuallyHidden}>
            {t('forecast.accessibleSummary', { summary: accessibleSummary })}
          </Box>

          {/* Definite height: a standalone full-width card has no sibling to size
              against, so a flex:1 box would collapse the ResponsiveContainer
              (ADR-166). */}
          <Box aria-hidden sx={{ height: CHART_HEIGHT, width: '100%' }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data}
                barCategoryGap="28%"
                margin={{ top: 8, right: 12, bottom: 4, left: 4 }}
              >
                <CartesianGrid
                  stroke={gridColor}
                  strokeDasharray="3 3"
                  vertical={false}
                />
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
                  width={52}
                  tickFormatter={(value) =>
                    formatCompactAxis(asNumber(value), currency)
                  }
                />
                <Tooltip
                  cursor={{ fill: theme.palette.action.hover }}
                  formatter={(value) => [
                    formatCurrency(asNumber(value), currency),
                    t('forecast.committed'),
                  ]}
                  contentStyle={{
                    background: theme.palette.background.paper,
                    border: `1px solid ${gridColor}`,
                    borderRadius: 10,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: theme.palette.text.primary }}
                  itemStyle={{ color: theme.palette.text.primary }}
                />
                <Bar
                  dataKey="committed"
                  fill={committedColor}
                  radius={[4, 4, 0, 0]}
                  maxBarSize={28}
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
          </Box>
        </>
      )}
    </SectionCard>
  )
}

export default ForecastChart
