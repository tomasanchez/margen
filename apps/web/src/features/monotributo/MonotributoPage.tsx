/**
 * Monotributo — limit meter, projection & the invoices behind it
 * (Issue #8, ADR-012/015/017/019/020/023).
 *
 * UI-first on mock data: the meter hero, category ladder, projection breakdown,
 * invoice drilldown, and the full official AFIP/ARCA scale. Server state comes
 * from TanStack Query over the in-memory mock API — the snapshot (reused from
 * Home) plus the dedicated scale / invoices / projection queries. There is no
 * real recategorization engine; the projection is an illustrative linear pace
 * estimate (ADR-023).
 *
 * Layout (ADR-017): a single column of stacked sections; the projection +
 * invoices sit in a two-column grid on desktop that stacks on mobile. The shell
 * (top bar, sidebar, mobile pill/FAB) is provided by AppShell — this renders
 * only the routed main content.
 *
 * The visible page <h1> ("Monotributo") names the route landmark.
 */

import Box from '@mui/material/Box'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { monoFontFamily } from '../../theme'
import { StatusPill } from '../../components/StatusPill'
import { SectionCard } from '../../components/SectionCard'
import { formatCurrency, formatPercent } from '../../lib/format'
import {
  useMonotributo,
  useMonotributoInvoices,
  useMonotributoProjection,
  useMonotributoScale,
} from './queries'
import { MeterHero } from './MeterHero'
import { CategoryLadder } from './CategoryLadder'
import { ProjectionBreakdown } from './ProjectionBreakdown'
import { InvoiceDrilldown } from './InvoiceDrilldown'
import { ScaleTable } from './ScaleTable'

/** Maps a status level to its short label word for the header pill. */
const STATUS_WORD: Record<'safe' | 'watch' | 'risk', string> = {
  safe: 'Safe',
  watch: 'Watch',
  risk: 'Risk',
}

export function MonotributoPage() {
  const snapshotQuery = useMonotributo()
  const scaleQuery = useMonotributoScale()
  const invoicesQuery = useMonotributoInvoices()
  const projectionQuery = useMonotributoProjection()

  const monotributo = snapshotQuery.data
  const projection = projectionQuery.data
  const scale = scaleQuery.data
  const invoices = invoicesQuery.data

  const loading =
    snapshotQuery.isPending ||
    projectionQuery.isPending ||
    scaleQuery.isPending ||
    invoicesQuery.isPending

  return (
    <Box>
      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: { xs: 'flex-start', md: 'flex-end' },
          justifyContent: 'space-between',
          flexDirection: { xs: 'column', md: 'row' },
          gap: { xs: 1.5, md: 2.5 },
          mb: { xs: 2.5, md: 3 },
        }}
      >
        <Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
            <Typography
              component="h1"
              sx={{ fontSize: { xs: '1.25rem', md: '1.375rem' }, fontWeight: 600 }}
              color="text.primary"
            >
              Monotributo
            </Typography>
            {monotributo ? (
              <StatusPill
                status={monotributo.status}
                label={`${STATUS_WORD[monotributo.status]} · ${formatPercent(
                  monotributo.usedRatio,
                )} used`}
              />
            ) : null}
          </Box>
          {monotributo ? (
            <Typography
              component="p"
              sx={{ fontSize: 13.5, mt: 0.75 }}
              color="text.secondary"
            >
              Category{' '}
              <Box component="span" sx={{ color: 'var(--mg-text-mid)', fontWeight: 500 }}>
                {monotributo.category}
              </Box>{' '}
              · servicios · monthly cuota{' '}
              {projection ? (
                <Box
                  component="span"
                  sx={{ fontFamily: monoFontFamily, color: 'var(--mg-text-mid)' }}
                >
                  {formatCurrency(projection.currentCuota, 'ARS')}
                </Box>
              ) : null}
            </Typography>
          ) : null}
        </Box>

        {projection ? (
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: { xs: 'flex-start', md: 'flex-end' },
              px: 1.75,
              py: 1,
              borderRadius: '11px',
              border: '1px solid var(--mg-border-2)',
              bgcolor: 'var(--mg-raised)',
              flex: 'none',
              // Full width on mobile (stacked header); content-width on desktop.
              width: { xs: '100%', md: 'auto' },
            }}
          >
            <Typography
              sx={{
                fontSize: 10.5,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                fontWeight: 600,
              }}
              color="text.disabled"
            >
              Next recategorization
            </Typography>
            <Typography sx={{ fontSize: 13.5, mt: 0.25 }} color="var(--mg-text-mid)">
              {projection.nextRecategorization}{' '}
              <Box component="span" sx={{ color: 'var(--mg-text-3)' }}>
                · evaluates {projection.evaluates}
              </Box>
            </Typography>
          </Box>
        ) : null}
      </Box>

      {loading || !monotributo || !projection || !scale || !invoices ? (
        <PageSkeleton />
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: { xs: 1.75, md: 2.25 } }}>
          <MeterHero monotributo={monotributo} projection={projection} />

          <CategoryLadder
            scale={scale}
            current={monotributo.category}
            projected={projection.landsInCategory}
          />

          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', md: '1fr 1.45fr' },
              gap: { xs: 1.75, md: 2.25 },
              alignItems: 'start',
            }}
          >
            <ProjectionBreakdown projection={projection} />
            <InvoiceDrilldown
              invoices={invoices}
              annualLimit={monotributo.annualLimit}
              total={monotributo.used}
            />
          </Box>

          <ScaleTable
            scale={scale}
            current={monotributo.category}
            projected={projection.landsInCategory}
            arcaUrl={projection.arcaUrl}
          />
        </Box>
      )}
    </Box>
  )
}

/** Loading scaffold mirroring the section rhythm so the page doesn't jump. */
function PageSkeleton() {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: { xs: 1.75, md: 2.25 } }}>
      <SectionCard highlight padding={3.25}>
        <Skeleton variant="text" width="40%" height={48} />
        <Skeleton variant="rounded" height={16} sx={{ my: 2, borderRadius: '9px' }} />
        <Skeleton variant="text" width="60%" />
      </SectionCard>
      <SectionCard title="Where you land on the scale">
        <Skeleton variant="rounded" height={64} sx={{ borderRadius: '10px' }} />
      </SectionCard>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: '1fr 1.45fr' },
          gap: { xs: 1.75, md: 2.25 },
        }}
      >
        <SectionCard title="The projection, broken down">
          <Skeleton variant="text" width="80%" />
          <Skeleton variant="text" width="70%" />
          <Skeleton variant="text" width="75%" />
        </SectionCard>
        <SectionCard title="The invoices behind this">
          <Skeleton variant="text" width="90%" />
          <Skeleton variant="text" width="85%" />
          <Skeleton variant="text" width="88%" />
        </SectionCard>
      </Box>
      <SectionCard title="Monotributo 2026 — full scale">
        <Skeleton variant="rounded" height={220} sx={{ borderRadius: '13px' }} />
      </SectionCard>
    </Box>
  )
}

export default MonotributoPage
