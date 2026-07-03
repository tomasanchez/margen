/**
 * Add / edit a manual debt in a dialog (ADR-187, ADR-017/019/037).
 *
 * A debt is a manual, balance-bearing liability (a loan, a personal debt) that
 * feeds the net-worth `liabilities.other` leg (ADR-187). The form captures a
 * required name, the native currency (ARS / USD), the current balance, and two
 * optional extension fields — a monthly minimum and a rate. Money stays a Decimal
 * STRING end-to-end (ADR-025/034): balances are typed free-form, validated for a
 * finite non-negative number, and serialized to the fixed 2-decimal string the API
 * expects; the optional minimum is serialized the same way, the rate is sent
 * verbatim (a percentage the user types).
 *
 * Client-side validation mirrors the backend (ADR-187/031): a non-empty name and a
 * current balance ≥ 0. On save it emits a {@link DebtFormInput}; the page routes it
 * to the create vs update mutation and closes on success. A failure keeps the
 * dialog open with the user's input intact and surfaces a calm inline message
 * (ADR-037).
 *
 * Note (ADR-187/028): PATCH treats an omitted optional as "unchanged", so once the
 * monthly-minimum / rate are set they can't be cleared back to null here — there is
 * deliberately no clear-to-null affordance.
 *
 * Keyboard + focus: the shared {@link ResponsiveModal} traps focus, restores it to
 * the trigger on close, and Escape closes (ADR-019). Every control has a label.
 */

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import FormControl from '@mui/material/FormControl'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { ResponsiveModal } from '../../components/ResponsiveModal'
import type { Currency } from '../../mock/types'
import type { Debt, DebtFormInput } from '../../api/debtsClient'
import { parseBalance, toDecimalString } from './balance'

export interface DebtFormProps {
  /** Whether the dialog is open. */
  open: boolean
  /** The debt being edited, or `null` to add a new one. */
  debt: Debt | null
  /** Whether a save mutation is in flight (disables the form / shows progress). */
  isSaving: boolean
  /** True when the last save failed — surfaces the calm inline error (ADR-037). */
  saveError: boolean
  /** Save handler; receives the assembled form input (create vs edit routed by the page). */
  onSubmit: (input: DebtFormInput) => void
  /** Cancel / dismiss the dialog. */
  onClose: () => void
}

export function DebtForm({
  open,
  debt,
  isSaving,
  saveError,
  onSubmit,
  onClose,
}: DebtFormProps) {
  const { t } = useTranslation('accounts')
  const mode = debt ? 'edit' : 'add'

  const nameId = useId()
  const currencyId = useId()
  const balanceId = useId()
  const minimumId = useId()
  const rateId = useId()
  const errorId = useId()

  const [name, setName] = useState<string>(debt?.name ?? '')
  const [currency, setCurrency] = useState<Currency>(debt?.currency ?? 'ARS')
  const [balanceText, setBalanceText] = useState<string>(
    debt?.currentBalance ?? '',
  )
  const [minimumText, setMinimumText] = useState<string>(
    debt?.monthlyMinimum ?? '',
  )
  const [rateText, setRateText] = useState<string>(debt?.rate ?? '')

  const nameValid = name.trim().length > 0
  const balance = parseBalance(balanceText)
  // Mirror the backend invariant (ADR-187/031): a finite balance ≥ 0.
  const balanceValid = Number.isFinite(balance) && balance >= 0
  const canSave = nameValid && balanceValid && !isSaving

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSave) return
    onSubmit({
      name: name.trim(),
      currency,
      currentBalance: toDecimalString(balance),
      // Serialize the optional minimum as the same Decimal string when present;
      // an empty field is dropped by the client (omitted from the body, ADR-187).
      monthlyMinimum: minimumText.trim()
        ? toDecimalString(parseBalance(minimumText))
        : '',
      rate: rateText.trim(),
    })
  }

  const title = mode === 'edit' ? t('debts.form.editTitle') : t('debts.form.addTitle')

  return (
    <ResponsiveModal open={open} onClose={onClose} title={title} maxWidth={440}>
      <Box component="form" onSubmit={handleSubmit}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.25 }}>
          {saveError ? (
            <Typography
              id={errorId}
              role="alert"
              sx={{ fontSize: 13 }}
              color="error.main"
            >
              {t('debts.form.saveError')}
            </Typography>
          ) : null}

          <TextField
            id={nameId}
            label={t('debts.form.name.label')}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            fullWidth
            size="small"
            disabled={isSaving}
            slotProps={{
              htmlInput: {
                'aria-describedby': saveError ? errorId : undefined,
              },
            }}
          />

          <FormControl fullWidth size="small" disabled={isSaving}>
            <InputLabel id={`${currencyId}-label`}>
              {t('debts.form.currency.label')}
            </InputLabel>
            <Select
              id={currencyId}
              labelId={`${currencyId}-label`}
              label={t('debts.form.currency.label')}
              value={currency}
              onChange={(event) => setCurrency(event.target.value as Currency)}
            >
              <MenuItem value="ARS">{t('debts.form.currency.ars')}</MenuItem>
              <MenuItem value="USD">{t('debts.form.currency.usd')}</MenuItem>
            </Select>
          </FormControl>

          <TextField
            id={balanceId}
            label={t('debts.form.currentBalance.label')}
            value={balanceText}
            onChange={(event) => setBalanceText(event.target.value)}
            required
            fullWidth
            size="small"
            disabled={isSaving}
            inputMode="decimal"
            helperText={t('debts.form.currentBalance.helper')}
          />

          <TextField
            id={minimumId}
            label={t('debts.form.monthlyMinimum.label')}
            value={minimumText}
            onChange={(event) => setMinimumText(event.target.value)}
            fullWidth
            size="small"
            disabled={isSaving}
            inputMode="decimal"
            helperText={t('debts.form.monthlyMinimum.helper')}
          />

          <TextField
            id={rateId}
            label={t('debts.form.rate.label')}
            value={rateText}
            onChange={(event) => setRateText(event.target.value)}
            fullWidth
            size="small"
            disabled={isSaving}
            inputMode="decimal"
            helperText={t('debts.form.rate.helper')}
          />
        </Box>

        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 3 }}>
          <Button
            type="button"
            onClick={onClose}
            color="secondary"
            sx={{ textTransform: 'none' }}
          >
            {t('debts.form.cancel')}
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={!canSave}
            sx={{ textTransform: 'none', fontWeight: 600 }}
          >
            {t('debts.form.save')}
          </Button>
        </Box>
      </Box>
    </ResponsiveModal>
  )
}

export default DebtForm
