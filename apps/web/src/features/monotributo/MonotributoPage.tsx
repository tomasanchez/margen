/**
 * Monotributo — limit meter, projection & the invoices behind it
 * (Issue #8, ADR-046/049/052).
 *
 * Real-data: the whole page reads ONE snapshot query
 * (`GET /api/v1/monotributo`, {@link useMonotributoSnapshot}) and derives the
 * meter standing, A–K scale, included invoices, and the projection figures from
 * it. A compact category selector PATCHes the configured category (and refetches
 * the snapshot + Home card on success); a "Compare to previous period" toggle
 * reveals the prior trailing-12-month standing alongside the current one with
 * deltas (or a calm empty state when no prior period exists). The projection is
 * a clearly-labeled estimate carrying the API's own `projectionNote` (ADR-046).
 *
 * Layout (ADR-017): a single column of stacked sections; the projection +
 * invoices sit in a two-column grid on desktop that stacks on mobile. The shell
 * (top bar, sidebar, mobile pill/FAB) is provided by AppShell — this renders
 * only the routed main content. The page shows the trailing-12-month standing
 * independently and does NOT consume the Home month navigator (ADR-040).
 *
 * The visible page <h1> ("Monotributo") names the route landmark.
 */

import { useMemo, useState } from 'react'
import Box from '@mui/material/Box'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { monoFontFamily } from '../../theme'
import { StatusPill } from '../../components/StatusPill'
import { SectionCard } from '../../components/SectionCard'
import { ErrorState } from '../../components/ErrorState'
import { formatCurrency, formatPercent } from '../../lib/format'
import { MonotributoApiError } from '../../api/monotributoClient'
import { deriveComparison } from '../../api/monotributoClient'
import {
  useMonotributoSnapshot,
  useUpdateMonotributoCategory,
} from './queries'
import { deriveProjection, standingToState } from './derive'
import { MeterHero } from './MeterHero'
import { CategoryLadder } from './CategoryLadder'
import { ProjectionBreakdown } from './ProjectionBreakdown'
import { InvoiceDrilldown } from './InvoiceDrilldown'
import { ScaleTable } from './ScaleTable'
import { MonotributoControls } from './MonotributoControls'
import { ComparisonRow } from './ComparisonRow'
import type { StatusLevel } from '../../mock/types'

/** Maps a status band to its short label word for the header pill (ADR-046). */
const STATUS_WORD: Record<StatusLevel, string> = {
  safe: 'Safe',
  watch: 'Watch',
  close: 'Close',
  over: 'Over',
  risk: 'Risk',
}

export function MonotributoPage() {
  const snapshotQuery = useMonotributoSnapshot()
  const updateCategory = useUpdateMonotributoCategory()

  // The comparison toggle is local view state (not server state, not URL state):
  // it only reveals the prior-period figures already in the snapshot (ADR-052).
  const [compare, setCompare] = useState(false)

  const snapshot = snapshotQuery.data

  // Derive every display shape from the single snapshot so a category change
  // refetches everything at once and the components keep their prototype props.
  const standing = snapshot?.current
  const monotributo = useMemo(
    () => (standing ? standingToState(standing) : undefined),
    [standing],
  )
  const projection = useMemo(
    () =>
      standing && snapshot
        ? deriveProjection(standing, snapshot.scale)
        : undefined,
    [standing, snapshot],
  )
  const comparison = useMemo(
    () => (snapshot ? deriveComparison(snapshot) : null),
    [snapshot],
  )

  // Surface an unknown-category 422 as a calm inline message; other failures
  // fall back to a generic line (the page itself stays usable).
  const categoryError =
    updateCategory.isError && updateCategory.error
      ? updateCategory.error instanceof MonotributoApiError &&
        updateCategory.error.status === 422
        ? "That category isn't recognized. Pick one from the list."
        : "We couldn't update your category. Try again."
      : null

  function handleCategoryChange(letter: string) {
    if (letter === standing?.category) return
    updateCategory.mutate({ currentCategory: letter })
  }

  if (snapshotQuery.isError) {
    return (
      <Box>
        <Typography
          component="h1"
          sx={{ fontSize: { xs: '1.25rem', md: '1.375rem' }, fontWeight: 600, mb: 2.5 }}
          color="text.primary"
        >
          Monotributo
        </Typography>
        <ErrorState
          title="Monotributo data unavailable"
          description="We couldn't load your Monotributo standing. Check your connection and try again."
          onRetry={() => void snapshotQuery.refetch()}
        />
      </Box>
    )
  }

  const ready =
    !snapshotQuery.isPending &&
    snapshot != null &&
    monotributo != null &&
    projection != null

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
          {monotributo && projection ? (
            <Typography
              component="p"
              sx={{ fontSize: 13.5, mt: 0.75 }}
              color="text.secondary"
            >
              Category{' '}
              <Box component="span" sx={{ color: 'var(--mg-text-mid)', fontWeight: 500 }}>
                {monotributo.category}
              </Box>{' '}
              · services · monthly fee{' '}
              <Box
                component="span"
                sx={{ fontFamily: monoFontFamily, color: 'var(--mg-text-mid)' }}
              >
                {formatCurrency(projection.currentCuota, 'ARS')}
              </Box>
            </Typography>
          ) : null}
        </Box>

        {ready && snapshot && standing ? (
          <MonotributoControls
            scale={snapshot.scale}
            currentCategory={standing.category}
            onCategoryChange={handleCategoryChange}
            saving={updateCategory.isPending}
            categoryError={categoryError}
            compare={compare}
            onCompareChange={setCompare}
          />
        ) : null}
      </Box>

      {!ready ? (
        <PageSkeleton />
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: { xs: 1.75, md: 2.25 } }}>
          <MeterHero monotributo={monotributo} projection={projection} />

          {compare ? (
            <ComparisonRow comparison={comparison} previous={snapshot.previous} />
          ) : null}

          <CategoryLadder
            scale={snapshot.scale}
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
              invoices={snapshot.invoices}
              annualLimit={monotributo.annualLimit}
              total={monotributo.used}
            />
          </Box>

          <ScaleTable
            scale={snapshot.scale}
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
