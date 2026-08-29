/**
 * Add / edit one itemized debt for a receivables person (ADR-204/208,
 * ADR-017/019/037).
 *
 * A receivable item is a single debt a person owes: a date, an amount, and an
 * optional free-text justification (ADR-204). This form owns both flows — create
 * (no `item`) via {@link useAddReceivableItem} and edit (an existing `item`) via
 * {@link useEditReceivableItem}. Both mutations invalidate the people list + that
 * person's detail (task 7), so the section reads fresh data; this form never
 * relies on a mutation's return shape.
 *
 * Money stays a Decimal STRING end-to-end (ADR-025/034): the amount is typed
 * free-form, validated for a finite non-negative number, and serialized to the
 * fixed 2-decimal string the API expects (shared {@link parseBalance} /
 * {@link toDecimalString}). The date is an ISO `YYYY-MM-DD` string. On failure the
 * dialog stays open with input intact and shows a calm inline error (ADR-037).
 */

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { ResponsiveModal } from '../../components/ResponsiveModal'
import type { ReceivableItem } from '../../api/receivablesClient'
import { parseBalance, toDecimalString } from '../accounts/balance'
import { useAddReceivableItem, useEditReceivableItem } from './queries'

/** Today's date as an ISO `YYYY-MM-DD` string, used to seed the add form. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export interface ReceivableItemFormProps {
  /** Whether the dialog is open. */
  open: boolean
  /** The person this item belongs to. */
  personId: string
  /** The item being edited, or `null` to add a new one. */
  item: ReceivableItem | null
  /** Dismiss / cancel the dialog. */
  onClose: () => void
}

export function ReceivableItemForm({
  open,
  personId,
  item,
  onClose,
}: ReceivableItemFormProps) {
  const { t } = useTranslation('receivables')
  const mode = item ? 'edit' : 'add'

  const dateId = useId()
  const amountId = useId()
  const detailId = useId()
  const errorId = useId()

  const [dateText, setDateText] = useState<string>(item?.occurredOn ?? todayIso())
  const [amountText, setAmountText] = useState<string>(item?.amount ?? '')
  const [detailText, setDetailText] = useState<string>(item?.detail ?? '')

  const addItem = useAddReceivableItem()
  const editItem = useEditReceivableItem()
  const isSaving = addItem.isPending || editItem.isPending
  const saveError = addItem.isError || editItem.isError

  const amount = parseBalance(amountText)
  // Mirror the backend invariant: a finite amount ≥ 0.
  const amountValid = Number.isFinite(amount) && amount >= 0
  const dateValid = dateText.trim().length > 0
  const canSave = amountValid && dateValid && !isSaving

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSave) return
    const occurredOn = dateText.trim()
    const amountString = toDecimalString(amount)
    const detail = detailText.trim()
    if (item) {
      editItem.mutate(
        { personId, itemId: item.id, occurredOn, amount: amountString, detail },
        { onSuccess: onClose },
      )
    } else {
      addItem.mutate(
        { personId, occurredOn, amount: amountString, detail },
        { onSuccess: onClose },
      )
    }
  }

  const title =
    mode === 'edit' ? t('itemForm.editTitle') : t('itemForm.addTitle')

  return (
    <ResponsiveModal open={open} onClose={onClose} title={title} maxWidth={440}>
      <Box component="form" onSubmit={handleSubmit}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.25 }}>
          {saveError ? (
            <Typography
              id={errorId}
              role="alert"
              // MUI v9 `color` prop ignores dotted palette paths — use `sx`.
              sx={{ fontSize: 13, color: 'error.main' }}
            >
              {t('itemForm.saveError')}
            </Typography>
          ) : null}

          <TextField
            id={dateId}
            type="date"
            label={t('itemForm.date.label')}
            value={dateText}
            onChange={(event) => setDateText(event.target.value)}
            required
            fullWidth
            size="small"
            disabled={isSaving}
            slotProps={{ inputLabel: { shrink: true } }}
          />

          <TextField
            id={amountId}
            label={t('itemForm.amount.label')}
            value={amountText}
            onChange={(event) => setAmountText(event.target.value)}
            required
            fullWidth
            size="small"
            disabled={isSaving}
            type="number"
            helperText={t('itemForm.amount.helper')}
            slotProps={{
              htmlInput: {
                // `type="number"` gives a clean mobile numeric keypad;
                // `inputMode="decimal"` + `step="any"` keep decimals, and
                // `min={0}` rejects negatives. Money still flows as a Decimal
                // string via parseBalance/toDecimalString (ADR-025).
                min: 0,
                step: 'any',
                inputMode: 'decimal',
                'aria-describedby': saveError ? errorId : undefined,
              },
            }}
          />

          <TextField
            id={detailId}
            label={t('itemForm.detail.label')}
            value={detailText}
            onChange={(event) => setDetailText(event.target.value)}
            fullWidth
            size="small"
            disabled={isSaving}
            helperText={t('itemForm.detail.helper')}
          />
        </Box>

        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 3 }}>
          <Button
            type="button"
            onClick={onClose}
            color="secondary"
            sx={{ textTransform: 'none' }}
          >
            {t('itemForm.cancel')}
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={!canSave}
            sx={{ textTransform: 'none', fontWeight: 600 }}
          >
            {t('itemForm.save')}
          </Button>
        </Box>
      </Box>
    </ResponsiveModal>
  )
}

export default ReceivableItemForm
