/**
 * Projection breakdown — "The projection, broken down" (ADR-023).
 *
 * A short definition-style list of the linear pace inputs (invoiced to date,
 * monthly average, projected 12-mo total, lands-in category) followed by a
 * note on the fee impact. When the pace projects a move to another category the
 * note shows the fee delta and which category easing the pace would keep; when
 * the projection stays in the current category (e.g. already in the lowest band
 * A) it reassures with no fee delta and never invents a lower band. Period and
 * category labels are derived from the standing — nothing is hardcoded. The
 * projection is illustrative only — labeled as a pace estimate, not a guarantee.
 */

import { Trans, useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { monoFontFamily } from '../../theme'
import { formatCurrency } from '../../lib/format'
import type { MonotributoProjection } from '../../mock/types'
import { SectionCard } from '../../components/SectionCard'

/** One label/value row in the breakdown list. */
function Row({
  label,
  children,
  emphasis = false,
  divider = true,
}: {
  label: string
  children: React.ReactNode
  emphasis?: boolean
  divider?: boolean
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 1.5,
        py: 1.625,
        borderBottom: divider ? '1px solid var(--mg-border)' : 'none',
      }}
    >
      <Typography component="span" sx={{ fontSize: 13.5 }} color="text.secondary">
        {label}
      </Typography>
      <Box
        component="span"
        sx={{
          fontFamily: monoFontFamily,
          fontVariantNumeric: 'tabular-nums',
          fontSize: 13.5,
          color: emphasis ? 'var(--mg-watch)' : 'var(--mg-text)',
          textAlign: 'right',
        }}
      >
        {children}
      </Box>
    </Box>
  )
}

export interface ProjectionBreakdownProps {
  projection: MonotributoProjection
}

export function ProjectionBreakdown({ projection }: ProjectionBreakdownProps) {
  const { t } = useTranslation('monotributo')
  // Whether the pace projects a move OUT of the current category, and in which
  // direction the monthly fee would go. When the projection lands in the same
  // category (e.g. already in the lowest band A), there is no move and no fee
  // delta — the note reassures instead of warning, and never invents a "lower"
  // category to slow down toward.
  const movesCategory = projection.landsInCategory !== projection.currentCategory
  const feeRises = projection.projectedCuota > projection.currentCuota

  return (
    <SectionCard title={t('projection.title')}>
      <Box>
        <Row label={t('projection.invoiced', { period: projection.periodLabel })}>
          {formatCurrency(projection.invoicedToDate, 'ARS')}
        </Row>
        <Row label={t('projection.monthlyAverage')}>
          ≈ {formatCurrency(projection.monthlyAverage, 'ARS')}
        </Row>
        <Row label={t('projection.projectedTotal')} emphasis>
          ≈ {formatCurrency(projection.projectedAnnual, 'ARS')}
        </Row>
        <Row label={t('projection.landsIn')} divider={false}>
          <Box component="span" sx={{ fontFamily: 'inherit' }}>
            <Trans
              t={t}
              i18nKey="projection.landsInValue"
              values={{
                category: projection.landsInCategory,
                ceiling: projection.landsInCeilingLabel,
              }}
              components={{
                cap: <Box component="span" sx={{ color: 'var(--mg-text-3)' }} />,
              }}
            />
          </Box>
        </Row>
      </Box>

      <Box
        sx={{
          mt: 1,
          display: 'flex',
          gap: 1.25,
          p: 1.625,
          borderRadius: '11px',
          border: '1px solid var(--mg-border-2)',
          bgcolor: 'color-mix(in srgb, var(--mg-watch) 7%, transparent)',
        }}
      >
        <Box
          aria-hidden
          sx={{
            flex: 'none',
            width: 7,
            height: 7,
            mt: 0.75,
            borderRadius: '50%',
            bgcolor: 'var(--mg-watch)',
          }}
        />
        <Typography
          sx={{ fontSize: 12.5, lineHeight: 1.5, textWrap: 'pretty' }}
          color="var(--mg-text-mid)"
        >
          {movesCategory ? (
            <Trans
              t={t}
              i18nKey="projection.noteMoves"
              values={{
                projected: projection.landsInCategory,
                direction: feeRises
                  ? t('projection.directionRaises')
                  : t('projection.directionLowers'),
                from: formatCurrency(projection.currentCuota, 'ARS'),
                to: formatCurrency(projection.projectedCuota, 'ARS'),
                current: projection.currentCategory,
              }}
              components={{
                fee: (
                  <Box
                    component="span"
                    sx={{
                      fontFamily: monoFontFamily,
                      color: 'var(--mg-text)',
                    }}
                  />
                ),
              }}
            />
          ) : (
            <Trans
              t={t}
              i18nKey="projection.noteSteady"
              values={{
                current: projection.currentCategory,
                fee: formatCurrency(projection.currentCuota, 'ARS'),
              }}
              components={{
                fee: (
                  <Box
                    component="span"
                    sx={{
                      fontFamily: monoFontFamily,
                      color: 'var(--mg-text)',
                    }}
                  />
                ),
              }}
            />
          )}
        </Typography>
      </Box>
    </SectionCard>
  )
}

export default ProjectionBreakdown
