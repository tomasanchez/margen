/**
 * Insights — a compact list of real, calm observations (Issue #6, ADR-060/062).
 *
 * The structured facts from `GET /api/v1/insights` ({@link MonthlyInsights}) are
 * composed here into short, scan-friendly sentences using the es-AR formatters
 * and the display-currency preference (ADR-016/ADR-056) — the backend returns
 * facts, the frontend formats prose (ADR-061). Each row pairs a colored dot
 * (keyed to the insight kind, purely decorative) with an uppercase eyebrow label
 * and the sentence; the label carries the meaning so the dot color is never the
 * only cue (ADR-019). A row renders only when its underlying fact is present; if
 * none apply, the calm empty state shows (ADR-037). English-only.
 */

import Box from '@mui/material/Box'
import Skeleton from '@mui/material/Skeleton'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import {
  formatARS,
  formatDelta,
  formatDispDate,
  formatUSD,
  fxSourceLabel,
} from '../../lib/format'
import { useDisplayMoney } from '../settings/displayCurrencyContext'
import type { MonthlyInsights } from '../../api/insightsClient'
import { SectionCard } from '../../components/SectionCard'

/** Insight kinds, used to key the redundant dot color beside each label. */
type InsightKind = 'spending' | 'recurring' | 'projection' | 'fx'

/** Dot token per insight kind — a redundant cue beside the text label. */
const KIND_DOT: Record<InsightKind, string> = {
  spending: 'var(--mg-watch)',
  recurring: 'var(--mg-text-2)',
  projection: 'var(--mg-safe)',
  fx: 'var(--mg-gold)',
}

/** One composed insight row: a stable key, its kind, eyebrow label, and text. */
interface InsightRowData {
  id: string
  kind: InsightKind
  /** Eyebrow label, e.g. "Spending". */
  label: string
  text: string
}

export interface InsightsProps {
  insights: MonthlyInsights | undefined
  loading?: boolean
}

/**
 * Compose the structured facts into the ordered, calm sentences the card shows
 * (mover → recurring → savings → fx). Only non-null facts produce a row, so a
 * sparse month yields fewer rows and a truly empty month yields none.
 *
 * `formatMoney` is the display-currency-aware ARS formatter (ADR-056), applied
 * to the ARS money in the recurring + savings sentences so they honor the USD
 * display preference. The FX invoice keeps its literal USD + ARS rate (it states
 * the original figures, not a display-converted amount).
 */
function composeInsightRows(
  insights: MonthlyInsights,
  formatMoney: (ars: number | null | undefined) => string,
): InsightRowData[] {
  const rows: InsightRowData[] = []

  const { topCategoryMover, recurring, savings, latestUsdInvoice } = insights

  if (topCategoryMover) {
    rows.push({
      id: 'spending',
      kind: 'spending',
      label: 'Spending',
      text: `${topCategoryMover.category} is up ${formatDelta(
        topCategoryMover.deltaPct,
      )} vs last month`,
    })
  }

  if (recurring) {
    const noun = recurring.count === 1 ? 'expense' : 'expenses'
    rows.push({
      id: 'recurring',
      kind: 'recurring',
      label: 'Recurring',
      text: `${recurring.count} recurring ${noun} · ≈ ${formatMoney(
        recurring.total,
      )}`,
    })
  }

  // Savings is always present: a projection for the current month, the actual
  // saved amount for a past month.
  rows.push({
    id: 'projection',
    kind: 'projection',
    label: savings.isProjected ? 'Projection' : 'Savings',
    text: savings.isProjected
      ? `At this pace, projected savings ≈ ${formatMoney(savings.amount)}`
      : `Saved ${formatMoney(savings.amount)} this month`,
  })

  if (latestUsdInvoice) {
    rows.push({
      id: 'fx',
      kind: 'fx',
      label: 'FX',
      text: `Latest invoice · USD ${formatUSD(
        latestUsdInvoice.usd,
      )} at ${fxSourceLabel(latestUsdInvoice.rateType)} ${formatARS(
        latestUsdInvoice.rate,
      )} · ${formatDispDate(latestUsdInvoice.occurredOn)}`,
    })
  }

  return rows
}

function InsightRow({ insight }: { insight: InsightRowData }) {
  return (
    <Box sx={{ display: 'flex', gap: 1.375, minWidth: 0 }}>
      <Box
        aria-hidden
        sx={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          flex: 'none',
          mt: '6px',
          bgcolor: KIND_DOT[insight.kind],
        }}
      />
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="overline" component="p" sx={{ mb: 0.375 }}>
          {insight.label}
        </Typography>
        <Typography
          sx={{ fontSize: 13.5, lineHeight: 1.45, textWrap: 'pretty' }}
          color="var(--mg-text-mid)"
        >
          {insight.text}
        </Typography>
      </Box>
    </Box>
  )
}

export function Insights({ insights, loading = false }: InsightsProps) {
  const formatMoney = useDisplayMoney()

  if (loading || !insights) {
    return (
      <SectionCard title="Insights">
        <Stack spacing={2}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Box key={i}>
              <Skeleton variant="text" width="30%" />
              <Skeleton variant="text" width="85%" />
            </Box>
          ))}
        </Stack>
      </SectionCard>
    )
  }

  const rows = composeInsightRows(insights, formatMoney)

  if (rows.length === 0) {
    return (
      <SectionCard title="Insights">
        <Typography sx={{ fontSize: 13.5 }} color="text.disabled">
          No insights yet — add a few transactions to see patterns here.
        </Typography>
      </SectionCard>
    )
  }

  return (
    <SectionCard title="Insights">
      <Stack spacing={2}>
        {rows.map((insight) => (
          <InsightRow key={insight.id} insight={insight} />
        ))}
      </Stack>
    </SectionCard>
  )
}

export default Insights
