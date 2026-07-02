/**
 * FX & purchasing-power panel for Reports (ADR-167, ADR-168) — "USD in, ARS out".
 * Shows the average MEP rate CAPTURED at transaction time over the window (a big
 * gold mono figure, ADR-148/149 — not a live rate), an FX sparkline of the
 * per-month average captured rate, and the USD invoiced this period. The
 * inflation-adjusted "real spending" sub-panel from the concept is intentionally
 * OMITTED — it needs an inflation index that does not exist yet (deferred,
 * ADR-171); faking it would misinform.
 *
 * The MEP figure and per-month rates may be null when no month in the window has
 * a captured snapshot; the panel degrades calmly to a note rather than a 0.
 */

import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { visuallyHidden } from '@mui/utils'
import { SectionCard } from '../../components/SectionCard'
import { monoFontFamily } from '../../theme'
import { formatARS, formatUSD } from '../../lib/format'
import { sparklinePoints } from './reportsFormat'
import type { FxSummary } from '../../api/reportsClient'

export interface FxPanelProps {
  /** The FX & purchasing-power summary over the current window (ADR-169). */
  fxSummary: FxSummary
}

export function FxPanel({ fxSummary }: FxPanelProps) {
  const { t } = useTranslation('reports')
  const { avgMep, usdInvoiced, rateSeries } = fxSummary

  // Only months WITH a captured rate contribute to the sparkline; a series of
  // fewer than two points can't draw a line (the helper returns "").
  const rateValues = rateSeries
    .map((point) => point.rate)
    .filter((rate): rate is number => rate != null)
  const sparkPoints = sparklinePoints(rateValues, 100, 34)

  const accessibleSummary = t('fx.accessibleSummary', {
    mep: avgMep != null ? formatARS(avgMep) : t('fx.mepUnavailable'),
    usd: formatUSD(usdInvoiced),
  })

  return (
    <SectionCard
      title={t('fx.title')}
      subtitle={t('fx.subtitle')}
    >
      <Box component="p" sx={visuallyHidden}>
        {accessibleSummary}
      </Box>
      <Typography
        sx={{ fontSize: 12.5, lineHeight: 1.5, mb: 2.25 }}
        color="text.secondary"
      >
        {t('fx.description')}
      </Typography>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 2.25,
          flexWrap: 'wrap',
        }}
      >
        <Box sx={{ flex: 'none' }}>
          <Typography
            component="p"
            sx={{
              fontFamily: monoFontFamily,
              fontVariantNumeric: 'tabular-nums',
              fontSize: '1.375rem',
              fontWeight: 600,
              color: avgMep != null ? 'var(--mg-gold)' : 'text.disabled',
            }}
          >
            {avgMep != null ? formatARS(avgMep) : t('fx.mepUnavailable')}
          </Typography>
          <Typography sx={{ fontSize: 11, mt: 0.25 }} color="text.disabled">
            {t('fx.avgMep')}
          </Typography>
        </Box>

        {sparkPoints ? (
          <Box
            component="svg"
            viewBox="0 0 100 34"
            preserveAspectRatio="none"
            aria-hidden
            sx={{ flex: 1, minWidth: 80, height: 38, overflow: 'visible' }}
          >
            <polyline
              fill="none"
              stroke="var(--mg-gold)"
              strokeWidth={2}
              points={sparkPoints}
              vectorEffect="non-scaling-stroke"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </Box>
        ) : (
          <Box sx={{ flex: 1, minWidth: 80 }} />
        )}

        <Box sx={{ flex: 'none', textAlign: 'right' }}>
          <Typography
            component="p"
            sx={{
              fontFamily: monoFontFamily,
              fontVariantNumeric: 'tabular-nums',
              fontSize: '1rem',
              fontWeight: 600,
              color: 'text.primary',
            }}
          >
            {`USD ${formatUSD(usdInvoiced)}`}
          </Typography>
          <Typography sx={{ fontSize: 11, mt: 0.25 }} color="text.disabled">
            {t('fx.usdInvoiced')}
          </Typography>
        </Box>
      </Box>
    </SectionCard>
  )
}

export default FxPanel
