/**
 * Reports — the analytics + export surface (ADR-128, ADR-163…166).
 *
 * Composes FOUR reads over the EXISTING readers plus one net-new endpoint
 * (ADR-163), with each panel owning its own calm loading/error/empty state so one
 * failed query never blanks the page (ADR-037):
 *
 *  1. SPENDING TREND (month-over-month) — a Recharts bar chart from the summaries
 *     reader's 6-month `trend` (ADR-042), reused (no extra backend call).
 *  2. CATEGORY BREAKDOWN — an MUI table from the same summaries `categories`
 *     (category, amount, share, signed month-over-month delta).
 *  3. NET WORTH OVER TIME — a Recharts line chart from the NEW net-worth-history
 *     endpoint (ADR-164), converted client-side at the live preferred-rate MEP so
 *     the "current" point matches the Home net-worth snapshot (ADR-123).
 *  4. BUDGET VS ACTUAL — an MUI table from the budgets reader (ADR-125): target
 *     vs spent/remaining in the budget's own currency.
 *
 * Plus two CSV EXPORT buttons (transactions, category summary — ADR-165). The
 * page owns its OWN month via the URL `?month=YYYY-MM` param (ADR-040), which
 * scopes the category, budget, and summary-CSV panels; the two charts are
 * trailing windows independent of it.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { MonthSwitcher } from '../../components/MonthSwitcher'
import { currentViewingMonth, type ViewingMonth } from '../../components/months'
import { toYearMonth } from '../home/queries'
import { useSummary } from '../home/queries'
import { useBudgets, useBudgetIncome } from '../budgets/queries'
import { usePreferredRate } from '../budgets/queries'
import { useSettings } from '../settings/queries'
import { useDisplayCurrency } from '../settings/displayCurrencyContext'
import { useNetWorthHistory } from './queries'
import { SpendingTrendChart } from './SpendingTrendChart'
import { CategoryTable } from './CategoryTable'
import { NetWorthChart } from './NetWorthChart'
import { BudgetVsActualTable } from './BudgetVsActualTable'
import { ExportButtons } from './ExportButtons'
import type { DisplayCurrency } from '../../api/settingsClient'
import type { Currency } from '../../mock/types'

/** The net-worth history window: the last 12 months, ending at the current month. */
const HISTORY_MONTHS = 12

export interface ReportsPageProps {
  /**
   * The viewing month, owned by the route via the URL `?month=YYYY-MM` param
   * (ADR-040). Optional so the page stays renderable standalone in tests; a
   * local-state fallback (current month) is used when omitted.
   */
  month?: ViewingMonth
  /** Change the viewing month — the route writes it to the URL. */
  onMonthChange?: (month: ViewingMonth) => void
}

export function ReportsPage({
  month: monthProp,
  onMonthChange,
}: ReportsPageProps = {}) {
  const { t } = useTranslation('reports')
  // The page owns its OWN month (the global navigator drives Home only, ADR-040);
  // it lives in the URL, supplied by the route. A local-state fallback keeps the
  // page renderable standalone (e.g. in tests).
  const [localMonth, setLocalMonth] = useState<ViewingMonth>(() =>
    currentViewingMonth(),
  )
  const month = monthProp ?? localMonth
  const setMonth = onMonthChange ?? setLocalMonth
  const yearMonth = toYearMonth(month)

  // Reused readers (ADR-163): the summaries + budgets clients already power Home
  // and the Budgets page; the Reports panels consume the same cache.
  const summaryQuery = useSummary(month)

  // The budget is denominated in the INCOME's currency (ADR-156), NOT the ARS
  // default nor a live-rate display conversion. Mirror the Budgets page EXACTLY
  // (BudgetsPage.tsx): derive the currency from the income (falling back to the
  // preferred display currency until an income is set), then thread it through
  // `useBudgets` so target/spent/remaining all arrive in the same currency and
  // reconcile with the Budgets page for the same month.
  const { preferredCurrency } = useDisplayCurrency()
  const incomeQuery = useBudgetIncome(yearMonth)
  const budgetCurrency: Currency = incomeQuery.data?.currency ?? preferredCurrency
  const budgetsQuery = useBudgets(yearMonth, budgetCurrency)

  // The net-worth history (ADR-164) + the SAME live rate the snapshot uses
  // (preferred-rate source, ADR-151), so the converted "current" point matches
  // the Home net-worth card (ADR-123).
  const historyQuery = useNetWorthHistory(HISTORY_MONTHS)
  const rateQuery = usePreferredRate()
  const settingsQuery = useSettings()
  const displayCurrency: DisplayCurrency =
    settingsQuery.data?.preferredDisplayCurrency ?? 'ARS'
  // The rate is only needed to convert the OTHER currency; while settings/rate
  // resolve, the chart shows its skeleton (ADR-037).
  const rateLoading = rateQuery.isPending || settingsQuery.isPending

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 2,
          mb: 2.5,
        }}
      >
        <Box>
          <Typography
            component="h1"
            sx={{ fontSize: { xs: '1.25rem', md: '1.375rem' }, fontWeight: 600 }}
            color="text.primary"
          >
            {t('title')}
          </Typography>
          <Typography sx={{ fontSize: 13.5, mt: 0.25 }} color="text.secondary">
            {t('subtitle')}
          </Typography>
        </Box>
        <MonthSwitcher variant="stepper" value={month} onChange={setMonth} />
      </Box>

      <Stack spacing={2.5}>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
            gap: 2.5,
            // Stretch so the trend card matches the category card's height and
            // the bar chart fills to the card bottom (ADR-166). Card content
            // (the category table) stays top-aligned via SectionCard's flow.
            alignItems: 'stretch',
          }}
        >
          <SpendingTrendChart
            trend={summaryQuery.data?.trend}
            loading={summaryQuery.isPending}
            isError={summaryQuery.isError}
            onRetry={() => void summaryQuery.refetch()}
          />
          <CategoryTable
            categories={summaryQuery.data?.categories}
            loading={summaryQuery.isPending}
            isError={summaryQuery.isError}
            onRetry={() => void summaryQuery.refetch()}
          />
        </Box>

        <NetWorthChart
          history={historyQuery.data}
          loading={historyQuery.isPending}
          isError={historyQuery.isError}
          onRetry={() => void historyQuery.refetch()}
          displayCurrency={displayCurrency}
          rate={rateQuery.data ?? null}
          rateLoading={rateLoading}
        />

        <BudgetVsActualTable
          period={budgetsQuery.data}
          loading={budgetsQuery.isPending}
          isError={budgetsQuery.isError}
          onRetry={() => void budgetsQuery.refetch()}
        />

        <ExportButtons month={yearMonth} />
      </Stack>
    </Box>
  )
}

export default ReportsPage
