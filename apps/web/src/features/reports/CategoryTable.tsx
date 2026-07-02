/**
 * Category-breakdown table for Reports (ADR-163).
 *
 * An MUI table over the EXISTING summaries `categories` (ADR-042), reused from
 * the same reader the Home breakdown uses (no extra backend call, ADR-163). One
 * row per category: the localized category name, the spend in the preferred
 * display currency (ADR-056), its share of the month's total, and the SIGNED
 * month-over-month delta (rises AND falls). The delta pairs its direction word +
 * icon with the explicit percentage text, never color alone (ADR-019/HIG).
 *
 * Calm states (ADR-037): a skeleton while loading, and a plain empty note when
 * the month has no spend. Money is formatted via the shared display-currency
 * formatter; the delta via {@link formatDelta}.
 */

import { useTranslation } from 'react-i18next'
import Skeleton from '@mui/material/Skeleton'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import Typography from '@mui/material/Typography'
import Box from '@mui/material/Box'
import ArrowUpwardRoundedIcon from '@mui/icons-material/ArrowUpwardRounded'
import ArrowDownwardRoundedIcon from '@mui/icons-material/ArrowDownwardRounded'
import { SectionCard } from '../../components/SectionCard'
import { useDisplayMoney } from '../settings/displayCurrencyContext'
import { categoryLabel } from '../transactions/presentation'
import { formatDelta, formatPercent } from '../../lib/format'
import type { CategorySpend } from '../../mock/types'

export interface CategoryTableProps {
  /** The month's per-category breakdown (from summaries), or undefined while loading. */
  categories: CategorySpend[] | undefined
  /** Whether the summary query is pending. */
  loading?: boolean
}

/** The signed month-over-month delta cell: icon + sign + percent (never color alone). */
function DeltaCell({ delta }: { delta: number | null | undefined }) {
  const { t } = useTranslation('reports')
  if (delta == null) {
    return (
      <Typography component="span" sx={{ fontSize: 13 }} color="text.disabled">
        {t('categories.deltaNone')}
      </Typography>
    )
  }
  const rose = delta > 0
  const fell = delta < 0
  const color = rose ? 'var(--mg-watch)' : fell ? 'success.main' : 'text.secondary'
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.5,
        color,
        fontVariantNumeric: 'tabular-nums',
        fontSize: 13,
      }}
    >
      {rose ? (
        <ArrowUpwardRoundedIcon aria-hidden sx={{ fontSize: 14 }} />
      ) : fell ? (
        <ArrowDownwardRoundedIcon aria-hidden sx={{ fontSize: 14 }} />
      ) : null}
      {formatDelta(delta)}
    </Box>
  )
}

export function CategoryTable({ categories, loading = false }: CategoryTableProps) {
  const { t } = useTranslation('reports')
  const formatMoney = useDisplayMoney()

  if (loading || !categories) {
    return (
      <SectionCard
        title={t('categories.title')}
        subtitle={t('categories.subtitle')}
      >
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} variant="text" height={32} />
        ))}
      </SectionCard>
    )
  }

  if (categories.length === 0) {
    return (
      <SectionCard
        title={t('categories.title')}
        subtitle={t('categories.subtitle')}
      >
        <Typography sx={{ fontSize: 13.5 }} color="text.disabled" role="status">
          {t('categories.empty')}
        </Typography>
      </SectionCard>
    )
  }

  return (
    <SectionCard
      title={t('categories.title')}
      subtitle={t('categories.subtitle')}
    >
      <TableContainer>
        <Table size="small" aria-label={t('categories.tableAria')}>
          <TableHead>
            <TableRow>
              <TableCell>{t('categories.colCategory')}</TableCell>
              <TableCell align="right">{t('categories.colAmount')}</TableCell>
              <TableCell align="right">{t('categories.colShare')}</TableCell>
              <TableCell align="right">{t('categories.colDelta')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {categories.map((row) => (
              <TableRow key={row.category} hover>
                <TableCell sx={{ fontSize: 13.5 }}>
                  {categoryLabel(row.category)}
                </TableCell>
                <TableCell
                  align="right"
                  sx={{ fontVariantNumeric: 'tabular-nums', fontSize: 13 }}
                >
                  {formatMoney(row.amount)}
                </TableCell>
                <TableCell
                  align="right"
                  sx={{ fontVariantNumeric: 'tabular-nums', fontSize: 13 }}
                >
                  {formatPercent(row.pct / 100)}
                </TableCell>
                <TableCell align="right">
                  <DeltaCell delta={row.deltaPct} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </SectionCard>
  )
}

export default CategoryTable
