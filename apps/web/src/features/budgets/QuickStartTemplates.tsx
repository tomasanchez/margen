/**
 * <QuickStartTemplates> — the row of quick-start budget chips (ADR-147).
 *
 * Four one-tap templates that bulk-fill the zero-based allocation surface:
 * "50 / 30 / 20", "Match 3-mo avg", "Match last month", and "Clear all". Each
 * chip fires its callback; the page computes the target map (pure helpers in
 * `derive.ts`) and batches the existing per-category PUT/DELETE writes plus, for
 * 50/30/20, the Conservative saving profile (ADR-138).
 *
 * Presentational + calm: while a template applies, all chips disable and the
 * applying one shows a quiet spinner (ADR-037). Chips are real buttons with
 * accessible names so keyboard + AT users can apply them.
 */

import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Typography from '@mui/material/Typography'

/** The four quick-start templates (ADR-147). */
export type TemplateId = '503020' | 'avg' | 'lastMonth' | 'clear'

export interface QuickStartTemplatesProps {
  /** The template whose apply is in flight, or null when idle. */
  applying?: TemplateId | null
  /** Whether the templates are usable (an income base + categories exist). */
  disabled?: boolean
  /** Apply a template (the page computes + batches the writes). */
  onApply: (template: TemplateId) => void
}

const TEMPLATES: readonly { id: TemplateId; key: string }[] = [
  { id: '503020', key: 'templates.fiftyThirtyTwenty' },
  { id: 'avg', key: 'templates.matchAvg' },
  { id: 'lastMonth', key: 'templates.matchLastMonth' },
  { id: 'clear', key: 'templates.clearAll' },
] as const

export function QuickStartTemplates({
  applying = null,
  disabled = false,
  onApply,
}: QuickStartTemplatesProps) {
  const { t } = useTranslation('budgets')
  const busy = applying != null

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        flexWrap: 'wrap',
      }}
    >
      <Typography
        component="span"
        sx={{
          fontSize: 11.5,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          fontWeight: 600,
        }}
        color="text.secondary"
      >
        {t('templates.title')}
      </Typography>
      {TEMPLATES.map((template) => (
        <Button
          key={template.id}
          onClick={() => onApply(template.id)}
          disabled={disabled || busy}
          size="small"
          variant="outlined"
          startIcon={
            applying === template.id ? (
              <CircularProgress size={14} aria-label={t('templates.applying')} />
            ) : undefined
          }
          sx={{
            textTransform: 'none',
            borderRadius: '8px',
            borderColor: 'var(--mg-border-2)',
            color: 'text.primary',
            fontWeight: 500,
            fontSize: 12.5,
            px: 1.5,
            minHeight: 36,
            whiteSpace: 'nowrap',
          }}
        >
          {t(template.key)}
        </Button>
      ))}
    </Box>
  )
}

export default QuickStartTemplates
