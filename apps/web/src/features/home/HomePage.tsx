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
 * breakdown; useMonotributo / useInsights for the Monotributo + Insights panels).
 * The metrics + recent activity are scoped to the SELECTED viewing month from
 * the top-bar navigator (ADR-040), filtering the real transactions by their
 * `occurredOn` year+month; income / expenses stay consistent with the
 * Transactions screen. Month-over-month deltas compare the selected month
 * against the previous calendar month from the same data. The spending trend and
 * "Where it went" cards are now real and month-reactive via `/summaries`
 * (ADR-042/043); the Insights panel is real and month-reactive via `/insights`
 * (ADR-061/062), and the Monotributo panel reads `/monotributo`. Each section
 * shows a skeleton while its query resolves, the summary cards show a calm
 * fallback if `/summaries` errors, and everything degrades gracefully for the
 * ADR-020 / empty-month edge cases.
 *
 * The visible page <h1> ("Your command center") names the route landmark; the
 * hero headline is a supporting statement beneath the status pill.
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { visuallyHidden } from '@mui/utils'
import { ErrorState } from '../../components/ErrorState'
import { useDisplayCurrency } from '../settings/displayCurrencyContext'
import { useMonotributoEnabled } from '../settings/queries'
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
import { NetWorthCard } from './NetWorthCard'
import { useNetWorth } from '../accounts/queries'
import { BudgetProgressCard } from './BudgetProgressCard'
import {
  useBudgetIncome,
  useBudgets,
  usePriorBudgets,
} from '../budgets/queries'
import { isRepriceRollover } from '../budgets/derive'
import { toYearMonth } from './queries'

/** Percentage change from `previous` to `current`; 0 when previous is 0. */
function pctChange(current: number, previous: number): number {
  if (previous <= 0) return 0
  return ((current - previous) / previous) * 100
}

export function HomePage() {
  const { t } = useTranslation('home')
  const monotributoQuery = useMonotributo()
  const transactionsQuery = useTransactions()
  // Net worth (ADR-122/123/127): an incremental Home addition below the hero.
  const netWorthQuery = useNetWorth()

  // Calm note when USD is preferred but the live rate couldn't be fetched, so
  // the cards + summaries fall back to ARS (ADR-056/037). Null otherwise.
  const { fallbackNote, preferredCurrency } = useDisplayCurrency()

  // The Monotributo Home card is part of the optional module (ADR-126): hide it
  // when the module is disabled. Treated as hidden until settings resolve so it
  // never flashes then disappears.
  const { enabled: monotributoEnabled } = useMonotributoEnabled()

  // The selected viewing month (top-bar navigator), shared via context (ADR-040).
  const { viewingMonth } = useViewingMonth()

  // Real spending trend + category breakdown for the selected month (ADR-043).
  // The query key includes the YYYY-MM, so navigating months refetches both.
  const summaryQuery = useSummary(viewingMonth)
  // Real, month-reactive insights for the selected month (ADR-061/062).
  const insightsQuery = useInsights(viewingMonth)
  // Budget progress for the selected month (ADR-125/127): an incremental Home
  // card; month-keyed so it tracks the navigator. The budget is denominated in
  // the INCOME's currency (ADR-156): read the income first, take its currency as
  // the budget currency (defaulting to the preferred display currency until an
  // income is set), and fetch + show everything in it — NO live-rate conversion.
  // Spend arrives in the budget currency from the backend (the per-transaction FX
  // snapshot, ADR-148/152); income is never cross-converted.
  const budgetIncomeQuery = useBudgetIncome(toYearMonth(viewingMonth))
  const budgetCurrency = budgetIncomeQuery.data?.currency ?? preferredCurrency
  const budgetsQuery = useBudgets(toYearMonth(viewingMonth), budgetCurrency)
  const previousMonth = useMemo(
    () => addMonths(viewingMonth, -1),
    [viewingMonth],
  )
  // The prior month's budgets (for the reprice-rollover nudge), month-keyed
  // (ADR-127/137), in the same budget currency.
  const priorBudgetsQuery = usePriorBudgets(
    toYearMonth(previousMonth),
    budgetCurrency,
  )
  const showRepriceNudge = useMemo(
    () => isRepriceRollover(budgetsQuery.data, priorBudgetsQuery.data),
    [budgetsQuery.data, priorBudgetsQuery.data],
  )
  // Consumed as-is (ADR-156): the period + income already arrive in the budget
  // currency, so no conversion. Income shows in its own currency, never converted.
  const budgetPeriod = budgetsQuery.data
  const budgetIncome = budgetIncomeQuery.data

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
          {t('srHeading')}
        </Typography>
        <ErrorState
          description={t('error.description')}
          onRetry={() => void transactionsQuery.refetch()}
        />
      </Box>
    )
  }

  return (
    <Box>
      <Typography component="h1" sx={visuallyHidden}>
        {t('srHeading')}
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

      {fallbackNote ? (
        <Typography
          role="status"
          sx={{ fontSize: 12.5, mt: { xs: -0.5, md: -1.5 }, mb: { xs: 2, md: 2.5 } }}
          color="text.secondary"
        >
          {fallbackNote}
        </Typography>
      ) : null}

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
          gap: { xs: 1.75, md: 2.25 },
          mb: { xs: 1.75, md: 2.25 },
          alignItems: 'start',
        }}
      >
        <NetWorthCard
          netWorth={netWorthQuery.data}
          loading={netWorthQuery.isPending}
          isError={netWorthQuery.isError}
          onRetry={() => void netWorthQuery.refetch()}
        />
        <BudgetProgressCard
          period={budgetPeriod}
          // Income shows in its own (budget) currency, never cross-converted
          // (ADR-156).
          income={budgetIncome}
          showRepriceNudge={showRepriceNudge}
          loading={budgetsQuery.isPending}
          isError={budgetsQuery.isError}
          onRetry={() => void budgetsQuery.refetch()}
        />
      </Box>

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
              title={t('error.summaryTitle')}
              description={t('error.summaryDescription')}
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
          {monotributoEnabled ? (
            <MonotributoCard
              monotributo={monotributoQuery.data}
              invoiceCount={invoiceCount}
              loading={monotributoQuery.isPending}
            />
          ) : null}
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
