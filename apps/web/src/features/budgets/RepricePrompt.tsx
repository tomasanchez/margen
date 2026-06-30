/**
 * <RepricePrompt> — the confirm-on-rollover inflation reprice (ADR-137, ADR-141,
 * ADR-017, ADR-037).
 *
 * When a new month opens with no spend targets while the prior month has them
 * (detected upstream via `isRepriceRollover`), this renders a one-line nudge:
 * "Reprice {prior} for {month}?". Opening it shows a {@link ResponsiveModal}
 * preview — every prior cap → its repriced cap at a monthly-inflation % (seeded
 * from the shipped REM constant, editable) with optional per-category step-ups.
 * Confirming POSTs the reprice; it NEVER auto-applies. Nothing changes until the
 * user confirms (calm, ADR-037).
 *
 * The preview math is pure (`deriveRepricePreview`); this component is the UI
 * shell + the inflation/step-up inputs.
 */

import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import InputAdornment from '@mui/material/InputAdornment'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { ResponsiveModal } from '../../components/ResponsiveModal'
import { formatCurrency } from '../../lib/format'
import { categoryLabel } from '../transactions/presentation'
import { REM_MONTHLY_INFLATION_PCT } from '../../mock/seed'
import { deriveRepricePreview } from './derive'
import type { BudgetPeriod, RepriceStepUps } from '../../api/budgetsClient'
import type { Category, Currency } from '../../mock/types'

export interface RepricePromptProps {
  /** The prior month's period (the source of the caps to carry forward). */
  prior: BudgetPeriod
  /** Localized prior-month label, e.g. "May 2026". */
  priorLabel: string
  /** Target month as `YYYY-MM`. */
  toMonth: string
  /** Localized target-month label, e.g. "June 2026". */
  toLabel: string
  /** Period currency (ARS for the MVP). */
  currency: Currency
  /** Whether the reprice POST is in flight. */
  applying?: boolean
  /** Whether the last reprice failed (calm retry hint). */
  applyError?: boolean
  /** Confirm the reprice (the page wires the mutation). */
  onConfirm: (monthlyInflation: number, stepUps: RepriceStepUps) => void
}

export function RepricePrompt({
  prior,
  priorLabel,
  toMonth,
  toLabel,
  currency,
  applying = false,
  applyError = false,
  onConfirm,
}: RepricePromptProps) {
  const { t } = useTranslation('budgets')
  const [open, setOpen] = useState(false)
  const titleId = useId()

  // The inflation % (seeded from the REM constant, editable) and per-category
  // step-up draft strings.
  const [inflation, setInflation] = useState(String(REM_MONTHLY_INFLATION_PCT))
  const [stepUps, setStepUps] = useState<Record<string, string>>({})

  const inflationPct = useMemo(() => {
    const value = Number.parseFloat(inflation.replace(',', '.'))
    return Number.isFinite(value) ? value : 0
  }, [inflation])

  const normalizedStepUps = useMemo<RepriceStepUps>(() => {
    const out: RepriceStepUps = {}
    for (const [category, raw] of Object.entries(stepUps)) {
      const value = Number.parseFloat(raw.replace(/[^\d.,]/g, '').replace(',', '.'))
      if (Number.isFinite(value) && value > 0) out[category] = String(value)
    }
    return out
  }, [stepUps])

  const rows = useMemo(
    () => deriveRepricePreview(prior, inflationPct, normalizedStepUps),
    [prior, inflationPct, normalizedStepUps],
  )

  const handleConfirm = () => {
    onConfirm(inflationPct, normalizedStepUps)
  }

  return (
    <>
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1.5,
          mb: 2.5,
          p: 1.75,
          borderRadius: '12px',
          border: '1px solid var(--mg-border-2)',
          bgcolor: 'var(--mg-raised)',
        }}
        role="status"
      >
        <Typography sx={{ fontSize: 13.5 }} color="text.primary">
          {t('reprice.prompt', { prior: priorLabel, month: toLabel })}
        </Typography>
        <Button
          onClick={() => setOpen(true)}
          variant="outlined"
          size="small"
          sx={{
            textTransform: 'none',
            fontWeight: 600,
            borderRadius: '10px',
            borderColor: 'var(--mg-border-2)',
            color: 'text.primary',
            minHeight: 36,
            flex: 'none',
          }}
        >
          {t('reprice.promptAction', { month: toLabel })}
        </Button>
      </Box>

      <ResponsiveModal
        open={open}
        onClose={() => setOpen(false)}
        title={t('reprice.title', { month: toLabel })}
        titleId={titleId}
        maxWidth={560}
      >
        <Typography sx={{ fontSize: 13.5, mb: 2 }} color="text.secondary">
          {t('reprice.intro')}
        </Typography>

        <TextField
          value={inflation}
          onChange={(e) => setInflation(e.target.value)}
          size="small"
          label={t('reprice.inflationLabel')}
          inputMode="decimal"
          helperText={t('reprice.inflationHint')}
          slotProps={{
            input: {
              endAdornment: <InputAdornment position="end">%</InputAdornment>,
              sx: { fontVariantNumeric: 'tabular-nums' },
            },
            inputLabel: { shrink: true },
          }}
          sx={{ width: { xs: '100%', sm: 200 }, mb: 2 }}
        />

        {rows.length === 0 ? (
          <Typography sx={{ fontSize: 13.5 }} color="text.secondary" role="note">
            {t('reprice.empty', { prior: priorLabel })}
          </Typography>
        ) : (
          <Box>
            {/* Column header. */}
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: '1.4fr 1fr 1fr',
                gap: 1,
                pb: 0.75,
                borderBottom: '1px solid var(--mg-border)',
              }}
            >
              {[
                t('reprice.colCategory'),
                t('reprice.colOld'),
                t('reprice.colNew'),
              ].map((heading, i) => (
                <Typography
                  key={heading}
                  sx={{
                    fontSize: 11.5,
                    fontWeight: 700,
                    letterSpacing: '0.03em',
                    textTransform: 'uppercase',
                    textAlign: i === 0 ? 'left' : 'right',
                  }}
                  color="text.secondary"
                >
                  {heading}
                </Typography>
              ))}
            </Box>

            {rows.map((row) => (
              <Box
                key={row.category}
                sx={{
                  display: 'grid',
                  gridTemplateColumns: '1.4fr 1fr 1fr',
                  gap: 1,
                  alignItems: 'center',
                  py: 1,
                  borderBottom: '1px solid var(--mg-border)',
                  '&:last-of-type': { borderBottom: 'none' },
                }}
              >
                <Typography sx={{ fontSize: 13.5 }} color="text.primary" noWrap>
                  {categoryLabel(row.category as Category)}
                </Typography>
                <Typography
                  sx={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}
                  color="text.secondary"
                >
                  {formatCurrency(row.oldCap, currency)}
                </Typography>
                <Typography
                  sx={{
                    fontSize: 13,
                    fontWeight: 600,
                    fontVariantNumeric: 'tabular-nums',
                    textAlign: 'right',
                  }}
                  color="text.primary"
                >
                  {formatCurrency(row.newCap, currency)}
                </Typography>
              </Box>
            ))}

            {/* Optional per-category step-ups. */}
            <Box sx={{ mt: 2.5 }}>
              <Typography
                component="h3"
                sx={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase', mb: 0.5 }}
                color="text.secondary"
              >
                {t('reprice.stepUpsTitle')}
              </Typography>
              <Typography sx={{ fontSize: 12.5, mb: 1.25 }} color="text.secondary">
                {t('reprice.stepUpsHint')}
              </Typography>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5 }}>
                {rows.map((row) => (
                  <TextField
                    key={row.category}
                    value={stepUps[row.category] ?? ''}
                    onChange={(e) =>
                      setStepUps((prev) => ({ ...prev, [row.category]: e.target.value }))
                    }
                    size="small"
                    label={t('reprice.stepUpLabel', {
                      category: categoryLabel(row.category as Category),
                    })}
                    inputMode="decimal"
                    slotProps={{
                      input: {
                        startAdornment: (
                          <InputAdornment position="start">{currency}</InputAdornment>
                        ),
                        sx: { fontVariantNumeric: 'tabular-nums' },
                      },
                      inputLabel: { shrink: true },
                    }}
                    sx={{ width: 180, flex: 'none' }}
                  />
                ))}
              </Box>
            </Box>
          </Box>
        )}

        {applyError ? (
          <Typography sx={{ fontSize: 12.5, mt: 1.5 }} color="var(--mg-watch)" role="alert">
            {t('reprice.error')}
          </Typography>
        ) : null}

        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 2.5 }}>
          <Button
            onClick={() => setOpen(false)}
            variant="text"
            sx={{ textTransform: 'none', minHeight: 40 }}
          >
            {t('reprice.cancel')}
          </Button>
          <Button
            onClick={handleConfirm}
            variant="contained"
            disabled={applying || rows.length === 0}
            data-reprice-to={toMonth}
            sx={{ textTransform: 'none', fontWeight: 600, borderRadius: '10px', minHeight: 40 }}
          >
            {applying ? t('reprice.applying') : t('reprice.confirm')}
          </Button>
        </Box>
      </ResponsiveModal>
    </>
  )
}

export default RepricePrompt
