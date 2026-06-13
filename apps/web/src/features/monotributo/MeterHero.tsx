/**
 * Meter hero — the Monotributo limit meter (ADR-019, ADR-023).
 *
 * Big mono ARS used / annual limit on the left, Safe margin-left figure on the
 * right, then a meter bar: a gold determinate fill for the used %, PLUS a hatched
 * "pace ghost" region from used%→100% representing the projected overflow at the
 * current pace. The meter carries an accessible label spelling out the % used
 * (status is never conveyed by color alone). Below the bar: "N% used" + the
 * projected-ceiling month, a divider, and the projected trailing-12-month total
 * with a dashed "Projected D" badge.
 */

import Box from '@mui/material/Box'
import Divider from '@mui/material/Divider'
import Typography from '@mui/material/Typography'
import { monoFontFamily } from '../../theme'
import { formatCurrency, formatPercent } from '../../lib/format'
import type { MonotributoProjection, MonotributoState } from '../../mock/types'
import { SectionCard } from '../../components/SectionCard'

/** Uppercase eyebrow label shared by the hero blocks. */
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
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
      {children}
    </Typography>
  )
}

export interface MeterHeroProps {
  monotributo: MonotributoState
  projection: MonotributoProjection
}

export function MeterHero({ monotributo, projection }: MeterHeroProps) {
  const ratio = Math.min(Math.max(monotributo.usedRatio, 0), 1)
  const pct = ratio * 100
  const pctLabel = formatPercent(monotributo.usedRatio)

  return (
    <SectionCard highlight padding={3.25}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 3.75,
          flexWrap: 'wrap',
        }}
      >
        <Box sx={{ minWidth: 260 }}>
          <Eyebrow>Invoiced this period · counts toward limit</Eyebrow>
          <Typography
            component="p"
            sx={{
              fontFamily: monoFontFamily,
              fontVariantNumeric: 'tabular-nums',
              fontSize: { xs: '1.875rem', md: '2.375rem' },
              fontWeight: 600,
              letterSpacing: '-0.01em',
              mt: 1.5,
              color: 'text.primary',
            }}
          >
            {formatCurrency(monotributo.used, 'ARS')}
          </Typography>
          <Typography
            component="p"
            sx={{ fontFamily: monoFontFamily, fontSize: 13, mt: 0.75 }}
            color="text.disabled"
          >
            of {formatCurrency(monotributo.annualLimit, 'ARS')} · Category{' '}
            {monotributo.category} annual limit
          </Typography>
        </Box>

        <Box sx={{ textAlign: 'right', minWidth: 0 }}>
          <Eyebrow>Margin left</Eyebrow>
          <Typography
            component="p"
            sx={{
              fontFamily: monoFontFamily,
              fontVariantNumeric: 'tabular-nums',
              fontSize: '1.625rem',
              fontWeight: 500,
              mt: 1.25,
              color: 'var(--mg-safe)',
            }}
          >
            {formatCurrency(monotributo.margin, 'ARS')}
          </Typography>
          <Typography
            component="p"
            sx={{ fontSize: 12.5, mt: 0.625 }}
            color="text.secondary"
          >
            ≈ {projection.marginMonths} months at this pace
          </Typography>
        </Box>
      </Box>

      {/* Meter: gold used-fill + hatched pace-ghost overflow region. */}
      <Box
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-label={`${pctLabel} of the Category ${monotributo.category} annual limit used`}
        sx={{
          position: 'relative',
          height: 16,
          mt: 2.75,
          borderRadius: '9px',
          overflow: 'hidden',
          bgcolor: 'var(--mg-raised)',
          border: '1px solid var(--mg-border-2)',
        }}
      >
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            inset: 0,
            right: 'auto',
            width: `${pct}%`,
            borderRadius: '9px',
            backgroundImage:
              'linear-gradient(90deg, var(--mg-gold), var(--mg-gold-hover))',
          }}
        />
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${pct}%`,
            right: 0,
            backgroundImage:
              'repeating-linear-gradient(45deg, color-mix(in srgb, var(--mg-watch) 26%, transparent), color-mix(in srgb, var(--mg-watch) 26%, transparent) 5px, color-mix(in srgb, var(--mg-watch) 9%, transparent) 5px, color-mix(in srgb, var(--mg-watch) 9%, transparent) 10px)',
          }}
        />
      </Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1.5,
          mt: 1.375,
          flexWrap: 'wrap',
        }}
      >
        <Typography
          component="span"
          sx={{ fontFamily: monoFontFamily, fontSize: 13 }}
          color="var(--mg-text-mid)"
        >
          {pctLabel} used
        </Typography>
        <Typography component="span" sx={{ fontSize: 12.5 }} color="text.secondary">
          Projected to reach the ceiling around{' '}
          <Box component="span" sx={{ color: 'var(--mg-watch)', fontWeight: 600 }}>
            {projection.ceilingMonth}
          </Box>
        </Typography>
      </Box>

      <Divider sx={{ my: 2.5, borderColor: 'var(--mg-border-2)' }} />

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2.5,
          flexWrap: 'wrap',
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontSize: 13 }} color="text.secondary">
            Projected trailing-12-month total
          </Typography>
          <Typography
            sx={{
              fontFamily: monoFontFamily,
              fontSize: 12,
              mt: 0.5,
              textWrap: 'pretty',
            }}
            color="text.disabled"
          >
            Lands in Category {projection.landsInCategory} — you'd recategorize at
            the next review.
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Box sx={{ textAlign: 'right' }}>
            <Typography
              sx={{
                fontFamily: monoFontFamily,
                fontSize: '1.375rem',
                fontWeight: 600,
                color: 'var(--mg-watch)',
              }}
            >
              {projection.projectedAnnualLabel}
            </Typography>
            <Typography sx={{ fontSize: 11.5, mt: 0.25 }} color="text.disabled">
              / yr
            </Typography>
          </Box>
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 0.375,
              px: 2,
              py: 1.25,
              borderRadius: '12px',
              border: '1px dashed var(--mg-watch)',
              bgcolor: 'color-mix(in srgb, var(--mg-watch) 7%, transparent)',
            }}
          >
            <Typography
              sx={{
                fontSize: 10,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                fontWeight: 600,
              }}
              color="text.disabled"
            >
              Projected
            </Typography>
            <Typography
              sx={{
                fontFamily: monoFontFamily,
                fontSize: '1.375rem',
                fontWeight: 600,
                color: 'var(--mg-watch)',
              }}
            >
              {projection.landsInCategory}
            </Typography>
          </Box>
        </Box>
      </Box>
    </SectionCard>
  )
}

export default MeterHero
