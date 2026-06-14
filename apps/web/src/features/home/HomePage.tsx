/**
 * Home — the Margen command center (Issue #12, ADR-017/019/020).
 *
 * Composes the status hero, the four metric cards, and the section panels into
 * the concept's layout: a two-column grid (trend + breakdown on the left,
 * Monotributo + insights on the right) with recent activity full-width below;
 * everything collapses to a single column on mobile (with a 2-col metric grid).
 *
 * Server state comes from TanStack Query (useTransactions for the live month
 * figures + activity; useSummary for the real spending trend + category
 * breakdown; useMonotributo / useInsights for the still-seed-derived panels).
 * The metrics + recent activity are scoped to the SELECTED viewing month from
 * the top-bar navigator (ADR-040), filtering the real transactions by their
 * `occurredOn` year+month; income / expenses stay consistent with the
 * Transactions screen. Month-over-month deltas compare the selected month
 * against the previous calendar month from the same data. The spending trend and
 * "Where it went" cards are now real and month-reactive via `/summaries`
 * (ADR-042/043); the Insights + Monotributo panels stay mock (ADR-035). Each
 * section shows a skeleton while its query resolves, the summary cards show a
 * calm fallback if `/summaries` errors, and everything degrades gracefully for
 * the ADR-020 / empty-month edge cases.
 *
 * The visible page <h1> ("Your command center") names the route landmark; the
 * hero headline is a supporting statement beneath the status pill.
 */

import { useMemo } from 'react'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { visuallyHidden } from '@mui/utils'
import { ErrorState } from '../../components/ErrorState'
import { useInsights, useMonotributo, useSummary } from './queries'
import { useTransactions } from '../transactions/queries'
import { useViewingMonth } from '../../components/monthContext'
import {
  addMonths,
  formatViewingMonth,
  monthName,
} from '../../components/months'
import {
  deriveMonthMetrics,
  occurredInMonth,
  recentTransactions,
} from './homeMetrics'
import { StatusHero } from './StatusHero'
import { MetricCards } from './MetricCards'
import { SpendingTrend } from './SpendingTrend'
import { CategoryBreakdown } from './CategoryBreakdown'
import { MonotributoCard } from './MonotributoCard'
import { Insights } from './Insights'
import { RecentActivity } from './RecentActivity'

/** Percentage change from `previous` to `current`; 0 when previous is 0. */
function pctChange(current: number, previous: number): number {
  if (previous <= 0) return 0
  return ((current - previous) / previous) * 100
}

export function HomePage() {
  const monotributoQuery = useMonotributo()
  const insightsQuery = useInsights()
  const transactionsQuery = useTransactions()

  // The selected viewing month (top-bar navigator), shared via context (ADR-040).
  const { viewingMonth } = useViewingMonth()

  // Real spending trend + category breakdown for the selected month (ADR-043).
  // The query key includes the YYYY-MM, so navigating months refetches both.
  const summaryQuery = useSummary(viewingMonth)
  const previousMonth = useMemo(
    () => addMonths(viewingMonth, -1),
    [viewingMonth],
  )

  const monthLabel = formatViewingMonth(viewingMonth)
  // Short previous-month name for the delta captions, e.g. "May".
  const previousMonthLabel = monthName(previousMonth)

  const allTransactions = useMemo(
    () => transactionsQuery.data ?? [],
    [transactionsQuery.data],
  )

  const metrics = useMemo(
    () =>
      transactionsQuery.isPending
        ? undefined
        : deriveMonthMetrics(allTransactions, viewingMonth),
    [allTransactions, transactionsQuery.isPending, viewingMonth],
  )

  // Previous calendar month, for the month-over-month deltas (ADR-040).
  const previousMetrics = useMemo(
    () => deriveMonthMetrics(allTransactions, previousMonth),
    [allTransactions, previousMonth],
  )

  const recent = useMemo(
    () =>
      transactionsQuery.isPending
        ? undefined
        : recentTransactions(allTransactions, viewingMonth),
    [allTransactions, transactionsQuery.isPending, viewingMonth],
  )

  const invoiceCount = useMemo(
    () =>
      allTransactions.filter(
        (t) => t.kind === 'invoice' && occurredInMonth(t.occurredOn, viewingMonth),
      ).length,
    [allTransactions, viewingMonth],
  )

  const incomeDeltaPct = metrics
    ? pctChange(metrics.income, previousMetrics.income)
    : 0

  // Expenses: compare the selected month against the previous calendar month
  // from the same real data (ADR-040).
  const expenseDeltaPct = metrics
    ? pctChange(metrics.expenses, previousMetrics.expenses)
    : 0

  if (transactionsQuery.isError) {
    return (
      <Box>
        <Typography component="h1" sx={visuallyHidden}>
          Your command center
        </Typography>
        <ErrorState
          description="We couldn't reach the server to load your data. Check your connection and try again."
          onRetry={() => void transactionsQuery.refetch()}
        />
      </Box>
    )
  }

  return (
    <Box>
      <Typography component="h1" sx={visuallyHidden}>
        Your command center
      </Typography>

      <StatusHero
        monotributo={monotributoQuery.data}
        savings={metrics?.savings}
        expenseDeltaPct={expenseDeltaPct}
        monthLabel={monthLabel}
        loading={transactionsQuery.isPending || monotributoQuery.isPending}
      />

      <MetricCards
        metrics={metrics}
        monotributo={monotributoQuery.data}
        incomeDeltaPct={incomeDeltaPct}
        expenseDeltaPct={expenseDeltaPct}
        previousMonthLabel={previousMonthLabel}
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
          {summaryQuery.isError ? (
            <ErrorState
              title="Spending data unavailable"
              description="We couldn't load this month's spending trend and breakdown. Try again."
              onRetry={() => void summaryQuery.refetch()}
            />
          ) : (
            <>
              <SpendingTrend
                trend={summaryQuery.data?.trend}
                loading={summaryQuery.isPending}
              />
              <CategoryBreakdown
                categories={summaryQuery.data?.categories}
                loading={summaryQuery.isPending}
              />
            </>
          )}
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
