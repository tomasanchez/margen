/**
 * Add / edit an account in a dialog (ADR-122, ADR-017/019/037).
 *
 * Captures the four account fields: name, type (bank/cash/card), native currency
 * (ARS/USD), and opening balance. Opening balance stays a Decimal STRING
 * end-to-end (ADR-025/034) — typed as text, validated for a finite number, and
 * sent verbatim to the backend. On save it picks the create vs update mutation
 * from the `account` prop (edit when present) and closes on success; a failure
 * keeps the dialog open with the user's input intact and surfaces a calm inline
 * message (ADR-037). Currency is locked on edit (ADR-123): changing an account's
 * native currency would reinterpret its stored balances, so the field is
 * disabled for an existing account.
 *
 * Keyboard + focus: the MUI Dialog traps focus, restores it to the trigger on
 * close, and Escape closes (ADR-019). Every control has an associated label.
 */

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControl from '@mui/material/FormControl'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import type { Account, AccountType, Currency } from '../../mock/types'
import type { AccountWriteBody } from '../../api/accountsClient'
import { ACCOUNT_TYPES, accountTypeLabel } from './presentation'

export interface AccountFormProps {
  /** Whether the dialog is open. */
  open: boolean
  /** The account being edited, or `null` to add a new one. */
  account: Account | null
  /** Whether a save mutation is in flight (disables the form / shows progress). */
  isSaving: boolean
  /** True when the last save failed — surfaces the calm inline error (ADR-037). */
  saveError: boolean
  /** Save handler; receives the assembled write body. */
  onSubmit: (input: AccountWriteBody) => void
  /** Cancel / dismiss the dialog. */
  onClose: () => void
}

/** Parse a free-text balance to a finite number (es-AR-ish: comma OR dot). */
function parseBalance(raw: string): number {
  const cleaned = raw.replace(/\s/g, '').replace(/[^\d.,-]/g, '')
  if (cleaned === '') return Number.NaN
  const lastComma = cleaned.lastIndexOf(',')
  const lastDot = cleaned.lastIndexOf('.')
  let normalized: string
  if (lastComma > -1 && lastDot > -1) {
    const decimalSep = lastComma > lastDot ? ',' : '.'
    const groupSep = decimalSep === ',' ? '.' : ','
    normalized = cleaned.split(groupSep).join('').replace(decimalSep, '.')
  } else if (lastComma > -1) {
    normalized = cleaned.replace(',', '.')
  } else {
    normalized = cleaned
  }
  const value = Number(normalized)
  return Number.isFinite(value) ? value : Number.NaN
}

/** Round to 2 decimals and serialize as the Decimal string the API expects. */
function toDecimalString(value: number): string {
  return value.toFixed(2)
}

export function AccountForm({
  open,
  account,
  isSaving,
  saveError,
  onSubmit,
  onClose,
}: AccountFormProps) {
  const { t } = useTranslation('accounts')
  const mode = account ? 'edit' : 'add'

  const nameId = useId()
  const typeId = useId()
  const currencyId = useId()
  const balanceId = useId()
  const errorId = useId()
  const titleId = useId()

  const [name, setName] = useState<string>(account?.name ?? '')
  const [type, setType] = useState<AccountType>(account?.type ?? 'bank')
  const [currency, setCurrency] = useState<Currency>(account?.currency ?? 'ARS')
  // Opening balance as the raw string the user types (Decimal string preserved).
  const [balanceText, setBalanceText] = useState<string>(
    account?.openingBalance ?? '',
  )

  const balance = parseBalance(balanceText)
  const nameValid = name.trim().length > 0
  const balanceValid = Number.isFinite(balance)
  const canSave = nameValid && balanceValid && !isSaving

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSave) return
    onSubmit({
      name: name.trim(),
      type,
      currency,
      openingBalance: toDecimalString(balance),
    })
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth={false}
      aria-labelledby={titleId}
      slotProps={{
        paper: {
          sx: {
            width: '100%',
            maxWidth: '440px',
            bgcolor: 'var(--mg-paper-2)',
            border: '1px solid var(--mg-border-2)',
            borderRadius: '20px',
          },
        },
      }}
    >
      <Box component="form" onSubmit={handleSubmit}>
      <DialogTitle id={titleId} sx={{ fontSize: 18, fontWeight: 600 }}>
        {mode === 'edit' ? t('form.editTitle') : t('form.addTitle')}
      </DialogTitle>

      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2.25 }}>
        {saveError ? (
          <Typography
            id={errorId}
            role="alert"
            sx={{ fontSize: 13 }}
            color="error.main"
          >
            {t('form.saveError')}
          </Typography>
        ) : null}

        <TextField
          id={nameId}
          label={t('form.name.label')}
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          fullWidth
          size="small"
          disabled={isSaving}
          slotProps={{ htmlInput: { 'aria-describedby': saveError ? errorId : undefined } }}
        />

        <FormControl fullWidth size="small" disabled={isSaving}>
          <InputLabel id={`${typeId}-label`}>{t('form.type.label')}</InputLabel>
          <Select
            id={typeId}
            labelId={`${typeId}-label`}
            label={t('form.type.label')}
            value={type}
            onChange={(event) => setType(event.target.value as AccountType)}
          >
            {ACCOUNT_TYPES.map((value) => (
              <MenuItem key={value} value={value}>
                {accountTypeLabel(value)}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <FormControl fullWidth size="small" disabled={isSaving || mode === 'edit'}>
          <InputLabel id={`${currencyId}-label`}>
            {t('form.currency.label')}
          </InputLabel>
          <Select
            id={currencyId}
            labelId={`${currencyId}-label`}
            label={t('form.currency.label')}
            value={currency}
            onChange={(event) => setCurrency(event.target.value as Currency)}
          >
            <MenuItem value="ARS">{t('form.currency.ars')}</MenuItem>
            <MenuItem value="USD">{t('form.currency.usd')}</MenuItem>
          </Select>
        </FormControl>
        {mode === 'edit' ? (
          <Typography
            sx={{ fontSize: 12, mt: -1.25 }}
            color="text.secondary"
          >
            {t('form.currency.lockedHelper')}
          </Typography>
        ) : null}

        <TextField
          id={balanceId}
          label={t('form.openingBalance.label')}
          value={balanceText}
          onChange={(event) => setBalanceText(event.target.value)}
          fullWidth
          size="small"
          disabled={isSaving}
          inputMode="decimal"
          helperText={t('form.openingBalance.helper')}
        />
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button
          type="button"
          onClick={onClose}
          color="secondary"
          sx={{ textTransform: 'none' }}
        >
          {t('form.cancel')}
        </Button>
        <Button
          type="submit"
          variant="contained"
          disabled={!canSave}
          sx={{ textTransform: 'none', fontWeight: 600 }}
        >
          {t('form.save')}
        </Button>
      </DialogActions>
      </Box>
    </Dialog>
  )
}

export default AccountForm
