/**
 * Monotributo trajectory panel for Reports (ADR-167, ADR-170) — a ceiling-
 * awareness card served by the EXISTING monotributo reader (no forward
 * projection; that is deferred, ADR-170). It shows a progress track of the
 * trailing-12-month invoiced (`used`) against the current category ceiling
 * (`annualLimit`): a gold fill for the invoiced share, a ceiling marker, and — when
 * invoiced has crossed the ceiling — an over-ceiling overflow band. The invoiced /
 * ceiling figures sit below, with a Watch/OK badge (from the reader's `status`,
 * never colour alone — the badge carries a word) and a link to the planner.
 *
 * All money is native ARS (the reader's denomination); this panel does not
 * re-denominate to the display currency — the Monotributo ceiling is an AFIP-ARS
 * concept (ADR-020/046).
 */

import { useTranslation } from 'react-i18next'
import { Link } from '@tanstack/react-router'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { SectionCard } from '../../components/SectionCard'
import { monoFontFamily } from '../../theme'
import { formatCurrency, formatPercent } from '../../lib/format'
import type { MonotributoStanding, StatusLevel } from '../../mock/types'

export interface MonotributoTrajectoryProps {
  /** The current trailing-12-month standing from the monotributo reader (ADR-046). */
  standing: MonotributoStanding
}

/** Whether a status band warrants the amber "Watch" badge vs the calm "OK". */
function isWatch(status: StatusLevel): boolean {
  return status === 'watch' || status === 'close' || status === 'over'
}

export function MonotributoTrajectory({ standing }: MonotributoTrajectoryProps) {
  const { t } = useTranslation('reports')

  const { used, annualLimit, category, remaining, percentUsed, status } = standing
  const over = used > annualLimit
  const watch = isWatch(status)

  // The track scales to whichever is larger (invoiced or ceiling) plus a little
  // headroom, so the ceiling marker and any overflow band both fit.
  const scaleMax = Math.max(used, annualLimit) * 1.06 || 1
  const fillPct = Math.min((used / scaleMax) * 100, 100)
  const ceilingPct = Math.min((annualLimit / scaleMax) * 100, 100)
  const overflowPct = over ? ((used - annualLimit) / scaleMax) * 100 : 0

  return (
    <SectionCard
      highlight
      title={t('monotributo.title')}
      action={
        <Box
          component="span"
          sx={{
            fontSize: 11.5,
            fontWeight: 600,
            px: 1.375,
            py: 0.5,
            borderRadius: '20px',
            color: watch ? 'var(--mg-watch-text)' : 'var(--mg-safe-text)',
            bgcolor: watch ? 'var(--mg-watch-bg)' : 'var(--mg-safe-bg)',
          }}
        >
          {watch ? t('monotributo.watch') : t('monotributo.ok')}
        </Box>
      }
    >
      <Typography
        sx={{ fontSize: 12.5, lineHeight: 1.5, mb: 2.5 }}
        color="text.secondary"
      >
        {t('monotributo.description')}
      </Typography>

      {/* Progress track: gold fill + ceiling marker + over-ceiling overflow band. */}
      <Box
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(Math.min(percentUsed, 999))}
        aria-label={t('monotributo.meterAria', {
          percent: formatPercent(percentUsed / 100),
          category,
        })}
        sx={{
          position: 'relative',
          height: 16,
          borderRadius: '9px',
          overflow: 'hidden',
          bgcolor: 'var(--mg-raised)',
          border: '1px solid var(--mg-border-2)',
          mb: 1.5,
        }}
      >
        {over ? (
          <Box
            aria-hidden
            sx={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: `${ceilingPct}%`,
              width: `${overflowPct}%`,
              bgcolor: 'color-mix(in srgb, var(--mg-risk) 32%, transparent)',
            }}
          />
        ) : null}
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            inset: 0,
            right: 'auto',
            width: `${fillPct}%`,
            borderRadius: '9px 0 0 9px',
            backgroundImage:
              'linear-gradient(90deg, var(--mg-gold), var(--mg-gold-hover))',
            zIndex: 1,
          }}
        />
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${ceilingPct}%`,
            width: '2px',
            bgcolor: 'var(--mg-text)',
            opacity: 0.75,
            zIndex: 2,
          }}
        />
      </Box>

      {/* Legend (colour is never the only cue — each swatch is labelled). */}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.75, mb: 2 }}>
        <LegendItem swatch="gold" label={t('monotributo.legendInvoiced')} />
        <LegendItem swatch="ceiling" label={t('monotributo.legendCeiling', { category })} />
        {over ? (
          <LegendItem swatch="over" label={t('monotributo.legendOver')} />
        ) : null}
      </Box>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.375 }}>
        <FigureRow
          label={t('monotributo.invoiced')}
          value={formatCurrency(used, 'ARS')}
        />
        <FigureRow
          label={t('monotributo.ceiling', { category })}
          value={formatCurrency(annualLimit, 'ARS')}
        />
        <FigureRow
          label={over ? t('monotributo.overBy') : t('monotributo.remaining')}
          value={formatCurrency(Math.abs(remaining), 'ARS')}
          valueColor={over ? 'var(--mg-risk-text)' : 'var(--mg-safe-text)'}
        />
      </Box>

      <Box sx={{ mt: 'auto', pt: 2 }}>
        <Link
          to="/monotributo"
          style={{ color: 'var(--mg-gold)', fontSize: 13, fontWeight: 600 }}
        >
          {t('monotributo.openPlanner')}
        </Link>
      </Box>
    </SectionCard>
  )
}

/** One labelled legend swatch. */
function LegendItem({
  swatch,
  label,
}: {
  swatch: 'gold' | 'ceiling' | 'over'
  label: string
}) {
  const swatchSx =
    swatch === 'ceiling'
      ? { width: '2px', height: 12, bgcolor: 'var(--mg-text)', opacity: 0.75 }
      : {
          width: 11,
          height: 11,
          borderRadius: '3px',
          bgcolor:
            swatch === 'gold'
              ? 'var(--mg-gold)'
              : 'color-mix(in srgb, var(--mg-risk) 40%, transparent)',
        }
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.875 }}>
      <Box aria-hidden component="span" sx={{ display: 'inline-block', ...swatchSx }} />
      <Typography component="span" sx={{ fontSize: 11.5 }} color="text.secondary">
        {label}
      </Typography>
    </Box>
  )
}

/** One label / mono-value figure row. */
function FigureRow({
  label,
  value,
  valueColor = 'text.primary',
}: {
  label: string
  value: string
  valueColor?: string
}) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1.5 }}>
      <Typography component="span" sx={{ fontSize: 13 }} color="text.secondary">
        {label}
      </Typography>
      <Typography
        component="span"
        sx={{ fontFamily: monoFontFamily, fontSize: 13.5, color: valueColor }}
      >
        {value}
      </Typography>
    </Box>
  )
}

export default MonotributoTrajectory
