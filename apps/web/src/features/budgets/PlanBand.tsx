/**
 * <PlanBand> — the "this month vs plan" band (ADR-145, ADR-019).
 *
 * Headlines the spend plan for the month: Budgeted (Σ Needs + Wants targets),
 * Spent so far, and Remaining (or Over budget), with a plan progress bar and a
 * plain-language insight line ("You're ARS X over plan — Shopping alone is ARS Y
 * over its target."). The over state is conveyed by the label + an icon beside
 * the insight, never color alone (ADR-019).
 *
 * Presentational + pure: it takes the already-derived {@link BudgetTotals} and
 * {@link PlanInsight} (computed in `derive.ts`) and renders them with theme
 * tokens + the shared `formatCurrency`. The category name in the insight is
 * localized by the caller-supplied resolver so this stays i18n-free.
 */

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlineOutlined'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import ReportProblemOutlinedIcon from '@mui/icons-material/ReportProblemOutlined'
import { SectionCard } from '../../components/SectionCard'
import { formatCurrency } from '../../lib/format'
import { categoryLabel } from '../transactions/presentation'
import { CommittedAccent } from '../home/CommittedAccent'
import type { CommittedSplit } from '../../api/committedClient'
import type { BudgetTotals, PlanInsight } from './derive'
import type { Currency } from '../../mock/types'

export interface PlanBandProps {
  /** Budgeted / spent / remaining totals over BUDGETED categories (ADR-125). */
  totals: BudgetTotals
  /** The plain-language insight result (ADR-145). */
  insight: PlanInsight
  /** Period currency (the budget currency, ADR-156). */
  currency: Currency
  /**
   * The committed-spend split for the SAME month + budget currency (ADR-179).
   * When present, a quiet accent under the Spent figure shows the paid committed
   * share (already inside the Spent total) + any pending committed outflows still
   * expected this month. Undefined → no accent. Figures already arrive in the
   * budget currency (ADR-168), so the accent never re-converts.
   */
  committed?: CommittedSplit
}

/** One labelled figure in the band header. */
function Figure({
  label,
  value,
  emphasis,
  accent,
}: {
  label: string
  value: string
  emphasis?: 'over' | 'safe'
  accent?: ReactNode
}) {
  return (
    <Box>
      <Typography
        sx={{
          fontSize: 11,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          fontWeight: 600,
        }}
        color="text.secondary"
      >
        {label}
      </Typography>
      <Typography
        sx={{ fontSize: 20, fontWeight: 700, fontVariantNumeric: 'tabular-nums', mt: 0.5 }}
        color={
          emphasis === 'over'
            ? 'var(--mg-watch)'
            : emphasis === 'safe'
              ? 'var(--mg-safe)'
              : 'text.primary'
        }
      >
        {value}
      </Typography>
      {accent ? <Box sx={{ mt: 0.5 }}>{accent}</Box> : null}
    </Box>
  )
}

export function PlanBand({ totals, insight, currency, committed }: PlanBandProps) {
  const { t } = useTranslation('budgets')
  const over = totals.remaining < 0

  // Plan progress: spent / budgeted, clamped for the bar. Over budget always
  // fills the bar and takes the Watch hue (the over state also carries a label).
  const ratio =
    totals.budgeted > 0
      ? Math.min(Math.max(totals.spent / totals.budgeted, 0), 1)
      : 0
  const barColor = over ? 'var(--mg-watch)' : 'var(--mg-safe)'

  let insightText: string
  let insightTone: 'over' | 'warn' | 'safe'
  if (insight.kind === 'over') {
    insightTone = 'over'
    insightText = t('plan.insight.over', {
      overBy: formatCurrency(insight.overBy, currency),
      category: categoryLabel(insight.topCategory),
      categoryOverBy: formatCurrency(insight.topOverBy, currency),
    })
  } else if (insight.kind === 'someOver') {
    insightTone = 'warn'
    insightText = t('plan.insight.someOver', { count: insight.count })
  } else {
    insightTone = 'safe'
    insightText = t('plan.insight.onTrack', {
      ahead: formatCurrency(insight.ahead, currency),
    })
  }

  const InsightIcon =
    insightTone === 'over'
      ? ReportProblemOutlinedIcon
      : insightTone === 'warn'
        ? InfoOutlinedIcon
        : CheckCircleOutlineIcon
  const insightColor =
    insightTone === 'over'
      ? 'var(--mg-watch)'
      : insightTone === 'warn'
        ? 'var(--mg-text-2)'
        : 'var(--mg-safe)'

  return (
    <SectionCard title={t('plan.title')} subtitle={t('plan.subtitle')}>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(3, auto) 1fr' },
          gap: { xs: 2, md: 3.5 },
          alignItems: { md: 'center' },
        }}
      >
        <Figure label={t('plan.budgeted')} value={formatCurrency(totals.budgeted, currency)} />
        <Figure
          label={t('plan.spent')}
          value={formatCurrency(totals.spent, currency)}
          // The committed split already arrives in the budget currency (ADR-168/179):
          // format it with `formatCurrency` bound to that currency — no re-conversion.
          accent={
            <CommittedAccent
              committed={committed}
              formatMoney={(amount) => formatCurrency(amount, currency)}
            />
          }
        />
        <Figure
          label={over ? t('plan.over') : t('plan.remaining')}
          value={formatCurrency(Math.abs(totals.remaining), currency)}
          emphasis={over ? 'over' : 'safe'}
        />
        <Box
          sx={{
            gridColumn: { xs: '1 / -1', md: 'auto' },
            pl: { md: 3.5 },
            borderLeft: { md: '1px solid var(--mg-border)' },
          }}
        >
          <Box
            role="meter"
            aria-valuenow={Math.round(ratio * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t('plan.meterAria', { pct: Math.round(ratio * 100) })}
            sx={{
              height: 10,
              borderRadius: '6px',
              overflow: 'hidden',
              bgcolor: 'var(--mg-raised)',
            }}
          >
            <Box
              sx={{
                height: '100%',
                width: `${(over ? 1 : ratio) * 100}%`,
                borderRadius: '6px',
                bgcolor: barColor,
                transition: 'width 240ms ease',
                '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
              }}
            />
          </Box>
          <Box sx={{ display: 'flex', gap: 1, mt: 1.25, alignItems: 'flex-start' }}>
            <InsightIcon
              sx={{ fontSize: 16, color: insightColor, flex: 'none', mt: '1px' }}
              aria-hidden
            />
            <Typography sx={{ fontSize: 12.5, lineHeight: 1.45 }} color="text.primary">
              {insightText}
            </Typography>
          </Box>
        </Box>
      </Box>
    </SectionCard>
  )
}

export default PlanBand
