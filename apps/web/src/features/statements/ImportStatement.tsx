/**
 * Credit-card statement import flow (ADR-078, ADR-080).
 *
 * The container that drives the multi-row import experience. A PDF picker
 * (PDF-only) uploads a statement to `POST /statements/parse`; while it parses we
 * show a calm progress state. The outcome branches:
 *
 *   - `ok`         → render the {@link StatementReviewTable} (the review surface).
 *   - `unsupported`/`unparseable`, or a 415/413/422 upload rejection → a CALM
 *     inline message (not an error screen, not a toast) explaining we couldn't
 *     read the statement and that expenses can still be added manually. The
 *     picker stays available so a different file can be tried (ADR-080/037).
 *
 * On a successful import the flow shows a calm confirmation (count imported) with
 * an explicit "Done" and "Import another" — never a timed dismissal of important
 * content (HIG). The import mutation invalidates the transactions + Home queries
 * so the new expenses appear across the app (ADR-036).
 *
 * Accessibility (ADR-019): the parse/import states are announced via `aria-live`;
 * the picker control has a visible focus state and a descriptive label; the
 * confirmation conveys success with an icon + text, not color alone.
 */

import { useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded'
import UploadFileIcon from '@mui/icons-material/UploadFile'
import {
  StatementsApiError,
  parseStatement,
  type StatementImportRequest,
  type StatementImportResult,
  type StatementParse,
} from '../../api/statementsClient'
import { StatementReviewTable } from './StatementReviewTable'
import { useImportStatement } from './queries'

/** Calm copy shown when a statement can't be read automatically (ADR-080/037). */
const GENERIC_PARSE_MESSAGE =
  "We couldn't read this statement automatically — you can still add expenses manually."

/** Calm copy for the unsupported-bank case (a recognized PDF, unknown issuer). */
const UNSUPPORTED_MESSAGE =
  "This bank isn't supported yet — you can still add expenses manually."

/**
 * Flow phase. `idle` shows the picker; `parsing` the progress state; `review`
 * the parsed table; `done` the import confirmation. A calm `fallback` message is
 * carried alongside `idle` (the picker stays usable) — it is not its own phase.
 */
type Phase =
  | { kind: 'idle' }
  | { kind: 'parsing' }
  | { kind: 'review'; parse: StatementParse }
  | { kind: 'done'; result: StatementImportResult }

export function ImportStatement() {
  const navigate = useNavigate()
  const importMutation = useImportStatement()

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  // A calm, non-blocking message shown under the picker (unsupported / failure).
  const [fallbackMessage, setFallbackMessage] = useState<string | null>(null)

  const handlePickFile = () => {
    if (phase.kind === 'parsing') return
    fileInputRef.current?.click()
  }

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setFallbackMessage(null)
    setPhase({ kind: 'parsing' })
    void parseStatement(file)
      .then((parse) => {
        if (parse.status === 'unsupported') {
          setFallbackMessage(UNSUPPORTED_MESSAGE)
          setPhase({ kind: 'idle' })
          return
        }
        if (parse.status === 'unparseable' || parse.lines.length === 0) {
          setFallbackMessage(GENERIC_PARSE_MESSAGE)
          setPhase({ kind: 'idle' })
          return
        }
        setPhase({ kind: 'review', parse })
      })
      .catch((error: unknown) => {
        // 415 / 413 / 422 (or any failure) → calm inline message; picker stays.
        setFallbackMessage(
          error instanceof StatementsApiError
            ? error.message
            : GENERIC_PARSE_MESSAGE,
        )
        setPhase({ kind: 'idle' })
      })
  }

  const handleImport = (request: StatementImportRequest) => {
    importMutation.mutate(request, {
      onSuccess: (result) => setPhase({ kind: 'done', result }),
    })
  }

  const handleImportAnother = () => {
    importMutation.reset()
    setFallbackMessage(null)
    setPhase({ kind: 'idle' })
  }

  const handleDone = () => {
    void navigate({ to: '/transactions' })
  }

  // The hidden PDF picker, rendered once and shared across the idle states.
  const hiddenPicker = (
    <Box
      component="input"
      ref={fileInputRef}
      type="file"
      accept="application/pdf"
      onChange={handleFileChange}
      aria-hidden
      tabIndex={-1}
      sx={{ display: 'none' }}
    />
  )

  return (
    <Box component="section" sx={{ maxWidth: 920, mx: 'auto' }}>
      <Box sx={{ mb: 2.5 }}>
        <Typography component="h1" sx={{ fontSize: 22, fontWeight: 600 }}>
          Import statement
        </Typography>
        <Typography sx={{ fontSize: 13.5, color: 'text.secondary', mt: 0.5 }}>
          Upload a credit-card statement PDF and review the expenses before
          importing them.
        </Typography>
      </Box>

      {phase.kind === 'done' ? (
        <Paper
          variant="outlined"
          role="status"
          aria-live="polite"
          sx={{
            p: { xs: 3.5, md: 5 },
            borderRadius: '16px',
            bgcolor: 'var(--mg-paper)',
            borderColor: 'var(--mg-border)',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 1.25,
          }}
        >
          <Box
            aria-hidden
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 48,
              height: 48,
              borderRadius: '50%',
              color: 'var(--mg-gold)',
              bgcolor: 'color-mix(in srgb, var(--mg-gold) 14%, transparent)',
            }}
          >
            <CheckCircleRoundedIcon fontSize="small" />
          </Box>
          <Typography component="h2" sx={{ fontSize: 16, fontWeight: 600 }}>
            {confirmationHeading(phase.result)}
          </Typography>
          <Typography sx={{ fontSize: 13.5, color: 'text.secondary', maxWidth: 360 }}>
            {phase.result.mergedCount > 0
              ? "They've been added to your transactions; matched charges were merged into the ones you already had."
              : "They've been added to your transactions."}
          </Typography>
          <Stack direction="row" spacing={1.25} sx={{ mt: 0.75 }}>
            <Button
              type="button"
              variant="outlined"
              color="secondary"
              onClick={handleImportAnother}
              sx={{
                textTransform: 'none',
                fontWeight: 600,
                borderColor: 'var(--mg-border-2)',
                color: 'text.primary',
              }}
            >
              Import another
            </Button>
            <Button
              type="button"
              variant="contained"
              color="primary"
              onClick={handleDone}
              sx={{ textTransform: 'none', fontWeight: 600 }}
            >
              Done
            </Button>
          </Stack>
        </Paper>
      ) : phase.kind === 'review' ? (
        <>
          <StatementReviewTable
            parse={phase.parse}
            onImport={handleImport}
            isImporting={importMutation.isPending}
          />
          {/* Calm, non-blocking import-failure notice; the table stays usable. */}
          {importMutation.isError ? (
            <Alert
              severity="error"
              variant="outlined"
              onClose={() => importMutation.reset()}
              sx={{
                mt: 2,
                borderColor: 'var(--mg-border-2)',
                '& .MuiAlert-message': { fontSize: 13 },
              }}
            >
              We couldn't import these expenses. Please try again.
            </Alert>
          ) : null}
          <Box sx={{ mt: 1.5 }}>
            <Button
              type="button"
              variant="text"
              color="secondary"
              onClick={handleImportAnother}
              disabled={importMutation.isPending}
              sx={{ px: 0, color: 'text.secondary', textTransform: 'none' }}
            >
              Upload a different statement
            </Button>
          </Box>
        </>
      ) : (
        <Paper
          variant="outlined"
          sx={{
            p: { xs: 3.5, md: 5 },
            borderRadius: '16px',
            bgcolor: 'var(--mg-paper)',
            borderColor: 'var(--mg-border)',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 1.5,
          }}
        >
          <Box
            aria-hidden
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 48,
              height: 48,
              borderRadius: '50%',
              color: 'text.secondary',
              bgcolor: 'var(--mg-raised)',
              border: '1px solid var(--mg-border-2)',
            }}
          >
            <UploadFileIcon fontSize="small" />
          </Box>
          <Typography component="h2" sx={{ fontSize: 16, fontWeight: 600 }}>
            Upload a statement PDF
          </Typography>
          <Typography
            sx={{ fontSize: 13.5, color: 'text.secondary', maxWidth: 380 }}
          >
            We'll read the expenses so you can review and import them in one go.
          </Typography>

          <Button
            type="button"
            variant="contained"
            color="primary"
            onClick={handlePickFile}
            disabled={phase.kind === 'parsing'}
            startIcon={
              phase.kind === 'parsing' ? (
                <CircularProgress size={15} thickness={5} color="inherit" />
              ) : (
                <UploadFileIcon fontSize="small" />
              )
            }
            sx={{ mt: 0.5, py: 1.25, px: 3, fontWeight: 600, textTransform: 'none' }}
          >
            {phase.kind === 'parsing'
              ? 'Reading your statement…'
              : 'Choose statement PDF'}
          </Button>

          {/* Live region so the parse state is announced to assistive tech. */}
          <Box aria-live="polite" sx={{ width: '100%' }}>
            {phase.kind === 'parsing' ? (
              <Typography sx={visuallyHiddenSx}>
                Reading your statement…
              </Typography>
            ) : null}
            {fallbackMessage ? (
              <Alert
                severity="info"
                variant="outlined"
                sx={{
                  mt: 2,
                  textAlign: 'left',
                  borderColor: 'var(--mg-border-2)',
                  '& .MuiAlert-message': { fontSize: 13 },
                }}
              >
                {fallbackMessage}
              </Alert>
            ) : null}
          </Box>
        </Paper>
      )}

      {hiddenPicker}
    </Box>
  )
}

/**
 * Build the success-confirmation heading from the split import result (ADR-086).
 * Reflects created expenses + any transactions enriched by a merge, e.g.
 * "Imported 3 expenses, merged 1 into existing transactions".
 */
function confirmationHeading(result: StatementImportResult): string {
  const { createdCount, mergedCount } = result
  const createdLabel = `Imported ${createdCount} ${
    createdCount === 1 ? 'expense' : 'expenses'
  }`
  if (mergedCount === 0) return createdLabel
  const mergedLabel = `merged ${mergedCount} into existing ${
    mergedCount === 1 ? 'transaction' : 'transactions'
  }`
  return `${createdLabel}, ${mergedLabel}`
}

/** Visually-hidden style for off-screen live-region text (mirrors @mui/utils). */
const visuallyHiddenSx = {
  border: 0,
  clip: 'rect(0 0 0 0)',
  height: '1px',
  margin: '-1px',
  overflow: 'hidden',
  padding: 0,
  position: 'absolute',
  whiteSpace: 'nowrap',
  width: '1px',
} as const

export default ImportStatement
