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
 * none apply, the calm empty state shows (ADR-037). Localized via the `insights`
 * namespace (ADR-100/101): the eyebrow labels and sentence templates are
 * translated and the dynamic facts are interpolated (ADR-061), with the category
 * label resolved through the shared `categoryLabel` map (ADR-103).
 */

import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import Box from '@mui/material/Box'
import Skeleton from '@mui/material/Skeleton'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import {
  formatARS,
  formatCurrency,
  formatDelta,
  formatDispDate,
  formatUSD,
  fxSourceLabel,
} from '../../lib/format'
import { localizedIsoDate } from '../../i18n/locale'
import { todayIsoDate } from '../transactions/useAddEditFormState'
import { useDisplayMoney } from '../settings/displayCurrencyContext'
import { categoryLabel } from '../transactions/presentation'
import type {
  MonthlyInsights,
  UpcomingCardDueFact,
} from '../../api/insightsClient'
import { SectionCard } from '../../components/SectionCard'

/** Insight kinds, used to key the redundant dot color beside each label. */
type InsightKind = 'spending' | 'recurring' | 'projection' | 'fx' | 'cardDue'

/** Dot token per insight kind — a redundant cue beside the text label. */
const KIND_DOT: Record<InsightKind, string> = {
  spending: 'var(--mg-watch)',
  recurring: 'var(--mg-text-2)',
  projection: 'var(--mg-safe)',
  fx: 'var(--mg-gold)',
  cardDue: 'var(--mg-gold)',
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
/**
 * The native amounts segment for a card-due row, e.g. "ARS 12.450 / USD 230".
 * Each currency is shown in its NATIVE figure via {@link formatCurrency} — never
 * summed or converted (ADR-133/192). Only a non-zero currency contributes, so an
 * ARS-only due shows just the ARS part and a USD-only due just the USD part; a
 * mixed due shows both, ARS first (matching the app's "USD in / ARS out" split).
 */
function cardDueAmounts(entry: UpcomingCardDueFact): string {
  const parts: string[] = []
  if (entry.ars !== 0) parts.push(formatCurrency(entry.ars, 'ARS'))
  if (entry.usd !== 0) parts.push(formatCurrency(entry.usd, 'USD'))
  return parts.join(' / ')
}

function composeInsightRows(
  insights: MonthlyInsights,
  formatMoney: (ars: number | null | undefined) => string,
  t: TFunction<'insights'>,
  today: string,
): InsightRowData[] {
  const rows: InsightRowData[] = []

  const {
    topCategoryMover,
    recurring,
    savings,
    latestUsdInvoice,
    upcomingCardDue,
  } = insights

  if (topCategoryMover) {
    rows.push({
      id: 'spending',
      kind: 'spending',
      label: t('labels.spending'),
      // Category label localized via the shared resolver (ADR-103); the
      // sentence is built from the template by interpolation (ADR-061).
      text: t('spending.up', {
        category: categoryLabel(topCategoryMover.category),
        delta: formatDelta(topCategoryMover.deltaPct),
      }),
    })
  }

  if (recurring) {
    rows.push({
      id: 'recurring',
      kind: 'recurring',
      label: t('labels.recurring'),
      // i18next plural rules pick the singular/plural template by `count`.
      text: t('recurring', {
        count: recurring.count,
        amount: formatMoney(recurring.total),
      }),
    })
  }

  // Savings carries signal only when there is a non-zero figure — a projection
  // for the current month or an actual saved amount for a past one. A month with
  // zero savings (and, with no other facts, no activity at all) pushes NO row, so
  // a genuinely empty month falls through to the calm empty state (ADR-037)
  // instead of a noisy "Saved ARS 0" line.
  if (savings.amount !== 0) {
    rows.push({
      id: 'projection',
      kind: 'projection',
      label: savings.isProjected ? t('labels.projection') : t('labels.savings'),
      text: savings.isProjected
        ? t('savings.projected', { amount: formatMoney(savings.amount) })
        : t('savings.actual', { amount: formatMoney(savings.amount) }),
    })
  }

  if (latestUsdInvoice) {
    rows.push({
      id: 'fx',
      kind: 'fx',
      label: t('labels.fx'),
      // The literal USD + ARS rate and the ISO date are formatted by the
      // shared helpers and interpolated into the localized template; the date
      // stays as-is (formatDispDate) by design.
      text: t('fx.latest', {
        usd: formatUSD(latestUsdInvoice.usd),
        source: fxSourceLabel(latestUsdInvoice.rateType),
        rate: formatARS(latestUsdInvoice.rate),
        date: formatDispDate(latestUsdInvoice.occurredOn),
      }),
    })
  }

  // Upcoming card payments (ADR-192): one calm reminder row per due date, in
  // ascending order (as delivered). A due-today entry emphasizes "today"; a
  // future entry states the localized date (ADR-102). Amounts stay NATIVE per
  // currency (no cross-currency sum); an all-zero entry carries no signal and
  // is skipped. Reuses the same row pattern — a reminder, not an error banner.
  if (upcomingCardDue) {
    for (const entry of upcomingCardDue) {
      const amounts = cardDueAmounts(entry)
      if (amounts.length === 0) continue
      const isToday = entry.dueDate === today
      rows.push({
        id: `card-due-${entry.dueDate}`,
        kind: 'cardDue',
        label: t('labels.cardDue'),
        text: isToday
          ? t('cardDue.today', { amounts })
          : t('cardDue.upcoming', {
              amounts,
              date: localizedIsoDate(entry.dueDate),
            }),
      })
    }
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
  const { t } = useTranslation('insights')
  const formatMoney = useDisplayMoney()

  if (loading || !insights) {
    return (
      <SectionCard title={t('title')}>
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

  const rows = composeInsightRows(insights, formatMoney, t, todayIsoDate())

  if (rows.length === 0) {
    return (
      <SectionCard title={t('title')}>
        <Typography sx={{ fontSize: 13.5 }} color="text.disabled">
          {t('empty')}
        </Typography>
      </SectionCard>
    )
  }

  return (
    <SectionCard title={t('title')}>
      <Stack spacing={2}>
        {rows.map((insight) => (
          <InsightRow key={insight.id} insight={insight} />
        ))}
      </Stack>
    </SectionCard>
  )
}

export default Insights
