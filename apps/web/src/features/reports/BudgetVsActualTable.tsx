/**
 * Budget-vs-actual table for Reports (ADR-163).
 *
 * An MUI table over the EXISTING budgets reader (ADR-125), reused from the same
 * client the Budgets page uses (no extra backend call, ADR-163). One row per
 * category that has a TARGET set: the localized category, the target, the actual
 * `spent`, and `remaining` (target − spent). An over-budget remaining is shown
 * with an explicit "over" word + icon, never color alone (ADR-019/HIG).
 *
 * The budgets reader already returns money in the budget's own currency (ADR-152;
 * spend from the per-transaction FX snapshot), so figures are formatted directly
 * in that period currency — there is no live-rate display conversion here (that
 * would double-convert already-converted spend). Calm states (ADR-037): skeleton
 * while loading, and an empty note when no category has a target yet.
 */

import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Skeleton from '@mui/material/Skeleton'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import Typography from '@mui/material/Typography'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import { SectionCard } from '../../components/SectionCard'
import { ErrorState } from '../../components/ErrorState'
import { categoryLabel } from '../transactions/presentation'
import { formatCurrency } from '../../lib/format'
import type { BudgetPeriod } from '../../api/budgetsClient'
import type { Currency } from '../../mock/types'

/** Parse a Decimal string to a finite number for arithmetic (0 on garbage). */
function num(value: string | null): number {
  if (value == null) return 0
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export interface BudgetVsActualTableProps {
  /** The budgets period (target/spent/remaining per category), or undefined while loading. */
  period: BudgetPeriod | undefined
  /** Whether the budgets query is pending. */
  loading?: boolean
  /** Whether the budgets query errored (renders the calm fallback). */
  isError?: boolean
  /** Retry handler for the error state. */
  onRetry?: () => void
}

/** The remaining cell: an over-budget figure is flagged with a word + icon (not color). */
function RemainingCell({
  remaining,
  currency,
}: {
  remaining: string | null
  currency: Currency
}) {
  const { t } = useTranslation('reports')
  const value = num(remaining)
  const over = value < 0
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 0.5,
        color: over ? 'var(--mg-watch)' : 'text.primary',
        fontVariantNumeric: 'tabular-nums',
        fontSize: 13,
      }}
    >
      {over ? (
        <WarningAmberRoundedIcon aria-hidden sx={{ fontSize: 14 }} />
      ) : null}
      {over
        ? t('budgets.over', { amount: formatCurrency(Math.abs(value), currency) })
        : formatCurrency(value, currency)}
    </Box>
  )
}

export function BudgetVsActualTable({
  period,
  loading = false,
  isError = false,
  onRetry,
}: BudgetVsActualTableProps) {
  const { t } = useTranslation('reports')

  // A failed query gets the calm ErrorState — not an eternal skeleton (ADR-037).
  if (isError) {
    return (
      <ErrorState
        title={t('budgets.errorTitle')}
        description={t('budgets.errorDescription')}
        onRetry={onRetry}
      />
    )
  }

  if (loading || !period) {
    return (
      <SectionCard title={t('budgets.title')} subtitle={t('budgets.subtitle')}>
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} variant="text" height={32} />
        ))}
      </SectionCard>
    )
  }

  const currency = period.currency
  // Only rows with a target are a "budget vs actual" comparison; a target-less
  // category has nothing to compare against, so it is omitted from this table.
  const rows = period.categories.filter((row) => row.target != null)

  if (rows.length === 0) {
    return (
      <SectionCard title={t('budgets.title')} subtitle={t('budgets.subtitle')}>
        <Typography sx={{ fontSize: 13.5 }} color="text.disabled" role="status">
          {t('budgets.empty')}
        </Typography>
      </SectionCard>
    )
  }

  return (
    <SectionCard title={t('budgets.title')} subtitle={t('budgets.subtitle')}>
      <TableContainer>
        <Table size="small" aria-label={t('budgets.tableAria')}>
          <TableHead>
            <TableRow>
              <TableCell>{t('budgets.colCategory')}</TableCell>
              <TableCell align="right">{t('budgets.colTarget')}</TableCell>
              <TableCell align="right">{t('budgets.colSpent')}</TableCell>
              <TableCell align="right">{t('budgets.colRemaining')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.category} hover>
                <TableCell sx={{ fontSize: 13.5 }}>
                  {categoryLabel(row.category)}
                </TableCell>
                <TableCell
                  align="right"
                  sx={{ fontVariantNumeric: 'tabular-nums', fontSize: 13 }}
                >
                  {formatCurrency(num(row.target), currency)}
                </TableCell>
                <TableCell
                  align="right"
                  sx={{ fontVariantNumeric: 'tabular-nums', fontSize: 13 }}
                >
                  {formatCurrency(num(row.spent), currency)}
                </TableCell>
                <TableCell align="right">
                  <RemainingCell remaining={row.remaining} currency={currency} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </SectionCard>
  )
}

export default BudgetVsActualTable
