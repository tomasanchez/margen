/**
 * Budgets — per-category monthly targets vs actuals (ADR-125, ADR-040, ADR-037).
 *
 * For the selected month (a month navigator reusing the shared `MonthSwitcher`
 * stepper, defaulting to the current month, ADR-040), every expense category is
 * a {@link BudgetRow}: the category, an editable ARS target, the spent figure, a
 * spent/target meter with a non-color over-budget cue (ADR-019), and remaining.
 * Categories with no target show their spend plus a "set a target" affordance.
 *
 * Server state comes from TanStack Query ({@link useBudgets}, month-keyed so a
 * month switch refetches). Editing is calm: a row commits on blur/Enter and the
 * page upserts (PUT) a non-empty target or clears (DELETE) an emptied one, then
 * the budgets query — and the Home summaries family — invalidate so the page +
 * the Home card stay in sync (ADR-036/125). Per-row save state is tracked by
 * category so an in-flight write shows only on its own row (ADR-037).
 *
 * Loading shows skeleton rows, a GET failure shows the calm ErrorState with
 * retry, and the visible page <h1> ("Budgets") names the route landmark. Money
 * is parsed/derived in `derive.ts` and formatted via the shared es-AR helpers
 * (ADR-102).
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { SectionCard } from '../../components/SectionCard'
import { ErrorState } from '../../components/ErrorState'
import { MonthSwitcher } from '../../components/MonthSwitcher'
import {
  currentViewingMonth,
  type ViewingMonth,
} from '../../components/months'
import { toYearMonth } from '../home/queries'
import { formatCurrency } from '../../lib/format'
import { BudgetRow } from './BudgetRow'
import { deriveBudgetTotals } from './derive'
import {
  useBudgets,
  useClearBudgetTarget,
  useSetBudgetTarget,
} from './queries'
import type { Category } from '../../mock/types'

/** The summary header: total budgeted vs spent for the period (ADR-125). */
function PeriodSummary({
  budgeted,
  spent,
  remaining,
  overCount,
  currency,
}: {
  budgeted: number
  spent: number
  remaining: number
  overCount: number
  currency: 'ARS' | 'USD'
}) {
  const { t } = useTranslation('budgets')
  const over = remaining < 0
  return (
    <Box
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'baseline',
        gap: { xs: 1.5, sm: 3 },
        mb: 2.5,
      }}
    >
      <Box>
        <Typography sx={{ fontSize: 12.5 }} color="text.secondary">
          {t('summary.budgeted')}
        </Typography>
        <Typography
          sx={{ fontSize: 20, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
          color="text.primary"
        >
          {formatCurrency(budgeted, currency)}
        </Typography>
      </Box>
      <Box>
        <Typography sx={{ fontSize: 12.5 }} color="text.secondary">
          {t('summary.spent')}
        </Typography>
        <Typography
          sx={{ fontSize: 20, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
          color={over ? 'var(--mg-watch)' : 'text.primary'}
        >
          {formatCurrency(spent, currency)}
        </Typography>
      </Box>
      <Box>
        <Typography sx={{ fontSize: 12.5 }} color="text.secondary">
          {over ? t('summary.overLabel') : t('summary.remaining')}
        </Typography>
        <Typography
          sx={{ fontSize: 20, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
          color={over ? 'var(--mg-watch)' : 'var(--mg-safe)'}
        >
          {formatCurrency(Math.abs(remaining), currency)}
        </Typography>
      </Box>
      {overCount > 0 ? (
        <Typography
          sx={{ fontSize: 12.5, alignSelf: 'center' }}
          color="var(--mg-watch)"
          role="status"
        >
          {t('summary.overCount', { count: overCount })}
        </Typography>
      ) : null}
    </Box>
  )
}

export function BudgetsPage() {
  const { t } = useTranslation('budgets')
  // The Budgets page owns its OWN month selection (the global navigator drives
  // Home only, ADR-040), defaulting to the current real calendar month.
  const [month, setMonth] = useState<ViewingMonth>(() => currentViewingMonth())
  const yearMonth = toYearMonth(month)

  const budgetsQuery = useBudgets(yearMonth)
  const setTarget = useSetBudgetTarget()
  const clearTarget = useClearBudgetTarget()

  // Track which category's write is in flight / errored so the spinner + retry
  // hint show only on the affected row (ADR-037). Cleared on the next attempt.
  const [savingCategory, setSavingCategory] = useState<Category | null>(null)
  const [errorCategory, setErrorCategory] = useState<Category | null>(null)

  const period = budgetsQuery.data
  const totals = useMemo(
    () => (period ? deriveBudgetTotals(period) : undefined),
    [period],
  )

  const handleCommit = (category: Category, amount: string) => {
    setSavingCategory(category)
    setErrorCategory(null)
    setTarget.mutate(
      { category, month: yearMonth, amount },
      {
        onSettled: () => setSavingCategory(null),
        onError: () => setErrorCategory(category),
      },
    )
  }

  const handleClear = (category: Category) => {
    setSavingCategory(category)
    setErrorCategory(null)
    clearTarget.mutate(
      { category, month: yearMonth },
      {
        onSettled: () => setSavingCategory(null),
        onError: () => setErrorCategory(category),
      },
    )
  }

  const heading = (
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
  )

  if (budgetsQuery.isError) {
    return (
      <Box>
        {heading}
        <ErrorState
          title={t('error.title')}
          description={t('error.description')}
          onRetry={() => void budgetsQuery.refetch()}
        />
      </Box>
    )
  }

  return (
    <Box>
      {heading}

      <SectionCard title={t('list.title')} subtitle={t('list.subtitle')}>
        {budgetsQuery.isPending || !period || !totals ? (
          <Box>
            {Array.from({ length: 6 }).map((_, i) => (
              <Box key={i} sx={{ py: 1.5 }}>
                <Skeleton variant="text" width="40%" />
                <Skeleton
                  variant="rounded"
                  height={8}
                  sx={{ mt: 1, borderRadius: '5px' }}
                />
              </Box>
            ))}
          </Box>
        ) : period.categories.length === 0 ? (
          <Typography
            sx={{ fontSize: 14, py: 2 }}
            color="text.secondary"
            role="status"
          >
            {t('list.empty')}
          </Typography>
        ) : (
          <>
            <PeriodSummary
              budgeted={totals.budgeted}
              spent={totals.spent}
              remaining={totals.remaining}
              overCount={totals.overCount}
              currency={period.currency}
            />
            <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
              {period.categories.map((line) => (
                <BudgetRow
                  key={line.category}
                  line={line}
                  currency={period.currency}
                  saving={savingCategory === line.category}
                  saveError={errorCategory === line.category}
                  onCommit={(amount) => handleCommit(line.category, amount)}
                  onClear={() => handleClear(line.category)}
                />
              ))}
            </Box>
          </>
        )}
      </SectionCard>
    </Box>
  )
}

export default BudgetsPage
