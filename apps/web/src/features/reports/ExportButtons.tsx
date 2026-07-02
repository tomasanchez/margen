/**
 * CSV export buttons for Reports (ADR-165).
 *
 * Two calm download actions: the full transactions export and the current
 * month's category-summary export. Both go through the authed fetcher (the CSV
 * endpoints sit behind the bearer guard, so a plain `<a href>` 401s — ADR-165)
 * via {@link useReportDownload}, which fetches the Blob and triggers a save.
 *
 * Each button drives its OWN download hook so a slow transactions export never
 * disables the summary button; both surface a calm inline error (ADR-037) with a
 * dismiss action, never a thrown render. Filenames mirror the backend's
 * `Content-Disposition` convention so the saved file reads clearly.
 */

import { useTranslation } from 'react-i18next'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded'
import { SectionCard } from '../../components/SectionCard'
import { reportsClient } from '../../api/reportsClient'
import { useReportDownload } from './useReportDownload'

export interface ExportButtonsProps {
  /** The report month as `YYYY-MM` (drives the summary export + its filename). */
  month: string
}

export function ExportButtons({ month }: ExportButtonsProps) {
  const { t } = useTranslation('reports')
  const transactions = useReportDownload()
  const summary = useReportDownload()

  const onExportTransactions = () => {
    transactions.download(
      () => reportsClient.fetchTransactionsCsv(),
      'margen-transactions-all-all.csv',
    )
  }

  const onExportSummary = () => {
    summary.download(
      () => reportsClient.fetchSummaryCsv(month),
      `margen-summary-${month}.csv`,
    )
  }

  return (
    <SectionCard title={t('export.title')} subtitle={t('export.subtitle')}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1.5}
        sx={{ flexWrap: 'wrap' }}
      >
        <Button
          type="button"
          variant="outlined"
          color="secondary"
          startIcon={<DownloadRoundedIcon />}
          onClick={onExportTransactions}
          disabled={transactions.loading}
          sx={{ textTransform: 'none', fontWeight: 600 }}
        >
          {transactions.loading
            ? t('export.transactionsBusy')
            : t('export.transactions')}
        </Button>
        <Button
          type="button"
          variant="outlined"
          color="secondary"
          startIcon={<DownloadRoundedIcon />}
          onClick={onExportSummary}
          disabled={summary.loading}
          sx={{ textTransform: 'none', fontWeight: 600 }}
        >
          {summary.loading ? t('export.summaryBusy') : t('export.summary')}
        </Button>
      </Stack>

      {transactions.error != null || summary.error != null ? (
        <Box sx={{ mt: 1.5 }}>
          {transactions.error != null ? (
            <Alert
              severity="error"
              onClose={transactions.clearError}
              sx={{ mb: summary.error != null ? 1 : 0 }}
            >
              {t('export.error')}
            </Alert>
          ) : null}
          {summary.error != null ? (
            <Alert severity="error" onClose={summary.clearError}>
              {t('export.error')}
            </Alert>
          ) : null}
        </Box>
      ) : null}
    </SectionCard>
  )
}

export default ExportButtons
