/**
 * <AllocationBar> — the zero-based stacked allocation bar + legend + live
 * "left to assign" readout (ADR-145, ADR-146, ADR-019).
 *
 * Visualizes how spendable income is assigned across the three groups — Needs /
 * Wants / Savings — with a trailing Unallocated segment. A live readout names
 * the zero-based state: "Left to assign", "Over-assigned", or "✓ All assigned"
 * (the state is conveyed by the label + an icon, never color alone, ADR-019).
 * The legend lists each group's amount + its share of income.
 *
 * Presentational + pure: it takes the already-derived {@link GroupAllocation},
 * {@link AllocationSegments}, and {@link LeftToAssign} (computed in `derive.ts`)
 * and renders them with theme tokens + the shared `formatCurrency`. No fetching,
 * no math beyond rounding for display.
 */

import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlineOutlined'
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked'
import ReportProblemOutlinedIcon from '@mui/icons-material/ReportProblemOutlined'
import { formatCurrency } from '../../lib/format'
import {
  groupShareOfIncome,
  type AllocationSegments,
  type BudgetGroup,
  type GroupAllocation,
  type LeftToAssign,
} from './derive'
import type { Currency } from '../../mock/types'

export interface AllocationBarProps {
  /** Per-group + total allocation (ADR-145). */
  allocation: GroupAllocation
  /** Per-segment bar widths as ratios in [0, 1]. */
  segments: AllocationSegments
  /** The live left-to-assign readout state. */
  left: LeftToAssign
  /** Spendable income as a Decimal string, or null when unset (for the % readouts). */
  incomeAmount: string | null
  /** Period currency (ARS for the MVP). */
  currency: Currency
}

/** Token color per group — gold/neutral/green, matching the comp's intent. */
const GROUP_COLOR: Record<BudgetGroup, string> = {
  needs: 'var(--mg-gold)',
  wants: 'var(--mg-text-2)',
  savings: 'var(--mg-safe)',
}

const GROUPS: readonly BudgetGroup[] = ['needs', 'wants', 'savings'] as const

export function AllocationBar({
  allocation,
  segments,
  left,
  incomeAmount,
  currency,
}: AllocationBarProps) {
  const { t } = useTranslation('budgets')

  const groupTotal: Record<BudgetGroup, number> = {
    needs: allocation.needs,
    wants: allocation.wants,
    savings: allocation.savings,
  }

  const leftColor =
    left.state === 'over'
      ? 'var(--mg-watch)'
      : left.state === 'balanced'
        ? 'var(--mg-safe)'
        : 'text.primary'

  const leftLabel =
    left.state === 'over'
      ? t('alloc.overAssigned')
      : left.state === 'balanced'
        ? t('alloc.allAssigned')
        : t('alloc.leftToAssign')

  const LeftIcon =
    left.state === 'over'
      ? ReportProblemOutlinedIcon
      : left.state === 'balanced'
        ? CheckCircleOutlineIcon
        : RadioButtonUncheckedIcon

  const formatShare = (groupValue: number): string => {
    const share = groupShareOfIncome(groupValue, incomeAmount)
    return share == null ? '—' : `${Math.round(share * 100)}%`
  }

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 1,
          mb: 1.25,
        }}
      >
        <Typography sx={{ fontSize: 13.5, fontWeight: 600 }} color="text.primary">
          {t('alloc.title')}
        </Typography>
        <Box
          sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}
          role="status"
        >
          <LeftIcon
            sx={{ fontSize: 16, color: leftColor, flex: 'none' }}
            aria-hidden
          />
          <Typography sx={{ fontSize: 12.5 }} color="text.secondary">
            {leftLabel}
          </Typography>
          {left.state !== 'balanced' ? (
            <Typography
              sx={{ fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
              color={leftColor}
            >
              {formatCurrency(left.display, currency)}
            </Typography>
          ) : null}
        </Box>
      </Box>

      {/* Stacked allocation bar. The segments are aria-hidden; the legend below
          carries the same numbers as text, so AT users get the full breakdown. */}
      <Box
        aria-hidden
        sx={{
          display: 'flex',
          height: 22,
          borderRadius: '8px',
          overflow: 'hidden',
          bgcolor: 'var(--mg-raised)',
          border: '1px solid var(--mg-border)',
        }}
      >
        {GROUPS.map((group) => (
          <Box
            key={group}
            sx={{
              width: `${segments[group] * 100}%`,
              bgcolor: GROUP_COLOR[group],
              transition: 'width 240ms ease',
              '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
            }}
          />
        ))}
      </Box>

      {/* Legend: each group's amount + share of income. */}
      <Box
        sx={{
          display: 'flex',
          gap: { xs: 2, sm: 3 },
          mt: 1.75,
          flexWrap: 'wrap',
        }}
      >
        {GROUPS.map((group) => (
          <Box key={group} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Box
              aria-hidden
              sx={{
                width: 10,
                height: 10,
                borderRadius: '3px',
                flex: 'none',
                bgcolor: GROUP_COLOR[group],
              }}
            />
            <Box>
              <Typography sx={{ fontSize: 12 }} color="text.secondary">
                {t(`alloc.group.${group}`)} · {formatShare(groupTotal[group])}
              </Typography>
              <Typography
                sx={{ fontSize: 14, fontVariantNumeric: 'tabular-nums' }}
                color="text.primary"
              >
                {formatCurrency(groupTotal[group], currency)}
              </Typography>
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

export default AllocationBar
