/**
 * Cash-flow forecast panel for Reports (ADR-173, ADR-176, ADR-177, ADR-178).
 *
 * The Reports-panel-first surface for the schedule/commitment-driven forecast
 * (ADR-178 — no new route, no nav item). Composes the forward committed-outflow
 * chart ({@link ForecastChart}) and the upcoming-commitments / installments-tail
 * list ({@link CommitmentsList}) from a SINGLE forecast query (ADR-176), keyed by
 * the forward horizon (mapped from the page's analytics range) + the effective
 * display currency. It owns its OWN calm loading / error / empty state so a
 * forecast failure never blanks the overview panels (ADR-037/178).
 *
 * Denomination: every figure is ALREADY in the requested currency (ADR-168); this
 * panel never re-converts. The `unconverted` count surfaces a calm caveat (like the
 * other Reports panels, ADR-152/168) when a USD denomination dropped committed rows
 * for lacking an FX snapshot. The monotributo cuota is AFIP-ARS on both paths
 * (ADR-177) — its `tax` commitment is passed to the Monotributo trajectory card as
 * the forward cuota, so the forward projection appears there, not re-denominated.
 */

import { useTranslation } from 'react-i18next'
import { Link } from '@tanstack/react-router'
import Box from '@mui/material/Box'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { ErrorState } from '../../components/ErrorState'
import { useDisplayCurrency } from '../settings/displayCurrencyContext'
import { useForecast } from './queries'
import { ForecastChart } from './ForecastChart'
import { CommitmentsList } from './CommitmentsList'
import type { ReportsRange } from '../../api/reportsClient'
import { rangeToHorizon } from './reportsFormat'

export interface ForecastPanelProps {
  /** The analytics range the page owns (ADR-167); mapped to a forward horizon. */
  range: ReportsRange
}

export function ForecastPanel({ range }: ForecastPanelProps) {
  const { t } = useTranslation('reports')
  // Every figure is denominated in the EFFECTIVE display currency (ADR-168): the
  // backend converts via FX snapshots and the panel never re-converts — the same
  // source the rest of the Reports page uses.
  const { effectiveCurrency } = useDisplayCurrency()
  const horizon = rangeToHorizon(range)
  const forecastQuery = useForecast(horizon, effectiveCurrency)
  const forecast = forecastQuery.data

  return (
    <Box>
      <Typography
        component="h2"
        sx={{ fontSize: { xs: '1.05rem', md: '1.15rem' }, fontWeight: 600, mb: 0.25 }}
        color="text.primary"
      >
        {t('forecast.sectionTitle')}
      </Typography>
      <Typography sx={{ fontSize: 13, mb: 2 }} color="text.secondary">
        {t('forecast.sectionSubtitle', { months: horizon })}
      </Typography>

      {/* Calm unconverted caveat (ADR-152/168): some committed rows lack a USD
          snapshot, so the USD forecast may be understated. Never an error — a
          quiet line linking to the one-time FX backfill, matching the other panels. */}
      {forecast != null && forecast.unconverted > 0 ? (
        <Typography
          sx={{ fontSize: 12.5, mb: 2 }}
          color="text.secondary"
          role="note"
        >
          {t('forecast.unconverted', { count: forecast.unconverted })}{' '}
          <Link to="/settings" style={{ color: 'var(--mg-gold)', fontWeight: 600 }}>
            {t('unconverted.action')}
          </Link>
        </Typography>
      ) : null}

      {forecastQuery.isError ? (
        <ErrorState
          title={t('forecast.errorTitle')}
          description={t('forecast.errorDescription')}
          onRetry={() => void forecastQuery.refetch()}
        />
      ) : forecast == null ? (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', md: '1.5fr 1fr' },
            gap: 2.25,
            alignItems: 'stretch',
          }}
        >
          <Skeleton variant="rounded" height={320} sx={{ borderRadius: '16px' }} />
          <Skeleton variant="rounded" height={320} sx={{ borderRadius: '16px' }} />
        </Box>
      ) : (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', md: '1.5fr 1fr' },
            gap: 2.25,
            alignItems: 'stretch',
          }}
        >
          <ForecastChart months={forecast.months} currency={effectiveCurrency} />
          <CommitmentsList commitments={forecast.commitments} />
        </Box>
      )}
    </Box>
  )
}

export default ForecastPanel
