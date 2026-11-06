/**
 * Record a manual payment against a person, allocated across their open items —
 * or, for installment items, their cuotas (ADR-204/206/208/215/221, ADR-037).
 *
 * A payment settles one or more open TARGETS: a flat item as a whole, or one
 * cuota of a plan (the API requires the cuota's `installmentId`, ADR-221). The
 * owner types the amount RECEIVED; once they pause, the server's suggested
 * allocation ({@link useSuggestedAllocation} — due cuotas oldest-first, then flat
 * items newest-first, never beyond what is owed) PREFILLS the rows, which stay
 * editable. Upcoming cuotas are never suggested; they sit behind a toggle because
 * paying them is an early payment.
 *
 * The recorded payment is EXACTLY the amount received: saving is blocked until
 * the rows add up to it, so a payment is never silently recorded for less (or
 * more) than what came in. {@link AllocationBalance} offers the explicit ways to
 * balance: apply the rest to upcoming cuotas, put the rest on a chosen debt (which
 * may pay it beyond what it owes — confirmed below), or set the received amount
 * to the lines' total. Money stays a Decimal STRING at the boundary (ADR-025/034);
 * dates must sit within the API's 2000..2100 range.
 *
 * Overpayment (ADR-206): rows beyond what the person owes TODAY (due-only,
 * ADR-215 — so paying an upcoming cuota early trips it too) are rejected with a
 * typed {@link ReceivableOverpaymentError}; a row beyond what ONE item / cuota
 * owes, with an {@link AllocationExceedsTargetError}. Either swaps the form for a
 * calm confirm-warning naming the figures (and the target), and "Record anyway"
 * retries the SAME payment with `allowOverpayment: true`, which bypasses both.
 * Any other failure keeps the form open with a calm inline error.
 */

import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Skeleton from '@mui/material/Skeleton'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { ResponsiveModal } from '../../components/ResponsiveModal'
import { ErrorState } from '../../components/ErrorState'
import {
  AllocationExceedsTargetError,
  ReceivableOverpaymentError,
} from '../../api/receivablesClient'
import {
  addToRow,
  allocatedCents,
  buildAllocationTargets,
  fillUpcoming,
  includesUpcoming,
  positiveDecimal,
  suggestionValues,
  toAllocations,
  upcomingHasRoom,
} from './allocation'
import {
  AllocationBalance,
  AllocationEditor,
  OverpaymentConfirm,
  type OverpaymentConflict,
} from './AllocationEditor'
import {
  EARLIEST_DATE,
  LATEST_DATE,
  centsToDecimal,
  decimalToCents,
  isReceivableDate,
  toInputAmount,
  todayIso,
} from './installments'
import {
  useReceivablePerson,
  useRecordPayment,
  useSuggestedAllocation,
} from './queries'
import { useDebouncedValue } from './useDebouncedValue'

export interface RecordPaymentFormProps {
  /** Whether the dialog is open. */
  open: boolean
  /** The person receiving the payment. */
  personId: string
  /** The person's display name (for the subtitle). */
  personName: string
  /** Dismiss / cancel the dialog. */
  onClose: () => void
}

/** Map a payment 409 to the conflict the confirm explains, or null. */
function conflictOf(error: unknown): OverpaymentConflict | null {
  if (error instanceof ReceivableOverpaymentError) {
    return {
      kind: 'person',
      outstanding: error.outstanding,
      requested: error.requested,
    }
  }
  if (error instanceof AllocationExceedsTargetError) {
    return {
      kind: 'target',
      itemId: error.itemId,
      installmentId: error.installmentId,
      remaining: error.remaining,
      requested: error.requested,
    }
  }
  return null
}

export function RecordPaymentForm({
  open,
  personId,
  personName,
  onClose,
}: RecordPaymentFormProps) {
  const { t } = useTranslation('receivables')
  const dateId = useId()
  const amountId = useId()
  const errorId = useId()

  const personQuery = useReceivablePerson(personId)
  const recordPayment = useRecordPayment()

  const [dateText, setDateText] = useState<string>(() => todayIso())
  const [receivedText, setReceivedText] = useState('')
  // The amount the owner TYPED — what the suggestion is for. Setting the
  // received amount from the lines' total deliberately leaves it (and the rows)
  // alone.
  const [suggestFor, setSuggestFor] = useState<string | null>(null)
  // The owner's own row edits, layered over the server suggestion.
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [showUpcomingToggle, setShowUpcoming] = useState<boolean | null>(null)
  const [conflict, setConflict] = useState<OverpaymentConflict | null>(null)
  const [saveError, setSaveError] = useState(false)

  // Only OPEN targets can take an allocation: a forgiven item or cuota is no
  // longer payable (ADR-210/221) and a settled one has nothing left.
  const targets = useMemo(
    () => buildAllocationTargets(personQuery.data?.items ?? []),
    [personQuery.data?.items],
  )

  // Prefill from the server's suggestion once the typed amount settles.
  const settled = useDebouncedValue(suggestFor)
  const suggestion = useSuggestedAllocation(personId, settled)
  const suggestionIsCurrent = suggestFor !== null && settled === suggestFor
  const suggested = useMemo(
    () => (suggestionIsCurrent ? suggestionValues(suggestion.data) : {}),
    [suggestionIsCurrent, suggestion.data],
  )
  const values = useMemo(() => ({ ...suggested, ...edits }), [suggested, edits])
  const suggesting =
    suggestFor !== null && (!suggestionIsCurrent || suggestion.isFetching)

  const received = positiveDecimal(receivedText)
  const receivedCents = received !== null ? decimalToCents(received) : null
  const totalCents = allocatedCents(targets, values)
  const hasCurrent = targets.some((target) => !target.upcoming)
  const upcomingRoom = upcomingHasRoom(targets, values)
  // Nothing is due yet → open with the upcoming cuotas listed (else it looks empty).
  const showUpcoming = showUpcomingToggle ?? !hasCurrent

  const dateValid = isReceivableDate(dateText)
  const isSaving = recordPayment.isPending
  // The payment recorded is exactly what was received: the rows must match it.
  const balanced = receivedCents !== null && totalCents === receivedCents
  const canSave =
    balanced && totalCents > 0 && dateValid && !isSaving && !suggesting

  const submit = async (allowOverpayment: boolean) => {
    setSaveError(false)
    try {
      await recordPayment.mutateAsync({
        personId,
        occurredOn: dateText.trim(),
        amount: centsToDecimal(totalCents),
        allocations: toAllocations(targets, values),
        ...(allowOverpayment ? { allowOverpayment: true } : {}),
      })
      onClose()
    } catch (error) {
      const typed = conflictOf(error)
      if (typed) setConflict(typed)
      else setSaveError(true)
    }
  }

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSave) return
    void submit(false)
  }

  const rest = receivedCents !== null ? receivedCents - totalCents : 0

  const applyRestToUpcoming = () => {
    if (rest <= 0) return
    setEdits((current) => ({
      ...current,
      ...fillUpcoming(targets, values, rest),
    }))
    setShowUpcoming(true)
  }

  const putRestOn = (key: string) => {
    if (rest <= 0) return
    setEdits((current) => ({ ...current, [key]: addToRow(values[key], rest) }))
  }

  const setReceivedToTotal = () => {
    if (totalCents <= 0) return
    setReceivedText(toInputAmount(centsToDecimal(totalCents)))
  }

  let body: React.ReactNode
  if (personQuery.isPending) {
    body = (
      <Box aria-label={t('items.loadingAria')}>
        <Skeleton
          variant="rounded"
          height={48}
          sx={{ mb: 1.25, borderRadius: '10px' }}
        />
        <Skeleton variant="rounded" height={48} sx={{ borderRadius: '10px' }} />
      </Box>
    )
  } else if (personQuery.isError) {
    body = (
      <ErrorState
        title={t('items.errorTitle')}
        description={t('items.errorDescription')}
        onRetry={() => {
          void personQuery.refetch()
        }}
      />
    )
  } else if (targets.length === 0) {
    body = (
      <Typography
        sx={{ fontSize: 14, py: 1, color: 'text.secondary' }}
        role="status"
      >
        {t('payment.noOpenItems')}
      </Typography>
    )
  } else if (conflict) {
    // Confirm-warning: the rows pay more than is owed today, or more than one
    // item / cuota owes (ADR-206/215). Go back and adjust, or record it anyway.
    body = (
      <OverpaymentConfirm
        conflict={conflict}
        targets={targets}
        early={includesUpcoming(targets, values)}
        onBack={() => setConflict(null)}
        onConfirm={() => {
          setConflict(null)
          void submit(true)
        }}
        disabled={isSaving}
      />
    )
  } else {
    body = (
      <Box component="form" onSubmit={handleSubmit} noValidate>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.25 }}>
          {saveError ? (
            <Typography
              id={errorId}
              role="alert"
              // MUI v9 `color` prop ignores dotted palette paths — use `sx`.
              sx={{ fontSize: 13, color: 'error.main' }}
            >
              {t('payment.saveError')}
            </Typography>
          ) : null}

          <TextField
            id={dateId}
            type="date"
            label={t('payment.date.label')}
            value={dateText}
            onChange={(event) => setDateText(event.target.value)}
            required
            fullWidth
            size="small"
            disabled={isSaving}
            error={!dateValid}
            helperText={dateValid ? undefined : t('payment.date.error')}
            slotProps={{
              inputLabel: { shrink: true },
              htmlInput: { min: EARLIEST_DATE, max: LATEST_DATE },
            }}
          />

          <TextField
            id={amountId}
            label={t('payment.amount.label')}
            value={receivedText}
            onChange={(event) => {
              setReceivedText(event.target.value)
              // A newly typed amount means a new suggestion: drop old row edits.
              setSuggestFor(positiveDecimal(event.target.value))
              setEdits({})
            }}
            required
            fullWidth
            size="small"
            type="number"
            disabled={isSaving}
            helperText={
              suggesting
                ? t('payment.amount.suggesting')
                : suggestionIsCurrent && suggestion.isError
                  ? t('payment.amount.suggestError')
                  : t('payment.amount.helper')
            }
            slotProps={{
              htmlInput: {
                min: 0,
                step: 'any',
                inputMode: 'decimal',
                // Point at the error only when there is one, so the helper
                // text keeps its automatic description link otherwise.
                ...(saveError ? { 'aria-describedby': errorId } : {}),
              },
              formHelperText: { role: 'status' },
            }}
          />

          <AllocationEditor
            targets={targets}
            values={values}
            onChange={(key, value) =>
              setEdits((current) => ({ ...current, [key]: value }))
            }
            showUpcoming={showUpcoming}
            onToggleUpcoming={() => setShowUpcoming(!showUpcoming)}
            disabled={isSaving}
          />

          <AllocationBalance
            mode="payment"
            totalCents={totalCents}
            receivedCents={suggesting ? null : receivedCents}
            totalLabel={t('payment.totalLabel')}
            targets={targets}
            canApplyToUpcoming={upcomingRoom}
            onApplyToUpcoming={applyRestToUpcoming}
            onPutRestOn={putRestOn}
            onSetReceivedToTotal={setReceivedToTotal}
            disabled={isSaving}
          />
        </Box>

        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 3 }}>
          <Button
            type="button"
            onClick={onClose}
            color="secondary"
            sx={{ textTransform: 'none' }}
          >
            {t('payment.cancel')}
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={!canSave}
            sx={{ textTransform: 'none', fontWeight: 600 }}
          >
            {t('payment.save')}
          </Button>
        </Box>
      </Box>
    )
  }

  return (
    <ResponsiveModal
      open={open}
      onClose={onClose}
      title={t('payment.title')}
      maxWidth={480}
    >
      <Typography sx={{ fontSize: 13.5, mb: 2, mt: -1, color: 'text.secondary' }}>
        {t('payment.subtitle', { name: personName })}
      </Typography>
      {body}
    </ResponsiveModal>
  )
}

export default RecordPaymentForm
