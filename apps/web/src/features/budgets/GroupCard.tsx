/**
 * <GroupCard> — one Needs/Wants group card on the zero-based surface (ADR-145,
 * ADR-146).
 *
 * A bordered card grouping the categories of one spend group (Needs or Wants):
 * a header with the group name + sub-label, the group's total + share of income,
 * and a group progress bar; then the category {@link BudgetRow}s for that group.
 * The Savings group is NOT this card — it keeps the dedicated
 * {@link SavingsSection} (profiles + buckets, ADR-138).
 *
 * Presentational: it receives the group's lines + the per-category 3-month
 * averages (for the "use avg" chips, ADR-147) and the page's per-row save state,
 * and forwards the commit/clear callbacks. Color of the group dot + bar comes
 * from theme tokens (gold for Needs, neutral for Wants).
 */

import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'
import { formatCurrency } from '../../lib/format'
import { BudgetRow } from './BudgetRow'
import { groupShareOfIncome } from './derive'
import type { BudgetCategory } from '../../api/budgetsClient'
import type { Category, Currency } from '../../mock/types'

export interface GroupCardProps {
  /** Which spend group this card renders (drives the dot color + copy). */
  group: 'needs' | 'wants'
  /** The category lines belonging to this group. */
  lines: BudgetCategory[]
  /** Per-category 3-month average (Decimal string) for the "use avg" chips. */
  avgByCategory: ReadonlyMap<Category, string>
  /** The group's total target as a number (Σ of its category targets). */
  groupTotal: number
  /** Spendable income as a Decimal string, or null (for the % readout). */
  incomeAmount: string | null
  /** Period currency (ARS for the MVP). */
  currency: Currency
  /** The category whose write is in flight on this page, or null. */
  savingCategory: Category | null
  /** The category whose last write errored, or null. */
  errorCategory: Category | null
  /** Commit a category's target (raw Decimal string). */
  onCommit: (category: Category, amount: string) => void
  /** Clear a category's target. */
  onClear: (category: Category) => void
}

const GROUP_COLOR = {
  needs: 'var(--mg-gold)',
  wants: 'var(--mg-text-2)',
} as const

export function GroupCard({
  group,
  lines,
  avgByCategory,
  groupTotal,
  incomeAmount,
  currency,
  savingCategory,
  errorCategory,
  onCommit,
  onClear,
}: GroupCardProps) {
  const { t } = useTranslation('budgets')
  const share = groupShareOfIncome(groupTotal, incomeAmount)
  const pctText = share == null ? '—' : `${Math.round(share * 100)}%`

  return (
    <Paper
      component="section"
      variant="outlined"
      aria-label={t(`groups.${group}.name`)}
      sx={{
        p: 2.75,
        borderRadius: '16px',
        bgcolor: 'var(--mg-paper)',
        borderColor: 'var(--mg-border)',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 1.5,
          mb: 2,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, minWidth: 0 }}>
          <Box
            aria-hidden
            sx={{
              width: 11,
              height: 11,
              borderRadius: '3px',
              flex: 'none',
              bgcolor: GROUP_COLOR[group],
            }}
          />
          <Typography component="h2" sx={{ fontSize: 15, fontWeight: 600 }} color="text.primary">
            {t(`groups.${group}.name`)}
          </Typography>
          <Typography sx={{ fontSize: 12.5 }} color="text.disabled" noWrap>
            {t(`groups.${group}.sub`)}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Box
            aria-hidden
            sx={{
              width: 120,
              maxWidth: '30vw',
              height: 7,
              borderRadius: '5px',
              overflow: 'hidden',
              bgcolor: 'var(--mg-raised)',
            }}
          >
            <Box
              sx={{
                height: '100%',
                width: `${(share ?? 0) * 100}%`,
                borderRadius: '5px',
                bgcolor: GROUP_COLOR[group],
              }}
            />
          </Box>
          <Typography
            sx={{ fontSize: 14, fontVariantNumeric: 'tabular-nums' }}
            color="text.primary"
          >
            {formatCurrency(groupTotal, currency)}
            <Typography component="span" sx={{ fontSize: 12, ml: 0.5 }} color="text.secondary">
              · {pctText}
            </Typography>
          </Typography>
        </Box>
      </Box>

      <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
        {lines.map((line) => (
          <BudgetRow
            key={line.category}
            line={line}
            currency={currency}
            avg3mo={avgByCategory.get(line.category) ?? null}
            saving={savingCategory === line.category}
            saveError={errorCategory === line.category}
            onCommit={(amount) => onCommit(line.category, amount)}
            onClear={() => onClear(line.category)}
          />
        ))}
      </Box>
    </Paper>
  )
}

export default GroupCard
