/**
 * Add / edit a per-currency account under an institution in a dialog
 * (ADR-134, ADR-017/019/037).
 *
 * Under ADR-134 an account is a per-currency leaf: its name + type come from the
 * owning institution, so this form captures only the native currency (ARS / USD)
 * and the opening balance. Opening balance stays a Decimal STRING end-to-end
 * (ADR-025/034) — typed as text, validated for a finite number, and sent verbatim
 * to the backend. On save it picks the create vs update mutation from the
 * `account` prop (edit when present), attaching to `institution`, and closes on
 * success; a failure keeps the dialog open with the user's input intact and
 * surfaces a calm inline message (ADR-037). Currency is locked on edit (ADR-123):
 * changing an account's native currency would reinterpret its stored balances, so
 * the field is disabled for an existing account.
 *
 * Keyboard + focus: the MUI Dialog traps focus, restores it to the trigger on
 * close, and Escape closes (ADR-019). Every control has an associated label.
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
import type { Account, Currency, Institution } from '../../mock/types'
import type { AccountWriteBody } from '../../api/accountsClient'
import { parseBalance, toDecimalString } from './balance'

export interface AccountFormProps {
  /** Whether the dialog is open. */
  open: boolean
  /** The institution this account belongs to (its name labels the dialog). */
  institution: Institution
  /** The account being edited, or `null` to add a new one under the institution. */
  account: Account | null
  /** Whether a save mutation is in flight (disables the form / shows progress). */
  isSaving: boolean
  /** True when the last save failed — surfaces the calm inline error (ADR-037). */
  saveError: boolean
  /** Save handler; receives the assembled write body (institutionId injected). */
  onSubmit: (input: AccountWriteBody) => void
  /** Cancel / dismiss the dialog. */
  onClose: () => void
}

export function AccountForm({
  open,
  institution,
  account,
  isSaving,
  saveError,
  onSubmit,
  onClose,
}: AccountFormProps) {
  const { t } = useTranslation('accounts')
  const mode = account ? 'edit' : 'add'

  const currencyId = useId()
  const balanceId = useId()
  const errorId = useId()

  const [currency, setCurrency] = useState<Currency>(account?.currency ?? 'ARS')
  // Opening balance as the raw string the user types (Decimal string preserved).
  const [balanceText, setBalanceText] = useState<string>(
    account?.openingBalance ?? '',
  )

  const balance = parseBalance(balanceText)
  const balanceValid = Number.isFinite(balance)
  const canSave = balanceValid && !isSaving

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSave) return
    onSubmit({
      institutionId: institution.id,
      currency,
      openingBalance: toDecimalString(balance),
    })
  }

  const title =
    mode === 'edit'
      ? t('form.editTitle', { institution: institution.name })
      : t('form.addTitle', { institution: institution.name })

  return (
    <ResponsiveModal
      open={open}
      onClose={onClose}
      title={title}
      maxWidth={440}
    >
      <Box component="form" onSubmit={handleSubmit}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.25 }}>
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

          <FormControl
            fullWidth
            size="small"
            disabled={isSaving || mode === 'edit'}
          >
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
            <Typography sx={{ fontSize: 12, mt: -1.25 }} color="text.secondary">
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
        </Box>

        <Box
          sx={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 1,
            mt: 3,
          }}
        >
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
        </Box>
      </Box>
    </ResponsiveModal>
  )
}

export default AccountForm
