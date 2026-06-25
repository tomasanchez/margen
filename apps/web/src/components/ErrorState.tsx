/**
 * <ErrorState> — a calm "can't reach the server" panel (ADR-037).
 *
 * Rendered in place of a screen's content when a data query errors (e.g. the
 * backend is down). It never crashes the app: it states the problem plainly,
 * offers a single explicit Retry action wired to the query's `refetch`, and uses
 * theme tokens so it reads coherently in both color modes. The status is carried
 * by an icon + text, not by color alone (ADR-019 / HIG).
 *
 * One shared component so the later real-data features (#6/#7/#8) can reuse it.
 */

import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'
import CloudOffRoundedIcon from '@mui/icons-material/CloudOffRounded'
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded'

export interface ErrorStateProps {
  /** Heading shown to the user. Defaults to a backend-unavailable message. */
  title?: string
  /** Supporting line explaining the situation and what Retry will do. */
  description?: string
  /** Label for the retry action. */
  retryLabel?: string
  /** Called when the user asks to retry (typically the query's `refetch`). */
  onRetry?: () => void
}

/**
 * A bordered, centered panel for a failed data load. Supplies sensible defaults
 * for the common "backend unreachable" case (resolved through the `common`
 * namespace); callers override the copy when a more specific message helps.
 */
export function ErrorState({
  title,
  description,
  retryLabel,
  onRetry,
}: ErrorStateProps) {
  const { t } = useTranslation('common')
  const resolvedTitle = title ?? t('errorState.title')
  const resolvedDescription = description ?? t('errorState.description')
  const resolvedRetryLabel = retryLabel ?? t('actions.retry')

  return (
    <Paper
      component="section"
      variant="outlined"
      role="alert"
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
          color: 'text.secondary',
          bgcolor: 'var(--mg-raised)',
          border: '1px solid var(--mg-border-2)',
        }}
      >
        <CloudOffRoundedIcon fontSize="small" />
      </Box>

      <Typography
        component="h2"
        sx={{ fontSize: 16, fontWeight: 600 }}
        color="text.primary"
      >
        {resolvedTitle}
      </Typography>

      <Typography
        component="p"
        sx={{ fontSize: 13.5, maxWidth: 360 }}
        color="text.secondary"
      >
        {resolvedDescription}
      </Typography>

      {onRetry ? (
        <Button
          type="button"
          variant="outlined"
          color="secondary"
          onClick={onRetry}
          startIcon={<RefreshRoundedIcon />}
          sx={{
            mt: 0.75,
            textTransform: 'none',
            fontWeight: 600,
            borderColor: 'var(--mg-border-2)',
            color: 'text.primary',
          }}
        >
          {resolvedRetryLabel}
        </Button>
      ) : null}
    </Paper>
  )
}

export default ErrorState
