/**
 * Reports — the range-based freelancer-analytics surface (ADR-167…171).
 *
 * A single overview endpoint (ADR-169) drives the bulk of the page — the KPI
 * strip, cash-flow chart, category trends, and FX summary — all denominated in
 * the user's preferred display currency (ADR-168), keyed by the selected range +
 * currency so switching either refetches everything together. The Monotributo
 * trajectory reads the EXISTING monotributo snapshot (ADR-170); it is native ARS
 * and independent of the display currency.
 *
 * The analytics WINDOW (3M / 6M / 12M / YTD) lives in the URL as `?range=`
 * (ADR-167), supplied by the route; a local-state fallback keeps the page
 * renderable standalone (e.g. in tests). Each surface owns a calm loading / error
 * / empty state so one failed query never blanks the page (ADR-037). Deferred
 * panels (net worth, getting-paid, inflation-adjusted spend, PDF export) are
 * intentionally absent (ADR-171).
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from '@tanstack/react-router'
import Box from '@mui/material/Box'
import Skeleton from '@mui/material/Skeleton'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { ErrorState } from '../../components/ErrorState'
import { useDisplayCurrency } from '../settings/displayCurrencyContext'
import { useMonotributoSnapshot } from '../monotributo/queries'
import { useReportsOverview, useForwardMonotributoCuota } from './queries'
import { RangePicker } from './RangePicker'
import { KpiStrip } from './KpiStrip'
import { CashFlowChart } from './CashFlowChart'
import { CategoryTrends } from './CategoryTrends'
import { MonotributoTrajectory } from './MonotributoTrajectory'
import { FxPanel } from './FxPanel'
import { ForecastPanel } from './ForecastPanel'
import { ExportButtons } from './ExportButtons'
import { rangeMonths } from './reportsFormat'
import { DEFAULT_REPORTS_RANGE } from './reportsSearch'
import { shortMonthLabel } from '../../api/summariesClient'
import { localizeShortMonthToken } from '../../i18n/locale'
import type { ReportsRange } from '../../api/reportsClient'

export interface ReportsPageProps {
  /**
   * The analytics range, owned by the route via the URL `?range=` param
   * (ADR-167). Optional so the page stays renderable standalone in tests; a
   * local-state fallback (the default window) is used when omitted.
   */
  range?: ReportsRange
  /** Change the range — the route writes it to the URL. */
  onRangeChange?: (range: ReportsRange) => void
}

export function ReportsPage({
  range: rangeProp,
  onRangeChange,
}: ReportsPageProps = {}) {
  const { t } = useTranslation('reports')
  // The page owns its OWN range; it lives in the URL, supplied by the route. A
  // local-state fallback keeps the page renderable standalone (e.g. in tests).
  const [localRange, setLocalRange] = useState<ReportsRange>(DEFAULT_REPORTS_RANGE)
  const range = rangeProp ?? localRange
  const setRange = onRangeChange ?? setLocalRange

  // Every figure is denominated in the EFFECTIVE display currency (ADR-168):
  // USD only when USD is preferred AND a live rate resolved, else ARS. The
  // backend does the conversion via FX snapshots; the page never re-converts.
  const { effectiveCurrency } = useDisplayCurrency()
  const overviewQuery = useReportsOverview(range, effectiveCurrency)
  const monotributoQuery = useMonotributoSnapshot()
  // The forward monthly cuota the cash-flow forecast commits (ADR-177), fed to the
  // Monotributo trajectory card so its forward projection appears there. Reads the
  // SAME forecast query the panel below uses (TanStack Query dedupes by key), so no
  // extra fetch; native ARS, never re-denominated (ADR-177).
  const forwardCuota = useForwardMonotributoCuota(range)

  const overview = overviewQuery.data

  // The range label spans the cash-flow window (first → last month); the compare
  // label is the number of months the window covers.
  const rangeLabel = useMemo(() => {
    const months = overview?.cashFlow ?? []
    if (months.length === 0) return ''
    const first = localizeShortMonthToken(shortMonthLabel(months[0].month))
    const last = localizeShortMonthToken(
      shortMonthLabel(months[months.length - 1].month),
    )
    return months.length > 1 ? `${first} – ${last}` : first
  }, [overview])

  const subtitle =
    rangeLabel.length > 0
      ? t('rangeSubtitle', {
          span: rangeLabel,
          months: rangeMonths(range),
        })
      : t('subtitle')

  const netSaved = overview?.kpis.current.netSaved ?? 0

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 2,
          mb: 3,
        }}
      >
        <Box>
          <Typography
            component="h1"
            sx={{ fontSize: { xs: '1.25rem', md: '1.5rem' }, fontWeight: 600 }}
            color="text.primary"
          >
            {t('title')}
          </Typography>
          <Typography sx={{ fontSize: 14, mt: 0.5 }} color="text.secondary">
            {subtitle}
          </Typography>
        </Box>
        <RangePicker value={range} onChange={setRange} />
      </Box>

      {/* Calm unconverted note (ADR-152/168): some window rows lack a USD
          snapshot, so the USD figures may be understated. Never an error — a
          quiet line linking to the one-time FX backfill. */}
      {overview != null && overview.unconverted > 0 ? (
        <Typography
          sx={{ fontSize: 12.5, mb: 2 }}
          color="text.secondary"
          role="note"
        >
          {t('unconverted.note', { count: overview.unconverted })}{' '}
          <Link to="/settings" style={{ color: 'var(--mg-gold)', fontWeight: 600 }}>
            {t('unconverted.action')}
          </Link>
        </Typography>
      ) : null}

      <Stack spacing={2.25}>
        {/* KPI strip + overview-fed panels share one query (ADR-169). */}
        {overviewQuery.isError ? (
          <ErrorState
            title={t('overview.errorTitle')}
            description={t('overview.errorDescription')}
            onRetry={() => void overviewQuery.refetch()}
          />
        ) : overview == null ? (
          <>
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
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} variant="rounded" height={112} sx={{ borderRadius: '14px' }} />
              ))}
            </Box>
            <Skeleton variant="rounded" height={320} sx={{ borderRadius: '16px' }} />
          </>
        ) : (
          <>
            <KpiStrip kpis={overview.kpis} currency={effectiveCurrency} />

            <CashFlowChart
              cashFlow={overview.cashFlow}
              netSaved={netSaved}
              currency={effectiveCurrency}
            />

            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', md: '1.5fr 1fr' },
                gap: 2.25,
                alignItems: 'stretch',
              }}
            >
              <CategoryTrends
                trends={overview.categoryTrends}
                currency={effectiveCurrency}
              />
              {monotributoQuery.data ? (
                <MonotributoTrajectory
                  standing={monotributoQuery.data.current}
                  forwardCuota={forwardCuota}
                />
              ) : monotributoQuery.isError ? (
                <ErrorState
                  title={t('monotributo.errorTitle')}
                  description={t('monotributo.errorDescription')}
                  onRetry={() => void monotributoQuery.refetch()}
                />
              ) : (
                <Skeleton variant="rounded" height={320} sx={{ borderRadius: '16px' }} />
              )}
            </Box>

            <FxPanel fxSummary={overview.fxSummary} />
          </>
        )}

        {/* Cash-flow forecast (ADR-178): a Reports panel, owning its own async
            query + calm loading/error/empty state so a forecast failure never
            blanks the overview panels above (ADR-037/178). */}
        <ForecastPanel range={range} />

        <ExportButtons />
      </Stack>
    </Box>
  )
}

export default ReportsPage
