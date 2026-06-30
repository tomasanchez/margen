/**
 * <NetIncomeHeader> — the net spendable income base + household floor (ADR-139,
 * ADR-143, ADR-037, ADR-019).
 *
 * The honest base every saving percentage is applied to. The user inline-edits
 * their net income (commits on blur/Enter → `PUT /budget-income`) and, optionally,
 * a manual household-essentials floor (the computed-from-essentials value shows as
 * the placeholder/default). From the income÷floor ratio the backend derives an
 * income-pressure readout (Constrained / Stable / Comfortable, calm copy, ADR-019)
 * and a suggested saving profile — both shown here, neither ever forced. A "use
 * suggested base" affordance pulls the variable-income suggestion on demand.
 *
 * Presentational + calm: it owns local draft strings and calls the mutation props
 * the page wires; a `saving` flag shows a quiet spinner and `saveError` a retry
 * hint (ADR-037). Numeric `sx` sizes are passed as strings / handled via tokens
 * (the MUI numeric-sx-=-percent gotcha).
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import InputAdornment from '@mui/material/InputAdornment'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { SectionCard } from '../../components/SectionCard'
import { formatCurrency } from '../../lib/format'
import { parseMoney } from './derive'
import type {
  BudgetIncome,
  IncomePressure,
  SavingProfile,
} from '../../api/budgetsClient'
import type { Currency } from '../../mock/types'

export interface NetIncomeHeaderProps {
  /** The net-income base + floor for the month (ADR-139), or undefined while loading. */
  income: BudgetIncome | undefined
  /** Localized month label for field labels, e.g. "June 2026". */
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
  /** Whether the suggested-base lookup ran and returned nothing (<12mo history). */
  suggestedBaseEmpty?: boolean
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

export function NetIncomeHeader({
  income,
  monthLabel,
  currency,
  pressure,
  suggestedStrategy,
  saving = false,
  saveError = false,
  suggestedBase = null,
  suggestedBaseEmpty = false,
  onCommitIncome,
  onCommitFloor,
  onUseSuggested,
}: NetIncomeHeaderProps) {
  const { t } = useTranslation('budgets')

  const savedIncome = income?.amount ?? ''
  const [incomeDraft, setIncomeDraft] = useState(savedIncome)
  const [incomeCommitted, setIncomeCommitted] = useState(savedIncome)

  const computedFloor = income?.floor?.source === 'computed' ? income.floor.amount : null
  const manualFloor = income?.floor?.source === 'manual' ? income.floor.amount : ''
  const [floorDraft, setFloorDraft] = useState(manualFloor)
  const [floorCommitted, setFloorCommitted] = useState(manualFloor)

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
    <SectionCard title={t('income.title')} subtitle={t('income.subtitle')}>
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: { xs: 1.5, sm: 2.5 },
          alignItems: 'flex-start',
        }}
      >
        {/* Net income input. */}
        <TextField
          value={incomeDraft}
          onChange={(e) => setIncomeDraft(e.target.value)}
          onBlur={commitIncome}
          onKeyDown={handleKeyDown(() => setIncomeDraft(incomeCommitted))}
          size="small"
          label={t('income.label', { month: monthLabel })}
          placeholder={t('income.placeholder')}
          inputMode="decimal"
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">{currency}</InputAdornment>
              ),
              endAdornment: saving ? (
                <InputAdornment position="end">
                  <CircularProgress size={16} aria-label={t('income.saving')} />
                </InputAdornment>
              ) : undefined,
              sx: { fontVariantNumeric: 'tabular-nums' },
            },
            inputLabel: { shrink: true },
          }}
          sx={{ width: { xs: '100%', sm: 240 }, flex: 'none' }}
        />

        {/* Household essentials floor (manual; computed value as placeholder). */}
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
          sx={{ width: { xs: '100%', sm: 280 }, flex: 'none' }}
        />
      </Box>

      {/* Use-suggested-base affordance (variable-income suggestion). */}
      <Box sx={{ mt: 1.5 }}>
        {suggestedBaseLabel != null ? (
          <Button
            onClick={onUseSuggested}
            size="small"
            variant="text"
            sx={{ textTransform: 'none', fontWeight: 600, px: 1, minHeight: 36 }}
            aria-label={t('income.useSuggestedAria', { amount: suggestedBaseLabel })}
          >
            {t('income.useSuggested', { amount: suggestedBaseLabel })}
          </Button>
        ) : suggestedBaseEmpty ? (
          <Typography sx={{ fontSize: 12.5 }} color="text.secondary">
            {t('income.noSuggestion')}
          </Typography>
        ) : (
          <Button
            onClick={onUseSuggested}
            size="small"
            variant="text"
            sx={{ textTransform: 'none', fontWeight: 600, px: 1, minHeight: 36 }}
          >
            {t('income.useSuggested', { amount: '…' })}
          </Button>
        )}
      </Box>

      {/* Income-pressure readout (calm, non-color, ratio-to-floor copy). */}
      {pressure != null ? (
        <Typography
          sx={{ fontSize: 13.5, mt: 1.25 }}
          color="text.secondary"
          role="status"
        >
          {pressureCopy[pressure]}
        </Typography>
      ) : null}

      {/* Suggested-strategy hint (user always picks; never forced). */}
      {suggestedStrategy != null ? (
        <Typography sx={{ fontSize: 13, mt: 0.75 }} color="text.secondary">
          {t('income.suggestedStrategy', {
            profile: t(`savings.profile.${suggestedStrategy}`),
          })}
        </Typography>
      ) : null}

      {income?.amount == null ? (
        <Typography
          sx={{ fontSize: 13, mt: 1 }}
          color="text.secondary"
          role="note"
        >
          {t('income.empty')}
        </Typography>
      ) : null}

      {saveError ? (
        <Typography sx={{ fontSize: 12, mt: 0.75 }} color="var(--mg-watch)" role="alert">
          {t('income.saveError')}
        </Typography>
      ) : null}
    </SectionCard>
  )
}

export default NetIncomeHeader
