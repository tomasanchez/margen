/**
 * <SpendableIncome> — the LEFT column of the allocation hero (ADR-139, ADR-143,
 * ADR-037, ADR-019, ADR-145).
 *
 * The honest base every saving percentage is applied to. Matches the design
 * comp's hero composition: an uppercase "Spendable income" label, a large
 * borderless mono income input prefixed with "ARS", a thin divider, the
 * "after tax & business costs" helper, then the gold "↻ avg last 3 mo" chip.
 * The income-pressure readout + suggested-strategy hint (ADR-143) and the manual
 * household-essentials floor (ADR-139) are folded in as a COMPACT sub-line below,
 * not given their own card — so the hero stays a single unified surface.
 *
 * Presentational + calm: it owns local draft strings and calls the mutation
 * props the page wires; a `saving` flag shows a quiet spinner and `saveError` a
 * retry hint (ADR-037). The income field keeps its accessible label so keyboard
 * + AT users can find it; the borderless styling is purely visual.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import InputAdornment from '@mui/material/InputAdornment'
import InputBase from '@mui/material/InputBase'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import AutorenewIcon from '@mui/icons-material/Autorenew'
import { formatCurrency } from '../../lib/format'
import { parseMoney } from './derive'
import type {
  BudgetIncome,
  IncomePressure,
  SavingProfile,
} from '../../api/budgetsClient'
import type { Currency } from '../../mock/types'

export interface SpendableIncomeProps {
  /** The net-income base + floor for the month (ADR-139), or undefined while loading. */
  income: BudgetIncome | undefined
  /** Localized month label for the income field's accessible name, e.g. "June 2026". */
  monthLabel: string
  /** Period currency (ARS for the MVP). */
  currency: Currency
  /** Income-pressure segment from the budgets read (ADR-143), or null. */
  pressure: IncomePressure | null
  /** Suggested saving profile from the budgets read (ADR-143), or null. */
  suggestedStrategy: SavingProfile | null
  /** Whether an income/floor write is in flight. */
  saving?: boolean
  /** Whether the last income/floor write failed. */
  saveError?: boolean
  /** The pulled suggested base (Decimal string), or null when none / not yet fetched. */
  suggestedBase?: string | null
  /** Whether the suggested-base lookup ran and returned nothing (zero inflow months). */
  suggestedBaseEmpty?: boolean
  /** Whether the suggested base is backed by < 12 months of history (ADR-153). */
  suggestedSparse?: boolean
  /** Count of months backing the suggested base, surfaced when sparse (ADR-153). */
  suggestedMonths?: number
  /** Commit the net income (raw Decimal string) — upserts via PUT. */
  onCommitIncome: (amount: string) => void
  /** Commit a manual floor amount (raw Decimal string) — upserts via PUT. */
  onCommitFloor: (amount: string) => void
  /** Seed the income field with the suggested base (pulls it lazily). */
  onUseSuggested: () => void
}

/** Parse a free-typed amount to a committable Decimal string, or null to skip. */
function normalize(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const cleaned = trimmed.replace(/\s/g, '')
  const lastSep = Math.max(cleaned.lastIndexOf(','), cleaned.lastIndexOf('.'))
  const normalized =
    lastSep === -1
      ? cleaned.replace(/\D/g, '')
      : `${cleaned.slice(0, lastSep).replace(/\D/g, '')}.${cleaned
          .slice(lastSep + 1)
          .replace(/\D/g, '')}`
  const value = Number.parseFloat(normalized)
  if (!Number.isFinite(value) || value <= 0) return null
  return normalized
}

export function SpendableIncome({
  income,
  monthLabel,
  currency,
  pressure,
  suggestedStrategy,
  saving = false,
  saveError = false,
  suggestedBase = null,
  suggestedBaseEmpty = false,
  suggestedSparse = false,
  suggestedMonths = 0,
  onCommitIncome,
  onCommitFloor,
  onUseSuggested,
}: SpendableIncomeProps) {
  const { t } = useTranslation('budgets')

  const savedIncome = income?.amount ?? ''
  const [incomeDraft, setIncomeDraft] = useState(savedIncome)
  const [incomeCommitted, setIncomeCommitted] = useState(savedIncome)

  const computedFloor = income?.floor?.source === 'computed' ? income.floor.amount : null
  const manualFloor = income?.floor?.source === 'manual' ? income.floor.amount : ''
  const [floorDraft, setFloorDraft] = useState(manualFloor)
  const [floorCommitted, setFloorCommitted] = useState(manualFloor)
  // The floor editor is folded into a compact sub-line; it stays hidden until the
  // user opens it so the hero reads calm (ADR-139 stays available, not loud).
  const [floorOpen, setFloorOpen] = useState(false)

  // Re-seed the drafts when the SAVED values change while no write is in flight
  // (e.g. switching the budget currency clears a currency-mismatched income to
  // undefined upstream, ADR-154): the field must follow the saved value so we
  // never leave a stale ARS amount in a now-USD-prefixed input. This is React's
  // "adjust state during render" pattern (a setState during render, not an
  // effect) — it re-renders immediately with the new value and skips while
  // `saving` so an in-flight optimistic edit isn't clobbered by the round-trip.
  const [seededIncome, setSeededIncome] = useState(savedIncome)
  const [seededFloor, setSeededFloor] = useState(manualFloor)
  if (!saving && savedIncome !== seededIncome) {
    setSeededIncome(savedIncome)
    setIncomeDraft(savedIncome)
    setIncomeCommitted(savedIncome)
  }
  if (!saving && manualFloor !== seededFloor) {
    setSeededFloor(manualFloor)
    setFloorDraft(manualFloor)
    setFloorCommitted(manualFloor)
  }

  const commitIncome = () => {
    const normalized = normalize(incomeDraft)
    if (normalized == null || normalized === normalize(incomeCommitted)) {
      setIncomeDraft(incomeCommitted)
      return
    }
    setIncomeCommitted(normalized)
    setIncomeDraft(normalized)
    onCommitIncome(normalized)
  }

  const commitFloor = () => {
    const normalized = normalize(floorDraft)
    if (normalized == null || normalized === normalize(floorCommitted)) {
      setFloorDraft(floorCommitted)
      return
    }
    setFloorCommitted(normalized)
    setFloorDraft(normalized)
    onCommitFloor(normalized)
  }

  const handleKeyDown =
    (revert: () => void) => (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        // Blur commits via the field's onBlur handler.
        ;(event.target as HTMLInputElement).blur()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        revert()
      }
    }

  // The pressure readout uses the income/floor ratio as calm copy (ADR-143/019).
  const incomeAmount = income?.amount != null ? parseMoney(income.amount) : null
  const floorAmount =
    income?.floor != null ? parseMoney(income.floor.amount) : null
  const ratioLabel =
    incomeAmount != null && floorAmount != null && floorAmount > 0
      ? (incomeAmount / floorAmount).toFixed(1)
      : null

  const pressureCopy: Record<IncomePressure, string> = {
    Constrained: t('income.pressure.Constrained', { ratio: ratioLabel ?? '—' }),
    Stable: t('income.pressure.Stable', { ratio: ratioLabel ?? '—' }),
    Comfortable: t('income.pressure.Comfortable', { ratio: ratioLabel ?? '—' }),
  }

  const suggestedBaseLabel =
    suggestedBase != null
      ? formatCurrency(parseMoney(suggestedBase), currency)
      : null

  return (
    <Box>
      <Typography
        component="div"
        sx={{
          fontSize: 11.5,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          fontWeight: 600,
        }}
        color="text.secondary"
      >
        {t('income.title')}
      </Typography>

      {/* Large borderless mono income input, "ARS" prefix (the comp's hero input). */}
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.875, mt: 1.5 }}>
        <Typography
          component="span"
          aria-hidden
          sx={{
            fontFamily: 'var(--font-mono)',
            fontSize: { xs: 15, md: 19 },
            flex: 'none',
          }}
          color="text.secondary"
        >
          {currency}
        </Typography>
        <InputBase
          value={incomeDraft}
          onChange={(e) => setIncomeDraft(e.target.value)}
          onBlur={commitIncome}
          onKeyDown={handleKeyDown(() => setIncomeDraft(incomeCommitted))}
          placeholder="0"
          inputMode="decimal"
          inputProps={{
            'aria-label': t('income.label', { month: monthLabel }),
            style: { padding: 0 },
          }}
          endAdornment={
            saving ? (
              <InputAdornment position="end">
                <CircularProgress size={16} aria-label={t('income.saving')} />
              </InputAdornment>
            ) : undefined
          }
          sx={{
            flex: 1,
            minWidth: 0,
            color: 'text.primary',
            fontFamily: 'var(--font-mono)',
            fontVariantNumeric: 'tabular-nums',
            fontSize: { xs: 25, md: 32 },
            fontWeight: 600,
            letterSpacing: '-0.01em',
            '& input': { padding: 0 },
          }}
        />
      </Box>

      <Box sx={{ borderBottom: '1px solid var(--mg-border)', my: '4px', mb: 1.5 }} />

      <Typography
        sx={{ fontSize: 12.5, lineHeight: 1.5 }}
        color="text.secondary"
      >
        {t('income.subtitle')}
      </Typography>

      {/* "↻ avg last 3 mo · ARS x" chip — pulls the variable-income suggestion. */}
      <Box sx={{ mt: 1.5 }}>
        {suggestedBaseLabel != null ? (
          <Button
            onClick={onUseSuggested}
            startIcon={<AutorenewIcon sx={{ fontSize: 15 }} />}
            variant="outlined"
            aria-label={t('income.useSuggestedAria', { amount: suggestedBaseLabel })}
            sx={{
              textTransform: 'none',
              borderRadius: '8px',
              borderColor: 'var(--mg-border-2)',
              bgcolor: 'var(--mg-paper-2)',
              color: 'var(--mg-gold)',
              fontFamily: 'var(--font-mono)',
              fontVariantNumeric: 'tabular-nums',
              fontSize: 12,
              px: 1.375,
              minHeight: 32,
            }}
          >
            {t('income.avgChip', { amount: suggestedBaseLabel })}
          </Button>
        ) : suggestedBaseEmpty ? (
          <Typography sx={{ fontSize: 12 }} color="text.secondary">
            {t('income.noSuggestion')}
          </Typography>
        ) : (
          <Button
            onClick={onUseSuggested}
            startIcon={<AutorenewIcon sx={{ fontSize: 15 }} />}
            variant="outlined"
            sx={{
              textTransform: 'none',
              borderRadius: '8px',
              borderColor: 'var(--mg-border-2)',
              bgcolor: 'var(--mg-paper-2)',
              color: 'var(--mg-gold)',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              px: 1.375,
              minHeight: 32,
            }}
          >
            {t('income.avgChip', { amount: '…' })}
          </Button>
        )}

        {/* Sparse-estimate caveat (ADR-153): when fewer than 12 months back the
            suggestion, say how many so the user reads it as provisional. */}
        {suggestedBaseLabel != null && suggestedSparse ? (
          <Typography
            sx={{ fontSize: 11.5, mt: 0.5 }}
            color="text.secondary"
            role="note"
          >
            {t('income.estimateFrom', { count: suggestedMonths })}
          </Typography>
        ) : null}
      </Box>

      {/* Compact pressure / strategy readout (ADR-143), folded in subtly. */}
      {pressure != null ? (
        <Typography
          sx={{ fontSize: 12.5, mt: 1.25 }}
          color="text.secondary"
          role="status"
        >
          {pressureCopy[pressure]}
        </Typography>
      ) : null}

      {suggestedStrategy != null ? (
        <Typography sx={{ fontSize: 12, mt: 0.5 }} color="text.secondary">
          {t('income.suggestedStrategy', {
            profile: t(`savings.profile.${suggestedStrategy}`),
          })}
        </Typography>
      ) : null}

      {income?.amount == null ? (
        <Typography sx={{ fontSize: 12.5, mt: 1 }} color="text.secondary" role="note">
          {t('income.empty')}
        </Typography>
      ) : null}

      {/* Household-essentials floor (ADR-139): a quiet disclosure, not its own card. */}
      <Box sx={{ mt: 1.25 }}>
        {floorOpen ? (
          <TextField
            value={floorDraft}
            onChange={(e) => setFloorDraft(e.target.value)}
            onBlur={commitFloor}
            onKeyDown={handleKeyDown(() => setFloorDraft(floorCommitted))}
            size="small"
            label={t('income.floorLabel')}
            placeholder={
              computedFloor != null
                ? formatCurrency(parseMoney(computedFloor), currency)
                : undefined
            }
            inputMode="decimal"
            autoFocus
            helperText={
              computedFloor != null
                ? t('income.floorComputed', {
                    amount: formatCurrency(parseMoney(computedFloor), currency),
                  })
                : t('income.floorHint')
            }
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">{currency}</InputAdornment>
                ),
                sx: { fontVariantNumeric: 'tabular-nums' },
              },
              inputLabel: { shrink: true },
            }}
            sx={{ width: '100%' }}
          />
        ) : (
          <Button
            onClick={() => setFloorOpen(true)}
            variant="text"
            sx={{
              textTransform: 'none',
              fontWeight: 500,
              fontSize: 12,
              px: 0.5,
              minHeight: 28,
              color: 'text.secondary',
            }}
          >
            {manualFloor !== ''
              ? t('income.floorEditSet', {
                  amount: formatCurrency(parseMoney(manualFloor), currency),
                })
              : computedFloor != null
                ? t('income.floorEditComputed', {
                    amount: formatCurrency(parseMoney(computedFloor), currency),
                  })
                : t('income.floorEdit')}
          </Button>
        )}
      </Box>

      {saveError ? (
        <Typography sx={{ fontSize: 12, mt: 0.75 }} color="var(--mg-watch)" role="alert">
          {t('income.saveError')}
        </Typography>
      ) : null}
    </Box>
  )
}

export default SpendableIncome
