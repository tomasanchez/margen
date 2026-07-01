/**
 * One-time historical FX backfill panel (ADR-150), shown on Settings.
 *
 * Finds the signed-in user's transactions that still lack an FX snapshot
 * (no `fxSource`, ADR-148/152), and — on an explicit press — stamps each with
 * the rate that was in effect on its `occurred_on` date, using the preferred
 * rate source (ADR-151) and the client-side historical FX lookup (ADR-150). The
 * run is:
 *
 *  - GUIDED — the panel shows how many rows are unconverted before the user
 *    starts, a live "N / M" progress readout while it runs, and a calm final
 *    summary ("Converted N · M couldn't be priced");
 *  - IDEMPOTENT + RESUMABLE — it only touches rows still missing a snapshot, so
 *    a second press picks up exactly what's left (ADR-150);
 *  - CALM — a row whose rate can't be resolved is skipped (never guessed) and
 *    reported, not surfaced as an error screen (ADR-037).
 *
 * On completion the budgets + Home + transactions queries are invalidated so the
 * newly-converted USD spend appears everywhere (ADR-152). Progress is conveyed
 * by text + a determinate bar (never color alone, ADR-019); the bar respects
 * reduced motion via MUI's determinate variant. English + es-AR via i18n.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import LinearProgress from '@mui/material/LinearProgress'
import Typography from '@mui/material/Typography'
import { SectionCard } from '../../components/SectionCard'
import { useTransactions } from '../transactions/queries'
import { casaForSource } from '../transactions/captureFx'
import {
  countUnconverted,
  fillSnapshots,
  type FillProgress,
} from '../fx/fillSnapshots'
import { useSettings } from './queries'
import { budgetsKeys } from '../budgets/queries'
import { homeQueryKeys } from '../home/queries'
import { transactionsKeys } from '../transactions/queries'

/** The panel's run phase — drives which copy + controls show. */
type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; progress: FillProgress }
  | { kind: 'done'; progress: FillProgress }

export function BackfillFxPanel() {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const settingsQuery = useSettings()
  const transactionsQuery = useTransactions()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  const transactions = transactionsQuery.data ?? []
  const unconverted = countUnconverted(transactions)
  const casa = casaForSource(settingsQuery.data?.preferredRateSource)
  const running = phase.kind === 'running'

  const handleRun = async () => {
    setPhase({
      kind: 'running',
      progress: { total: unconverted, done: 0, failed: 0 },
    })
    const summary = await fillSnapshots(transactions, {
      casa,
      onProgress: (progress) => setPhase({ kind: 'running', progress }),
    })
    setPhase({ kind: 'done', progress: summary })
    // Refresh every surface that derives USD spend from the snapshot (ADR-152).
    void queryClient.invalidateQueries({ queryKey: transactionsKeys.all })
    void queryClient.invalidateQueries({ queryKey: budgetsKeys.all })
    void queryClient.invalidateQueries({ queryKey: homeQueryKeys.all })
  }

  // The progress shown: the live run, or the final summary after one.
  const progress =
    phase.kind === 'running' || phase.kind === 'done' ? phase.progress : null
  const pct =
    progress && progress.total > 0
      ? Math.round(((progress.done + progress.failed) / progress.total) * 100)
      : 0

  return (
    <SectionCard title={t('backfill.title')} subtitle={t('backfill.subtitle')}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {/* Status line: how many rows are unconverted, or the run outcome. */}
        {phase.kind === 'idle' ? (
          <Typography sx={{ fontSize: 13.5 }} color="text.secondary" role="status">
            {unconverted === 0
              ? t('backfill.allConverted')
              : t('backfill.pending', { count: unconverted })}
          </Typography>
        ) : null}

        {phase.kind === 'running' ? (
          <Box aria-live="polite">
            <Typography
              sx={{ fontSize: 13.5, fontVariantNumeric: 'tabular-nums' }}
              color="text.secondary"
            >
              {t('backfill.progress', {
                done: phase.progress.done + phase.progress.failed,
                total: phase.progress.total,
              })}
            </Typography>
            <LinearProgress
              variant="determinate"
              value={pct}
              aria-label={t('backfill.progressAria', { pct })}
              sx={{ mt: 1, borderRadius: '6px', height: 8 }}
            />
          </Box>
        ) : null}

        {phase.kind === 'done' ? (
          <Typography
            sx={{ fontSize: 13.5, fontVariantNumeric: 'tabular-nums' }}
            color="text.secondary"
            role="status"
            aria-live="polite"
          >
            {phase.progress.failed > 0
              ? t('backfill.summaryWithFailures', {
                  done: phase.progress.done,
                  failed: phase.progress.failed,
                })
              : t('backfill.summary', {
                  count: phase.progress.done,
                  done: phase.progress.done,
                })}
          </Typography>
        ) : null}

        <Box>
          <Button
            type="button"
            variant="outlined"
            color="primary"
            disabled={
              running ||
              transactionsQuery.isPending ||
              (phase.kind !== 'done' && unconverted === 0)
            }
            onClick={() => void handleRun()}
            sx={{ textTransform: 'none', fontWeight: 600 }}
          >
            {running
              ? t('backfill.running')
              : phase.kind === 'done'
                ? t('backfill.runAgain')
                : t('backfill.run')}
          </Button>
        </Box>
      </Box>
    </SectionCard>
  )
}

export default BackfillFxPanel
