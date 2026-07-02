/**
 * KPI strip for Reports (ADR-167) — four headline cards: Income, Expenses, Net
 * saved (the highlighted gold-tinted card), and Savings rate. Each shows a label,
 * a big mono value in the requested currency (ADR-168 — figures arrive already
 * denominated, so no conversion here), and a delta chip vs the previous window
 * (green when the move is good, amber otherwise — never colour alone: the chip
 * always carries the signed number).
 *
 * The deltas are computed from `current` vs `previous` (ADR-169) via the pure
 * {@link pctChange}/{@link deltaIsGood} helpers. A null delta (no prior base)
 * renders a calm "—" rather than a misleading ∞%.
 */

import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { SectionCard } from '../../components/SectionCard'
import { monoFontFamily } from '../../theme'
import { formatCurrency, formatDelta, MINUS, PLUS } from '../../lib/format'
import type { Currency } from '../../mock/types'
import type { ReportsKpis } from '../../api/reportsClient'
import { deltaIsGood, pctChange } from './reportsFormat'

export interface KpiStripProps {
  /** The KPI strip's current + previous windows (ADR-169). */
  kpis: ReportsKpis
  /** The denomination the figures are already in (ADR-168). */
  currency: Currency
}

/** One KPI card's resolved presentation. */
interface KpiCard {
  key: string
  label: string
  value: string
  /** Percent change vs previous, or null when there is no base. */
  delta: number | null
  /** Whether the delta's direction is the good (green) one. */
  good: boolean
  /** Percentage-point suffix for the savings-rate card, else "%". */
  pointSuffix: boolean
  highlight: boolean
}

/** A small pill carrying the signed delta + a "vs prev" caption. */
function DeltaChip({
  delta,
  good,
  pointSuffix,
}: {
  delta: number | null
  good: boolean
  pointSuffix: boolean
}) {
  const { t } = useTranslation('reports')
  const label =
    delta == null
      ? t('kpi.noDelta')
      : pointSuffix
        ? `${delta >= 0 ? PLUS : MINUS}${Math.abs(delta).toFixed(1)}${t('kpi.points')}`
        : formatDelta(delta, 1)

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 1 }}>
      <Box
        component="span"
        sx={{
          fontFamily: monoFontFamily,
          fontSize: 12,
          fontWeight: 500,
          px: 1,
          py: '2px',
          borderRadius: '6px',
          color: good ? 'var(--mg-safe-text)' : 'var(--mg-watch-text)',
          bgcolor: good ? 'var(--mg-safe-bg)' : 'var(--mg-watch-bg)',
        }}
      >
        {label}
      </Box>
      <Typography component="span" sx={{ fontSize: 12 }} color="text.disabled">
        {t('kpi.vsPrev')}
      </Typography>
    </Box>
  )
}

export function KpiStrip({ kpis, currency }: KpiStripProps) {
  const { t } = useTranslation('reports')
  const { current, previous } = kpis

  // Savings rate arrives already as a PERCENTAGE (e.g. 57.1 = 57.1%); show it
  // as a whole percent and compute its delta in percentage POINTS (not a
  // relative % change). No ×100 — the backend sends the percentage directly.
  const rateCurrent = current.savingsRate
  const ratePrevious = previous.savingsRate

  const cards: KpiCard[] = [
    {
      key: 'income',
      label: t('kpi.income'),
      value: formatCurrency(current.income, currency),
      delta: pctChange(current.income, previous.income),
      good: deltaIsGood(pctChange(current.income, previous.income), true),
      pointSuffix: false,
      highlight: false,
    },
    {
      key: 'expenses',
      label: t('kpi.expenses'),
      value: formatCurrency(current.expenses, currency),
      delta: pctChange(current.expenses, previous.expenses),
      // For expenses, DOWN is good (higherIsBetter = false).
      good: deltaIsGood(pctChange(current.expenses, previous.expenses), false),
      pointSuffix: false,
      highlight: false,
    },
    {
      key: 'netSaved',
      label: t('kpi.netSaved'),
      value: formatCurrency(current.netSaved, currency),
      delta: pctChange(current.netSaved, previous.netSaved),
      good: deltaIsGood(pctChange(current.netSaved, previous.netSaved), true),
      pointSuffix: false,
      highlight: true,
    },
    {
      key: 'savingsRate',
      label: t('kpi.savingsRate'),
      value: `${Math.round(rateCurrent)}%`,
      delta: rateCurrent - ratePrevious,
      good: rateCurrent - ratePrevious >= 0,
      pointSuffix: true,
      highlight: false,
    },
  ]

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: {
          xs: '1fr',
          sm: 'repeat(2, 1fr)',
          md: 'repeat(4, 1fr)',
        },
        gap: 2,
      }}
    >
      {cards.map((card) => (
        <SectionCard key={card.key} highlight={card.highlight} padding={2.25}>
          <Typography
            component="p"
            sx={{
              fontSize: 11.5,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              fontWeight: 600,
            }}
            color="text.disabled"
          >
            {card.label}
          </Typography>
          <Typography
            component="p"
            sx={{
              fontFamily: monoFontFamily,
              fontVariantNumeric: 'tabular-nums',
              fontSize: '1.5rem',
              fontWeight: 500,
              letterSpacing: '-0.01em',
              mt: 1.5,
              color: 'text.primary',
            }}
          >
            {card.value}
          </Typography>
          <DeltaChip delta={card.delta} good={card.good} pointSuffix={card.pointSuffix} />
        </SectionCard>
      ))}
    </Box>
  )
}

export default KpiStrip
