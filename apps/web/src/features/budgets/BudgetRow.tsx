/**
 * <BudgetRow> — one category's editable budget line on the Budgets page
 * (ADR-125, ADR-019, ADR-037).
 *
 * Lays out: the category (dot + localized label), an editable target amount
 * input, the spent figure, a spent/target {@link BudgetMeter}, and the remaining
 * amount. The dot is a redundant cue beside the text label, never the only
 * signal (ADR-019). The over-budget state is conveyed by the striped meter PLUS
 * a text "over budget" chip with an icon — color is never the sole signal.
 *
 * Editing is calm (ADR-125): the user types an ARS amount and the row COMMITS on
 * blur or Enter. A non-empty value upserts the target (PUT); clearing the field
 * (empty / zero) clears it (DELETE). The committed value is compared against the
 * last-saved one so a no-op blur (focus then leave without changing) never fires
 * a write. Escape reverts the field to the saved value without committing.
 *
 * The row is presentational: it owns only the local draft string and calls the
 * `onCommit` / `onClear` props the page wires to the mutations. A `saving` flag
 * shows a calm inline spinner; a `saveError` flag surfaces a quiet retry hint
 * under the input (ADR-037) without blocking further edits.
 */

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import InputAdornment from '@mui/material/InputAdornment'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import ReportProblemOutlinedIcon from '@mui/icons-material/ReportProblemOutlined'
import { formatCurrency } from '../../lib/format'
import { categoryDotColor, categoryLabel } from '../transactions/presentation'
import { BudgetMeter } from './BudgetMeter'
import { deriveCategoryProgress } from './derive'
import type { BudgetCategory } from '../../api/budgetsClient'
import type { Currency } from '../../mock/types'

export interface BudgetRowProps {
  /** The category's budget line (target / spent / remaining). */
  line: BudgetCategory
  /** Period currency for formatting (ARS for the MVP). */
  currency: Currency
  /** Whether this row's target write is in flight. */
  saving?: boolean
  /** Whether this row's last target write failed (shows a calm retry hint). */
  saveError?: boolean
  /** Commit a non-empty target (the raw Decimal string the input holds). */
  onCommit: (amount: string) => void
  /** Clear the target (empty / zero committed). */
  onClear: () => void
}

/**
 * Normalize the input string to a committable Decimal string, or `null` when it
 * is empty / zero / unparseable (which means "clear the target"). Accepts an
 * es-AR comma OR a dot as the decimal separator and strips thousands separators,
 * so a user typing "120.000" or "120000,50" both work.
 */
function normalizeAmount(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  // Drop spaces; treat the LAST comma/dot as the decimal point, the rest as
  // grouping. Keeps digits + one decimal separator.
  const cleaned = trimmed.replace(/\s/g, '')
  const lastComma = cleaned.lastIndexOf(',')
  const lastDot = cleaned.lastIndexOf('.')
  const sepIndex = Math.max(lastComma, lastDot)
  let normalized: string
  if (sepIndex === -1) {
    normalized = cleaned.replace(/\D/g, '')
  } else {
    const intPart = cleaned.slice(0, sepIndex).replace(/\D/g, '')
    const fracPart = cleaned.slice(sepIndex + 1).replace(/\D/g, '')
    normalized = fracPart ? `${intPart}.${fracPart}` : intPart
  }
  const value = Number.parseFloat(normalized)
  if (!Number.isFinite(value) || value <= 0) return null
  return normalized
}

export function BudgetRow({
  line,
  currency,
  saving = false,
  saveError = false,
  onCommit,
  onClear,
}: BudgetRowProps) {
  const { t } = useTranslation('budgets')
  const progress = deriveCategoryProgress(line)
  const label = categoryLabel(line.category)
  const inputId = useId()

  // The saved target as a plain editable string (no grouping, so typing is
  // predictable); empty when unset.
  const savedDraft = line.target ?? ''
  const [draft, setDraft] = useState(savedDraft)
  // Track the value last committed so a no-op blur never fires a write.
  const [committed, setCommitted] = useState(savedDraft)

  const commit = () => {
    const normalized = normalizeAmount(draft)
    // Compare the normalized result against the saved value to skip no-ops.
    const savedNormalized = normalizeAmount(committed)
    if (normalized === savedNormalized) return
    if (normalized == null) {
      setCommitted('')
      setDraft('')
      onClear()
    } else {
      setCommitted(normalized)
      setDraft(normalized)
      onCommit(normalized)
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      ;(event.target as HTMLInputElement).blur()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setDraft(committed)
    }
  }

  // Accessible label for the meter: names the category + percentage so AT
  // announces progress without the visual bar (ADR-019).
  const meterLabel = progress.hasTarget
    ? t('row.meterAria', {
        category: label,
        pct: Math.round(progress.ratio * 100),
      })
    : t('row.meterNoTargetAria', { category: label })

  return (
    <Box
      component="li"
      sx={{
        listStyle: 'none',
        py: 1.5,
        borderBottom: '1px solid var(--mg-border)',
        '&:last-of-type': { borderBottom: 'none' },
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: { xs: 'wrap', sm: 'nowrap' },
          gap: { xs: 1, sm: 2 },
        }}
      >
        {/* Category: dot + label (the dot is redundant beside the text, ADR-019). */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            minWidth: { xs: '100%', sm: 150 },
            flex: { sm: 'none' },
          }}
        >
          <Box
            aria-hidden
            sx={{
              width: 9,
              height: 9,
              borderRadius: '50%',
              flex: 'none',
              bgcolor: categoryDotColor(line.category),
            }}
          />
          <Typography
            sx={{ fontSize: 14, fontWeight: 600 }}
            color="text.primary"
            noWrap
          >
            {label}
          </Typography>
          {progress.overBudget ? (
            <Box
              component="span"
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.25,
                ml: 0.5,
                px: 0.75,
                py: '2px',
                borderRadius: '6px',
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--mg-watch)',
                bgcolor: 'color-mix(in srgb, var(--mg-watch) 12%, transparent)',
              }}
            >
              <ReportProblemOutlinedIcon sx={{ fontSize: 13 }} aria-hidden />
              {t('row.over')}
            </Box>
          ) : null}
        </Box>

        {/* Editable target amount. */}
        <TextField
          id={inputId}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          size="small"
          placeholder={t('row.targetPlaceholder')}
          label={t('row.targetLabel', { category: label })}
          inputMode="decimal"
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">{currency}</InputAdornment>
              ),
              endAdornment: saving ? (
                <InputAdornment position="end">
                  <CircularProgress size={16} aria-label={t('row.saving')} />
                </InputAdornment>
              ) : undefined,
              sx: { fontVariantNumeric: 'tabular-nums' },
            },
            inputLabel: { shrink: true },
          }}
          sx={{
            width: { xs: '100%', sm: 168 },
            flex: 'none',
            '& .MuiOutlinedInput-root': { borderRadius: '10px' },
          }}
        />

        {/* Spent + remaining figures. */}
        <Box sx={{ flex: 1, minWidth: { xs: '100%', sm: 0 } }}>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 1.5,
              mb: 0.625,
            }}
          >
            <Typography
              sx={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}
              color="text.secondary"
            >
              {t('row.spent', { amount: formatCurrency(progress.spent, currency) })}
            </Typography>
            {progress.remaining != null ? (
              <Typography
                sx={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}
                color={progress.overBudget ? 'var(--mg-watch)' : 'text.secondary'}
              >
                {progress.overBudget
                  ? t('row.overBy', {
                      amount: formatCurrency(
                        Math.abs(progress.remaining),
                        currency,
                      ),
                    })
                  : t('row.remaining', {
                      amount: formatCurrency(progress.remaining, currency),
                    })}
              </Typography>
            ) : null}
          </Box>
          {progress.hasTarget ? (
            <BudgetMeter
              ratio={progress.ratio}
              overBudget={progress.overBudget}
              label={meterLabel}
            />
          ) : (
            <Typography
              sx={{ fontSize: 12.5 }}
              color="text.disabled"
              role="note"
            >
              {t('row.noTargetHint')}
            </Typography>
          )}
        </Box>
      </Box>

      {saveError ? (
        <Typography
          sx={{ fontSize: 12, mt: 0.75, ml: { sm: '166px' } }}
          color="var(--mg-watch)"
          role="alert"
        >
          {t('row.saveError')}
        </Typography>
      ) : null}
    </Box>
  )
}

export default BudgetRow
