/**
 * New-transfer dialog (ADR-135, ADR-017/019/037).
 *
 * Captures an account-to-account transfer: a `from` and `to` account (selectors
 * labeled "{institutionName} · {currency}" via {@link accountOptionLabel}), the
 * amount sent, the amount received, the date, an optional note, and a repeatable
 * fee-line section (each fee = account + amount + label → a category `"Fees"`
 * expense, ADR-135).
 *
 * Same vs cross-currency (ADR-135): when the two accounts share a currency the
 * transfer is truly net-zero — the "amount received" field is HIDDEN and
 * `amountIn := amountOut` is sent automatically. When the currencies differ both
 * fields show, and the user enters the actual amount received (the FX rate is
 * implied). Until a `to` account is picked we default `amountIn := amountOut` and
 * keep the received field hidden.
 *
 * Validation: `from` ≠ `to`; amount sent (and received, when shown) must be a
 * positive finite number; each fee line that has any input must have an account +
 * a positive amount. A failed save keeps the dialog open with input intact and
 * surfaces a calm inline message (ADR-037). The dialog traps + restores focus and
 * closes on Escape (ADR-019); every control has an associated label. The parent
 * mounts this only while open, so its draft state starts fresh on each reopen.
 */

import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import FormControl from '@mui/material/FormControl'
import FormHelperText from '@mui/material/FormHelperText'
import IconButton from '@mui/material/IconButton'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import AddIcon from '@mui/icons-material/Add'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined'
import type { Account, NewTransferInput, TransferFeeInput } from '../../mock/types'
import { accountOptionLabel } from '../transactions/presentation'
import { parseBalance, toDecimalString } from '../accounts/balance'

/** One fee row in the editable form state (raw text, validated on submit). */
interface FeeDraft {
  /** Stable React key so rows are reorder/remove-safe. */
  key: string
  accountId: string
  amountText: string
  label: string
}

export interface TransferFormProps {
  /** Whether the dialog is open. */
  open: boolean
  /** Owner's accounts (the selector options); from/to + fee accounts pick from these. */
  accounts: Account[]
  /** Whether a save mutation is in flight (disables the form / shows progress). */
  isSaving: boolean
  /** True when the last save failed — surfaces the calm inline error (ADR-037). */
  saveError: boolean
  /** Save handler; receives the assembled transfer-create input (ADR-135). */
  onSubmit: (input: NewTransferInput) => void
  /** Cancel / dismiss the dialog. */
  onClose: () => void
}

/** Today's date as `YYYY-MM-DD`, for the default + the date input `max`. */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** A monotonically-unique key for a fresh fee row. */
let feeKeySeq = 0
function nextFeeKey(): string {
  feeKeySeq += 1
  return `fee-${feeKeySeq}`
}

export function TransferForm({
  open,
  accounts,
  isSaving,
  saveError,
  onSubmit,
  onClose,
}: TransferFormProps) {
  const { t } = useTranslation('transfers')

  const titleId = useId()
  const fromId = useId()
  const toId = useId()
  const sentId = useId()
  const receivedId = useId()
  const dateId = useId()
  const noteId = useId()
  const errorId = useId()

  const [fromAccountId, setFromAccountId] = useState('')
  const [toAccountId, setToAccountId] = useState('')
  const [sentText, setSentText] = useState('')
  const [receivedText, setReceivedText] = useState('')
  const [occurredOn, setOccurredOn] = useState(today)
  const [note, setNote] = useState('')
  const [fees, setFees] = useState<FeeDraft[]>([])
  // Set once the user submits so validation messages only appear after a try.
  const [submitted, setSubmitted] = useState(false)

  const fromAccount = accounts.find((a) => a.id === fromAccountId)
  const toAccount = accounts.find((a) => a.id === toAccountId)

  // Cross-currency only when BOTH accounts are chosen and their currencies differ.
  const crossCurrency =
    !!fromAccount && !!toAccount && fromAccount.currency !== toAccount.currency

  const sent = parseBalance(sentText)
  const received = parseBalance(receivedText)
  const sentValid = Number.isFinite(sent) && sent > 0
  // When same-currency (or no `to` yet) amountIn := amountOut, so received is N/A.
  const receivedValid = !crossCurrency || (Number.isFinite(received) && received > 0)
  const sameAccount =
    fromAccountId !== '' && toAccountId !== '' && fromAccountId === toAccountId

  // A fee row counts as "in use" once it has any field filled; an in-use row must
  // resolve to an account + a positive amount. Empty rows are simply ignored.
  const feeRowState = useMemo(
    () =>
      fees.map((fee) => {
        const amount = parseBalance(fee.amountText)
        const touched =
          fee.accountId !== '' || fee.amountText.trim() !== '' || fee.label.trim() !== ''
        const valid =
          !touched || (fee.accountId !== '' && Number.isFinite(amount) && amount > 0)
        return { touched, valid, amount }
      }),
    [fees],
  )
  const feesValid = feeRowState.every((row) => row.valid)

  const canSave =
    fromAccountId !== '' &&
    toAccountId !== '' &&
    !sameAccount &&
    sentValid &&
    receivedValid &&
    feesValid &&
    !isSaving

  const updateFee = (key: string, patch: Partial<Omit<FeeDraft, 'key'>>) => {
    setFees((prev) =>
      prev.map((fee) => (fee.key === key ? { ...fee, ...patch } : fee)),
    )
  }

  const addFee = () => {
    // Default the fee account to the `from` account for convenience (ADR-135).
    setFees((prev) => [
      ...prev,
      { key: nextFeeKey(), accountId: fromAccountId, amountText: '', label: '' },
    ])
  }

  const removeFee = (key: string) => {
    setFees((prev) => prev.filter((fee) => fee.key !== key))
  }

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitted(true)
    if (!canSave) return

    const amountOut = toDecimalString(sent)
    // Same-currency / not-yet-cross transfers are net-zero: amountIn := amountOut.
    const amountIn = crossCurrency ? toDecimalString(received) : amountOut

    const feeInputs: TransferFeeInput[] = fees
      .filter((_, i) => feeRowState[i].touched)
      .map((fee) => ({
        accountId: fee.accountId,
        amount: toDecimalString(parseBalance(fee.amountText)),
        label: fee.label.trim(),
      }))

    const input: NewTransferInput = {
      fromAccountId,
      toAccountId,
      amountOut,
      amountIn,
      occurredOn,
    }
    const trimmedNote = note.trim()
    if (trimmedNote) input.note = trimmedNote
    if (feeInputs.length > 0) input.fees = feeInputs

    onSubmit(input)
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
            maxWidth: '480px',
            bgcolor: 'var(--mg-paper-2)',
            border: '1px solid var(--mg-border-2)',
            borderRadius: '20px',
          },
        },
      }}
    >
      <Box component="form" onSubmit={handleSubmit} noValidate>
        <DialogTitle id={titleId} sx={{ fontSize: 18, fontWeight: 600 }}>
          {t('form.title')}
        </DialogTitle>

        <DialogContent
          sx={{ display: 'flex', flexDirection: 'column', gap: 2.25 }}
        >
          <Typography sx={{ fontSize: 13, mt: -0.5 }} color="text.secondary">
            {t('form.intro')}
          </Typography>

          {saveError ? (
            <Typography id={errorId} role="alert" sx={{ fontSize: 13 }} color="error.main">
              {t('form.saveError')}
            </Typography>
          ) : null}

          {/* From account */}
          <FormControl
            fullWidth
            size="small"
            disabled={isSaving}
            error={submitted && (fromAccountId === '' || sameAccount)}
          >
            <InputLabel id={`${fromId}-label`}>{t('form.from.label')}</InputLabel>
            <Select
              id={fromId}
              labelId={`${fromId}-label`}
              label={t('form.from.label')}
              value={fromAccountId}
              onChange={(event) => setFromAccountId(event.target.value)}
            >
              {accounts.map((account) => (
                <MenuItem key={account.id} value={account.id}>
                  {accountOptionLabel(account)}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          {/* To account */}
          <FormControl
            fullWidth
            size="small"
            disabled={isSaving}
            error={(submitted && toAccountId === '') || sameAccount}
          >
            <InputLabel id={`${toId}-label`}>{t('form.to.label')}</InputLabel>
            <Select
              id={toId}
              labelId={`${toId}-label`}
              label={t('form.to.label')}
              value={toAccountId}
              onChange={(event) => setToAccountId(event.target.value)}
            >
              {accounts.map((account) => (
                <MenuItem key={account.id} value={account.id}>
                  {accountOptionLabel(account)}
                </MenuItem>
              ))}
            </Select>
            {sameAccount ? (
              <FormHelperText>{t('form.sameAccountError')}</FormHelperText>
            ) : null}
          </FormControl>

          {/* Amount sent (always shown). */}
          <TextField
            id={sentId}
            label={
              crossCurrency && fromAccount
                ? t('form.amountSent.labelCurrency', { currency: fromAccount.currency })
                : t('form.amountSent.label')
            }
            value={sentText}
            onChange={(event) => setSentText(event.target.value)}
            fullWidth
            size="small"
            disabled={isSaving}
            inputMode="decimal"
            error={submitted && !sentValid}
            helperText={submitted && !sentValid ? t('form.amount.invalid') : ' '}
          />

          {/* Amount received — shown ONLY when the two currencies differ (ADR-135).
              Same-currency transfers are net-zero, so amountIn := amountOut. */}
          {crossCurrency && toAccount ? (
            <TextField
              id={receivedId}
              label={t('form.amountReceived.labelCurrency', {
                currency: toAccount.currency,
              })}
              value={receivedText}
              onChange={(event) => setReceivedText(event.target.value)}
              fullWidth
              size="small"
              disabled={isSaving}
              inputMode="decimal"
              error={submitted && !receivedValid}
              helperText={
                submitted && !receivedValid
                  ? t('form.amount.invalid')
                  : t('form.amountReceived.helper')
              }
            />
          ) : null}

          {/* Date */}
          <TextField
            id={dateId}
            type="date"
            label={t('form.date.label')}
            value={occurredOn}
            onChange={(event) => setOccurredOn(event.target.value)}
            fullWidth
            size="small"
            disabled={isSaving}
            slotProps={{ inputLabel: { shrink: true }, htmlInput: { max: today() } }}
          />

          {/* Note */}
          <TextField
            id={noteId}
            label={t('form.note.label')}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            fullWidth
            size="small"
            disabled={isSaving}
            multiline
            minRows={1}
          />

          <Divider sx={{ my: 0.5 }} />

          {/* Fees — repeatable lines, each → a category "Fees" expense (ADR-135). */}
          <Box>
            <Typography sx={{ fontSize: 13, fontWeight: 600 }} component="h2">
              {t('form.fees.heading')}
            </Typography>
            <Typography sx={{ fontSize: 12.5, mb: 1 }} color="text.secondary">
              {t('form.fees.helper')}
            </Typography>

            <Stack spacing={1.5}>
              {fees.map((fee, index) => {
                const rowInvalid =
                  submitted && feeRowState[index] && !feeRowState[index].valid
                return (
                  <Box
                    key={fee.key}
                    sx={{
                      display: 'flex',
                      flexDirection: { xs: 'column', sm: 'row' },
                      gap: 1,
                      alignItems: { xs: 'stretch', sm: 'flex-start' },
                    }}
                  >
                    <FormControl
                      size="small"
                      disabled={isSaving}
                      sx={{ flex: 1.4 }}
                      error={rowInvalid && fee.accountId === ''}
                    >
                      <InputLabel id={`${fee.key}-account-label`}>
                        {t('form.fees.account')}
                      </InputLabel>
                      <Select
                        labelId={`${fee.key}-account-label`}
                        label={t('form.fees.account')}
                        value={fee.accountId}
                        onChange={(event) =>
                          updateFee(fee.key, { accountId: event.target.value })
                        }
                      >
                        {accounts.map((account) => (
                          <MenuItem key={account.id} value={account.id}>
                            {accountOptionLabel(account)}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <TextField
                      label={t('form.fees.amount')}
                      value={fee.amountText}
                      onChange={(event) =>
                        updateFee(fee.key, { amountText: event.target.value })
                      }
                      size="small"
                      disabled={isSaving}
                      inputMode="decimal"
                      sx={{ flex: 1 }}
                      error={Boolean(rowInvalid)}
                    />
                    <TextField
                      label={t('form.fees.label')}
                      value={fee.label}
                      onChange={(event) =>
                        updateFee(fee.key, { label: event.target.value })
                      }
                      size="small"
                      disabled={isSaving}
                      sx={{ flex: 1.6 }}
                    />
                    <IconButton
                      aria-label={t('form.fees.remove')}
                      onClick={() => removeFee(fee.key)}
                      disabled={isSaving}
                      size="small"
                      sx={{ alignSelf: { xs: 'flex-end', sm: 'center' } }}
                    >
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Box>
                )
              })}
            </Stack>

            <Button
              type="button"
              onClick={addFee}
              startIcon={<AddIcon />}
              disabled={isSaving}
              sx={{ mt: 1, textTransform: 'none' }}
            >
              {t('form.fees.add')}
            </Button>
          </Box>
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

export default TransferForm
