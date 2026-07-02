/**
 * Cash-flow chart for Reports (ADR-167, ADR-166) — a full-width card with grouped
 * bars per month: Income (gold) vs Expenses (muted), over the selected range. The
 * net-saved figure sits top-right, a legend distinguishes the two series (never
 * colour alone — the legend labels them), and the Y-axis uses the compact-axis
 * helper so ticks stay narrow.
 *
 * Figures arrive ALREADY in the requested currency (ADR-168), so the axis/tooltip
 * format them directly with no conversion. This is a STANDALONE full-width card,
 * so the chart gets a DEFINITE height — a `flex:1` box would collapse the
 * ResponsiveContainer to 0 (ADR-166). The tooltip sets `itemStyle` to a theme
 * token so it reads in dark mode.
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
  Legend,
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
import type { CashFlowPoint } from '../../api/reportsClient'

/** Definite chart height (a standalone full-width card — ADR-166). */
const CHART_HEIGHT = 240

export interface CashFlowChartProps {
  /** The oldest-first per-month income/expense series (ADR-169). */
  cashFlow: CashFlowPoint[]
  /** Net saved over the whole window (sum of income − expenses). */
  netSaved: number
  /** The denomination the figures are already in (ADR-168). */
  currency: Currency
}

/** One localized bar-group datum Recharts renders. */
interface ChartDatum {
  label: string
  income: number
  expenses: number
}

export function CashFlowChart({ cashFlow, netSaved, currency }: CashFlowChartProps) {
  const { t } = useTranslation('reports')
  const theme = useTheme()

  const data = useMemo<ChartDatum[]>(
    () =>
      cashFlow.map((point) => ({
        label: localizeShortMonthToken(shortMonthLabel(point.month)),
        income: point.income,
        expenses: point.expenses,
      })),
    [cashFlow],
  )

  const incomeColor = theme.palette.primary.main
  const expenseColor = theme.palette.action.disabled
  const axisColor = theme.palette.text.secondary
  const gridColor = theme.palette.divider

  const asNumber = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0

  const netColor = netSaved >= 0 ? 'var(--mg-safe)' : 'var(--mg-risk)'

  // Accessible equivalent of the grouped bars (ADR-019): the same numbers as text.
  const accessibleSummary = cashFlow
    .map((point) =>
      t('cashFlow.accessibleItem', {
        month: localizeShortMonthToken(shortMonthLabel(point.month)),
        income: formatCurrency(point.income, currency),
        expenses: formatCurrency(point.expenses, currency),
      }),
    )
    .join('; ')

  const netAction = (
    <Box sx={{ textAlign: 'right' }}>
      <Typography
        component="p"
        sx={{ fontFamily: monoFontFamily, fontSize: 15, fontWeight: 600 }}
        style={{ color: netColor }}
      >
        {formatCurrency(netSaved, currency)}
      </Typography>
      <Typography sx={{ fontSize: 11 }} color="text.disabled">
        {t('cashFlow.netSaved')}
      </Typography>
    </Box>
  )

  return (
    <SectionCard
      title={t('cashFlow.title')}
      subtitle={t('cashFlow.subtitle')}
      action={netAction}
    >
      <Box component="p" sx={visuallyHidden}>
        {t('cashFlow.accessibleSummary', { summary: accessibleSummary })}
      </Box>

      {/* Definite height: a standalone full-width card has no sibling to size
          against, so a flex:1 box would collapse the ResponsiveContainer (ADR-166). */}
      <Box aria-hidden sx={{ height: CHART_HEIGHT, width: '100%' }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            barGap={4}
            barCategoryGap="24%"
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
              width={52}
              tickFormatter={(value) => formatCompactAxis(asNumber(value), currency)}
            />
            <Tooltip
              cursor={{ fill: theme.palette.action.hover }}
              formatter={(value, name) => [
                formatCurrency(asNumber(value), currency),
                name === 'income' ? t('cashFlow.income') : t('cashFlow.expenses'),
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
            <Legend
              formatter={(value) =>
                value === 'income' ? t('cashFlow.income') : t('cashFlow.expenses')
              }
              wrapperStyle={{ fontSize: 12.5, color: axisColor }}
            />
            <Bar
              dataKey="income"
              fill={incomeColor}
              radius={[4, 4, 0, 0]}
              maxBarSize={20}
              isAnimationActive={false}
            />
            <Bar
              dataKey="expenses"
              fill={expenseColor}
              radius={[4, 4, 0, 0]}
              maxBarSize={20}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </Box>
    </SectionCard>
  )
}

export default CashFlowChart
