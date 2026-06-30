/**
 * Budget-progress card for Home (ADR-125, ADR-127, ADR-019, ADR-037).
 *
 * An incremental Home addition (ADR-127) that shows the SELECTED month's budget
 * health at a glance: total budgeted vs total spent across the categories that
 * have a target, a calm overall meter (non-color over cue, ADR-019), and the few
 * categories closest to / over their target. It is read-only — a "Manage
 * budgets →" link sends the user to the full {@link BudgetsPage} to edit.
 *
 * When no targets are set yet the card shows a neutral "set up budgets" prompt
 * (it never crashes on an all-null period). A loading skeleton and a calm error
 * fallback (ADR-037) are handled. Budgeted-vs-spent compares like with like:
 * only spend in budgeted categories counts toward the total (see `derive.ts`).
 *
 * Money arrives as Decimal strings and is parsed/derived in `derive.ts`,
 * formatted via the shared es-AR helpers (ADR-102). The card reads budgets for
 * the same month the rest of Home shows (the navigator's `YYYY-MM`).
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from '@tanstack/react-router'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { SectionCard } from '../../components/SectionCard'
import { ErrorState } from '../../components/ErrorState'
import { formatCurrency } from '../../lib/format'
import { categoryDotColor, categoryLabel } from '../transactions/presentation'
import { BudgetMeter } from '../budgets/BudgetMeter'
import {
  deriveBudgetTotals,
  deriveCategoryProgress,
  topAttentionCategories,
} from '../budgets/derive'
import type { BudgetPeriod } from '../../api/budgetsClient'

export interface BudgetProgressCardProps {
  /** The budgets period for the viewing month, or undefined while loading. */
  period: BudgetPeriod | undefined
  /** Whether the budgets query is pending. */
  loading: boolean
  /** Whether the budgets query errored (renders the calm fallback). */
  isError?: boolean
  /** Retry handler for the error state. */
  onRetry?: () => void
}

/** Neutral prompt shown when no targets are set yet for the month. */
function BudgetEmpty() {
  const { t } = useTranslation('home')
  return (
    <SectionCard title={t('budgets.title')}>
      <Typography sx={{ fontSize: 13.5, lineHeight: 1.5 }} color="text.secondary">
        {t('budgets.emptyBody')}
      </Typography>
      <Button
        component={Link}
        to="/budgets"
        variant="outlined"
        sx={{
          mt: 2,
          alignSelf: 'flex-start',
          textTransform: 'none',
          borderRadius: '10px',
          borderColor: 'var(--mg-border-2)',
          color: 'text.primary',
        }}
      >
        {t('budgets.setUp')}
      </Button>
    </SectionCard>
  )
}

export function BudgetProgressCard({
  period,
  loading,
  isError = false,
  onRetry,
}: BudgetProgressCardProps) {
  const { t } = useTranslation('home')

  const totals = useMemo(
    () => (period ? deriveBudgetTotals(period) : undefined),
    [period],
  )
  const attention = useMemo(
    () => (period ? topAttentionCategories(period, 3) : []),
    [period],
  )

  if (isError) {
    return (
      <ErrorState
        title={t('budgets.errorTitle')}
        description={t('budgets.errorDescription')}
        onRetry={onRetry}
      />
    )
  }

  if (loading || !period || !totals) {
    return (
      <SectionCard title={t('budgets.title')}>
        <Skeleton variant="text" width={180} height={36} />
        <Skeleton variant="rounded" height={10} sx={{ mt: 1.5, borderRadius: '6px' }} />
        <Skeleton variant="text" width="60%" sx={{ mt: 1.5 }} />
      </SectionCard>
    )
  }

  if (!totals.hasAnyBudget) {
    return <BudgetEmpty />
  }

  const overall = totals.budgeted > 0 ? totals.spent / totals.budgeted : 0
  const over = totals.remaining < 0

  return (
    <SectionCard
      title={t('budgets.title')}
      subtitle={t('budgets.subtitle')}
      action={
        <Button
          component={Link}
          to="/budgets"
          size="small"
          sx={{ textTransform: 'none', fontWeight: 600, minHeight: 36 }}
        >
          {t('budgets.manage')}
        </Button>
      }
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 1.5,
          mb: 0.75,
        }}
      >
        <Typography
          sx={{ fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
          color={over ? 'var(--mg-watch)' : 'text.primary'}
        >
          {t('budgets.spentOfBudgeted', {
            spent: formatCurrency(totals.spent, period.currency),
            budgeted: formatCurrency(totals.budgeted, period.currency),
          })}
        </Typography>
      </Box>

      <BudgetMeter
        ratio={Math.min(overall, 1)}
        overBudget={over}
        label={t('budgets.overallMeterAria', {
          pct: Math.round(Math.min(overall, 1) * 100),
        })}
      />

      <Typography
        sx={{ fontSize: 12.5, mt: 1 }}
        color={over ? 'var(--mg-watch)' : 'var(--mg-safe)'}
        role="status"
      >
        {over
          ? t('budgets.overBy', {
              amount: formatCurrency(Math.abs(totals.remaining), period.currency),
            })
          : t('budgets.remaining', {
              amount: formatCurrency(totals.remaining, period.currency),
            })}
      </Typography>

      {attention.length > 0 ? (
        <Box sx={{ mt: 2 }}>
          <Typography
            component="h3"
            sx={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', mb: 1 }}
            color="text.secondary"
          >
            {t('budgets.attentionTitle')}
          </Typography>
          {attention.map((line) => {
            const progress = deriveCategoryProgress(line)
            const label = categoryLabel(line.category)
            return (
              <Box
                key={line.category}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 1.5,
                  py: 0.625,
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                  <Box
                    aria-hidden
                    sx={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      flex: 'none',
                      bgcolor: categoryDotColor(line.category),
                    }}
                  />
                  <Typography sx={{ fontSize: 13 }} color="text.primary" noWrap>
                    {label}
                  </Typography>
                </Box>
                <Typography
                  sx={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums', flex: 'none' }}
                  color={progress.overBudget ? 'var(--mg-watch)' : 'text.secondary'}
                >
                  {progress.overBudget
                    ? t('budgets.attentionOver')
                    : t('budgets.attentionPct', {
                        pct: Math.round(progress.ratio * 100),
                      })}
                </Typography>
              </Box>
            )
          })}
        </Box>
      ) : null}
    </SectionCard>
  )
}

export default BudgetProgressCard
