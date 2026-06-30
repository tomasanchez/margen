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

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import InputBase from '@mui/material/InputBase'
import Typography from '@mui/material/Typography'
import ReportProblemOutlinedIcon from '@mui/icons-material/ReportProblemOutlined'
import { formatCurrency } from '../../lib/format'
import { categoryDotColor, categoryLabel } from '../transactions/presentation'
import { BudgetMeter } from './BudgetMeter'
import { ROW_GRID_GAP, ROW_GRID_TEMPLATE } from './groupGrid'
import { deriveCategoryProgress, parseMoney, toMoneyString } from './derive'
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
  /**
   * The category's trailing 3-month average spend as a Decimal string (ADR-147),
   * or null when unknown. On an UNTARGETED row with a positive average, a dashed
   * "↳ use {avg}" chip lets the user seed the target from history in one tap.
   */
  avg3mo?: string | null
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
  avg3mo = null,
  onCommit,
  onClear,
}: BudgetRowProps) {
  const { t } = useTranslation('budgets')
  const progress = deriveCategoryProgress(line)
  const label = categoryLabel(line.category)

  // The saved target as a plain editable string (no grouping, so typing is
  // predictable); empty when unset.
  const savedDraft = line.target ?? ''
  const [draft, setDraft] = useState(savedDraft)
  // Track the value last committed so a no-op blur never fires a write.
  const [committed, setCommitted] = useState(savedDraft)

  // The "use avg" suggestion shows only on an untargeted row when the trailing
  // 3-month average is positive (ADR-147); tapping it commits that target.
  const suggestionAmount =
    !progress.hasTarget && avg3mo != null && parseMoney(avg3mo) > 0
      ? parseMoney(avg3mo)
      : null
  const applySuggestion = () => {
    if (suggestionAmount == null) return
    const value = toMoneyString(suggestionAmount)
    setCommitted(value)
    setDraft(value)
    onCommit(value)
  }

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

  // The category name cell (dot + label + over-budget chip) — column 1.
  const nameCell = (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
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
      <Typography sx={{ fontSize: 14, fontWeight: 600 }} color="text.primary" noWrap>
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
            flex: 'none',
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
  )

  // The minimal target pill (the comp's element) — column 2. A bordered box with
  // a muted mono "ARS" prefix + a borderless right-aligned mono input. NO floating
  // label; the field keeps its accessible name via aria-label so AT + the tests
  // (getByLabelText / getByRole textbox) still resolve it.
  const targetCell = (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        border: '1px solid var(--mg-border-2)',
        borderRadius: '9px',
        bgcolor: 'var(--mg-paper-2)',
        px: 1.375,
        py: 1,
        width: { xs: 168, sm: '100%' },
        flex: 'none',
      }}
    >
      <Typography
        component="span"
        aria-hidden
        sx={{ fontFamily: 'var(--font-mono)', fontSize: 12, flex: 'none' }}
        color="text.secondary"
      >
        {currency}
      </Typography>
      <InputBase
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        placeholder={t('row.targetPlaceholder')}
        inputMode="decimal"
        inputProps={{
          'aria-label': t('row.targetLabel', { category: label }),
          style: { padding: 0, textAlign: 'right' },
        }}
        endAdornment={
          saving ? (
            <CircularProgress
              size={14}
              aria-label={t('row.saving')}
              sx={{ ml: 0.75, flex: 'none' }}
            />
          ) : undefined
        }
        sx={{
          flex: 1,
          minWidth: 0,
          color: 'text.primary',
          fontFamily: 'var(--font-mono)',
          fontVariantNumeric: 'tabular-nums',
          fontSize: 14,
          '& input': { padding: 0 },
        }}
      />
    </Box>
  )

  // Spent-vs-target (column 3): a meter + remaining when a target exists, else the
  // "Spent X" line with the dashed "↳ use {avg}" chip (ADR-147). Unchanged content.
  const spentCell = (
    <Box sx={{ minWidth: 0 }}>
      {progress.hasTarget ? (
        <>
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
              sx={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}
              color="text.secondary"
            >
              {formatCurrency(progress.spent, currency)} /{' '}
              {formatCurrency(progress.target ?? 0, currency)}
            </Typography>
            {progress.remaining != null ? (
              <Typography
                sx={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}
                color={progress.overBudget ? 'var(--mg-watch)' : 'var(--mg-safe)'}
              >
                {progress.overBudget
                  ? t('row.overBy', {
                      amount: formatCurrency(Math.abs(progress.remaining), currency),
                    })
                  : t('row.remaining', {
                      amount: formatCurrency(progress.remaining, currency),
                    })}
              </Typography>
            ) : null}
          </Box>
          <BudgetMeter
            ratio={progress.ratio}
            overBudget={progress.overBudget}
            label={meterLabel}
          />
        </>
      ) : suggestionAmount != null ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, flexWrap: 'wrap' }}>
          <Typography
            sx={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}
            color="text.disabled"
          >
            {t('row.spent', { amount: formatCurrency(progress.spent, currency) })}
          </Typography>
          <Button
            onClick={applySuggestion}
            size="small"
            variant="outlined"
            aria-label={t('row.useAvgAria', {
              category: label,
              amount: formatCurrency(suggestionAmount, currency),
            })}
            sx={{
              textTransform: 'none',
              borderRadius: '7px',
              borderStyle: 'dashed',
              borderColor: 'var(--mg-border-2)',
              color: 'var(--mg-gold)',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              fontWeight: 500,
              fontVariantNumeric: 'tabular-nums',
              px: 1.25,
              minHeight: 30,
              whiteSpace: 'nowrap',
            }}
          >
            {t('row.useAvg', {
              amount: formatCurrency(suggestionAmount, currency),
            })}
          </Button>
        </Box>
      ) : (
        <Typography
          sx={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}
          color="text.disabled"
        >
          {t('row.spent', { amount: formatCurrency(progress.spent, currency) })}
        </Typography>
      )}
    </Box>
  )

  return (
    <Box
      component="li"
      sx={{
        listStyle: 'none',
        py: 1.625,
        px: '2px',
        borderBottom: '1px solid var(--mg-border)',
        '&:last-of-type': { borderBottom: 'none' },
      }}
    >
      {/* A SINGLE grid (no duplicated DOM). On desktop it's the comp's 3-column
          template aligned with the header. On mobile it collapses to a 2-column
          grid where name + pill share row 1 and spent-vs-target spans row 2. */}
      <Box
        sx={{
          display: 'grid',
          alignItems: 'center',
          columnGap: { xs: 1.5, sm: ROW_GRID_GAP },
          rowGap: { xs: 1.125, sm: 0 },
          gridTemplateColumns: { xs: '1fr auto', sm: ROW_GRID_TEMPLATE },
          gridTemplateAreas: {
            xs: '"name target" "spent spent"',
            sm: '"name target spent"',
          },
        }}
      >
        <Box sx={{ gridArea: 'name', minWidth: 0 }}>{nameCell}</Box>
        <Box sx={{ gridArea: 'target', justifySelf: { xs: 'end', sm: 'stretch' } }}>
          {targetCell}
        </Box>
        <Box sx={{ gridArea: 'spent', minWidth: 0 }}>{spentCell}</Box>
      </Box>

      {saveError ? (
        <Typography
          sx={{ fontSize: 12, mt: 0.75 }}
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
