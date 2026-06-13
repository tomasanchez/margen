/**
 * Home — the Margen command center (Issue #12, ADR-017/019/020).
 *
 * Composes the status hero, the four metric cards, and the section panels into
 * the concept's layout: a two-column grid (trend + breakdown on the left,
 * Monotributo + insights on the right) with recent activity full-width below;
 * everything collapses to a single column on mobile (with a 2-col metric grid).
 *
 * Server state comes from TanStack Query (useTransactions for the live month
 * figures + activity; useMonotributo / useTrend / useCategoryBreakdown /
 * useInsights for the seed-derived panels). Income/Expenses are derived from the
 * shared transactions store so Home and Transactions agree; month-over-month
 * deltas compare the current month against the previous one from the same data
 * (expenses fall back to the trend series). Each section shows a skeleton while
 * its query resolves and degrades gracefully for the ADR-020 edge cases.
 *
 * The visible page <h1> ("Your command center") names the route landmark; the
 * hero headline is a supporting statement beneath the status pill.
 */

import { useMemo } from 'react'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { visuallyHidden } from '@mui/utils'
import {
  useCategoryBreakdown,
  useInsights,
  useMonotributo,
  useTrend,
} from './queries'
import { useTransactions } from '../transactions/queries'
import {
  CURRENT_MONTH,
  deriveMonthMetrics,
  recentTransactions,
} from './homeMetrics'
import { StatusHero } from './StatusHero'
import { MetricCards } from './MetricCards'
import { SpendingTrend } from './SpendingTrend'
import { CategoryBreakdown } from './CategoryBreakdown'
import { MonotributoCard } from './MonotributoCard'
import { Insights } from './Insights'
import { RecentActivity } from './RecentActivity'

const CURRENT_MONTH_LABEL = 'June 2026'
const PREVIOUS_MONTH_LABEL = 'May'

/** Percentage change from `previous` to `current`; 0 when previous is 0. */
function pctChange(current: number, previous: number): number {
  if (previous <= 0) return 0
  return ((current - previous) / previous) * 100
}

export function HomePage() {
  const monotributoQuery = useMonotributo()
  const trendQuery = useTrend()
  const breakdownQuery = useCategoryBreakdown()
  const insightsQuery = useInsights()
  const transactionsQuery = useTransactions()

  const allTransactions = useMemo(
    () => transactionsQuery.data ?? [],
    [transactionsQuery.data],
  )

  const metrics = useMemo(
    () =>
      transactionsQuery.isPending
        ? undefined
        : deriveMonthMetrics(allTransactions, CURRENT_MONTH),
    [allTransactions, transactionsQuery.isPending],
  )

  const previousMetrics = useMemo(
    () => deriveMonthMetrics(allTransactions, 'May'),
    [allTransactions],
  )

  const recent = useMemo(
    () =>
      transactionsQuery.isPending
        ? undefined
        : recentTransactions(allTransactions),
    [allTransactions, transactionsQuery.isPending],
  )

  const invoiceCount = useMemo(
    () =>
      allTransactions.filter(
        (t) => t.kind === 'invoice' && t.month === CURRENT_MONTH,
      ).length,
    [allTransactions],
  )

  const incomeDeltaPct = metrics
    ? pctChange(metrics.income, previousMetrics.income)
    : 0

  // Expenses: prefer the trend series (current vs previous month) so the delta
  // matches the chart; fall back to the derived month totals.
  const trend = trendQuery.data
  const expenseDeltaPct = (() => {
    if (trend && trend.length >= 2) {
      const current = trend[trend.length - 1]
      const previous = trend[trend.length - 2]
      return pctChange(current.value, previous.value)
    }
    return metrics ? pctChange(metrics.expenses, previousMetrics.expenses) : 0
  })()

  return (
    <Box>
      <Typography component="h1" sx={visuallyHidden}>
        Your command center
      </Typography>

      <StatusHero
        monotributo={monotributoQuery.data}
        savings={metrics?.savings}
        expenseDeltaPct={expenseDeltaPct}
        monthLabel={CURRENT_MONTH_LABEL}
        loading={transactionsQuery.isPending || monotributoQuery.isPending}
      />

      <MetricCards
        metrics={metrics}
        monotributo={monotributoQuery.data}
        incomeDeltaPct={incomeDeltaPct}
        expenseDeltaPct={expenseDeltaPct}
        previousMonthLabel={PREVIOUS_MONTH_LABEL}
        loading={transactionsQuery.isPending || monotributoQuery.isPending}
      />

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: '1.45fr 1fr' },
          gap: { xs: 1.75, md: 2.25 },
          mb: { xs: 1.75, md: 2.25 },
          alignItems: 'start',
        }}
      >
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: { xs: 1.75, md: 2.25 },
            minWidth: 0,
          }}
        >
          <SpendingTrend trend={trend} loading={trendQuery.isPending} />
          <CategoryBreakdown
            categories={breakdownQuery.data}
            loading={breakdownQuery.isPending}
          />
        </Box>
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: { xs: 1.75, md: 2.25 },
            minWidth: 0,
          }}
        >
          <MonotributoCard
            monotributo={monotributoQuery.data}
            invoiceCount={invoiceCount}
            loading={monotributoQuery.isPending}
          />
          <Insights
            insights={insightsQuery.data}
            loading={insightsQuery.isPending}
          />
        </Box>
      </Box>

      <RecentActivity
        transactions={recent}
        loading={transactionsQuery.isPending}
      />
    </Box>
  )
}

export default HomePage
