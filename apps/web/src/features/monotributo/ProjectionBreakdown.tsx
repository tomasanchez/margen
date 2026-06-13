/**
 * Projection breakdown — "The projection, broken down" (ADR-023).
 *
 * A short definition-style list of the linear pace inputs (invoiced to date,
 * monthly average, projected 12-mo total, lands-in category) followed by an
 * amber note explaining the cuota impact of recategorizing. The projection is
 * illustrative only — labeled as a pace estimate, not a guarantee.
 */

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
  return (
    <SectionCard title="The projection, broken down">
      <Box>
        <Row label="Invoiced Jan – Jun 2026">
          {formatCurrency(projection.invoicedToDate, 'ARS')}
        </Row>
        <Row label="Monthly average">
          ≈ {formatCurrency(projection.monthlyAverage, 'ARS')}
        </Row>
        <Row label="Projected 12-mo total" emphasis>
          ≈ {formatCurrency(projection.projectedAnnual, 'ARS')}
        </Row>
        <Row label="Lands in" divider={false}>
          <Box component="span" sx={{ fontFamily: 'inherit' }}>
            Category {projection.landsInCategory}{' '}
            <Box component="span" sx={{ color: 'var(--mg-text-3)' }}>
              · tope {projection.landsInCeilingLabel}
            </Box>
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
          Moving to Category {projection.landsInCategory} raises your monthly cuota{' '}
          <Box
            component="span"
            sx={{ fontFamily: monoFontFamily, color: 'var(--mg-text)' }}
          >
            {formatCurrency(projection.currentCuota, 'ARS')} →{' '}
            {formatCurrency(projection.projectedCuota, 'ARS')}
          </Box>
          . Slowing invoicing before the June close keeps you in Category C.
        </Typography>
      </Box>
    </SectionCard>
  )
}

export default ProjectionBreakdown
