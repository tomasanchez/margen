/**
 * Confirm a suggested income match as a payment, allocated across a person's open
 * items — or, for installment items, their cuotas (ADR-206/207/215/221, ADR-037).
 *
 * Income matching is SUGGESTION-ONLY (ADR-207): nothing auto-applies. When the
 * owner picks a ranked {@link MatchSuggestion} from {@link MatchSuggestions}, this
 * dialog opens to let them settle it — reusing the allocation editor of
 * {@link RecordPaymentForm}, but writing through {@link useConfirmMatch} (which
 * records a `receivable_payment` with `source='matched_income'` linked to the
 * income transaction, ADR-204). The rows are PREFILLED from the server's
 * suggested allocation for the income's amount (due cuotas oldest-first, then
 * flat items newest-first, never beyond what is owed, ADR-221) and stay editable;
 * installment rows carry their cuota's `installmentId`.
 *
 * The amount received IS the income's amount and isn't editable. Saving needs the
 * rows to add up to it — or, when they add up to less, an explicit
 * acknowledgement: confirming CLAIMS the income, so whatever isn't assigned can
 * never be matched to anyone again (ADR-207). Rows can never exceed the income.
 * {@link AllocationBalance} offers the explicit ways to assign the rest (apply it
 * to upcoming cuotas, or put it on a chosen debt — possibly beyond what that debt
 * owes, confirmed below).
 *
 * On a typed 409 — {@link ReceivableOverpaymentError} (more than owed today,
 * including when the rows pay upcoming cuotas early, ADR-215) or
 * {@link AllocationExceedsTargetError} (more than one item / cuota owes) — the
 * form swaps for the same calm confirm-warning as the manual flow; "Record
 * anyway" retries the SAME confirm with `allowOverpayment: true`. Any other
 * failure keeps the dialog open with a calm inline error (ADR-037). On success the
 * hook invalidates the receivables tree, so the now-claimed income drops off every
 * suggestions list (ADR-207).
 */

import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { ResponsiveModal } from '../../components/ResponsiveModal'
import { ErrorState } from '../../components/ErrorState'
import {
  AllocationExceedsTargetError,
  ReceivableOverpaymentError,
  type MatchSuggestion,
} from '../../api/receivablesClient'
import { formatCurrency } from '../../lib/format'
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
import { centsToDecimal, decimalToCents } from './installments'
import {
  useConfirmMatch,
  useReceivablePerson,
  useSuggestedAllocation,
} from './queries'

/** Parse a Decimal string to a number for the display edge (0 on a bad value). */
function num(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Map a confirm-match 409 to the conflict the confirm explains, or null. */
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

export interface ConfirmMatchFormProps {
  /** Whether the dialog is open. */
  open: boolean
  /** The person being paid. */
  personId: string
  /** The person's display name (for the subtitle). */
  personName: string
  /** The suggested income the owner chose to settle from (ADR-207). */
  suggestion: MatchSuggestion
  /** Dismiss / cancel the dialog. */
  onClose: () => void
}

export function ConfirmMatchForm({
  open,
  personId,
  personName,
  suggestion,
  onClose,
}: ConfirmMatchFormProps) {
  const { t } = useTranslation('receivables')
  const errorId = useId()

  const personQuery = useReceivablePerson(personId)
  const confirmMatch = useConfirmMatch()

  // The owner's own row edits, layered over the server suggestion.
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [showUpcomingToggle, setShowUpcoming] = useState<boolean | null>(null)
  const [conflict, setConflict] = useState<OverpaymentConflict | null>(null)
  const [saveError, setSaveError] = useState(false)
  // Explicit consent to claim the income for less than its amount (ADR-207).
  const [shortfallAcknowledged, setShortfallAcknowledged] = useState(false)

  // Only OPEN targets can take an allocation: a forgiven item or cuota is no
  // longer payable (ADR-210/221) and a settled one has nothing left.
  const targets = useMemo(
    () => buildAllocationTargets(personQuery.data?.items ?? []),
    [personQuery.data?.items],
  )

  // Prefill from the server's default spread of the income's amount (ADR-221).
  const incomeAmount = positiveDecimal(suggestion.amount)
  const incomeCents = incomeAmount !== null ? decimalToCents(incomeAmount) : null
  const suggested = useSuggestedAllocation(personId, incomeAmount)
  const prefill = useMemo(() => suggestionValues(suggested.data), [suggested.data])
  const values = useMemo(() => ({ ...prefill, ...edits }), [prefill, edits])

  const totalCents = allocatedCents(targets, values)
  const hasCurrent = targets.some((target) => !target.upcoming)
  const showUpcoming = showUpcomingToggle ?? !hasCurrent
  const rest = incomeCents !== null ? incomeCents - totalCents : 0

  const isSaving = confirmMatch.isPending
  // Rows never exceed the income; less than it needs the owner's consent.
  const balanced =
    incomeCents !== null &&
    (rest === 0 || (rest > 0 && shortfallAcknowledged))
  const canSave = totalCents > 0 && balanced && !isSaving

  const submit = async (allowOverpayment: boolean) => {
    setSaveError(false)
    try {
      await confirmMatch.mutateAsync({
        personId,
        // The API's ConfirmMatchRequest REQUIRES both. `occurredOn` is the
        // matched income's date (the payback date); `amount` is the allocation
        // sum — the income itself, or less when the owner accepted that.
        occurredOn: suggestion.occurredOn,
        amount: centsToDecimal(totalCents),
        matchedIncomeTransactionId: suggestion.transactionId,
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

  // Consent covers specific amounts: any change to the rows withdraws it.
  const editRows = (next: (current: Record<string, string>) => Record<string, string>) => {
    setEdits(next)
    setShortfallAcknowledged(false)
  }

  const applyRestToUpcoming = () => {
    if (rest <= 0) return
    editRows((current) => ({
      ...current,
      ...fillUpcoming(targets, values, rest),
    }))
    setShowUpcoming(true)
  }

  const putRestOn = (key: string) => {
    if (rest <= 0) return
    editRows((current) => ({ ...current, [key]: addToRow(values[key], rest) }))
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
        {t('confirmMatch.noOpenItems')}
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
              {t('confirmMatch.saveError')}
            </Typography>
          ) : null}

          {/* The matched income being settled (name + amount + date). */}
          <Box
            sx={{
              p: 1.5,
              borderRadius: '10px',
              bgcolor: 'var(--mg-raised)',
              border: '1px solid var(--mg-border-2)',
            }}
          >
            <Typography sx={{ fontSize: 12, fontWeight: 600, color: 'text.secondary' }}>
              {t('confirmMatch.incomeLabel')}
            </Typography>
            <Typography
              sx={{ fontSize: 14, fontWeight: 600, mt: 0.25, color: 'text.primary' }}
              noWrap
            >
              {suggestion.name}
            </Typography>
            <Typography sx={{ fontSize: 12.5, mt: 0.25, color: 'text.secondary' }}>
              {t('confirmMatch.incomeSummary', {
                amount: formatCurrency(num(suggestion.amount), 'ARS'),
                date: suggestion.occurredOn,
              })}
            </Typography>
          </Box>

          {suggested.isPending && incomeAmount !== null ? (
            <Typography
              role="status"
              sx={{ fontSize: 12.5, color: 'text.secondary' }}
            >
              {t('confirmMatch.suggesting')}
            </Typography>
          ) : null}
          {suggested.isError ? (
            <Typography
              role="status"
              sx={{ fontSize: 12.5, color: 'text.secondary' }}
            >
              {t('confirmMatch.suggestError')}
            </Typography>
          ) : null}

          <AllocationEditor
            targets={targets}
            values={values}
            onChange={(key, value) =>
              editRows((current) => ({ ...current, [key]: value }))
            }
            showUpcoming={showUpcoming}
            onToggleUpcoming={() => setShowUpcoming(!showUpcoming)}
            disabled={isSaving}
          />

          <AllocationBalance
            mode="income"
            totalCents={totalCents}
            receivedCents={
              incomeCents !== null && !suggested.isPending ? incomeCents : null
            }
            totalLabel={t('confirmMatch.totalLabel')}
            targets={targets}
            canApplyToUpcoming={upcomingHasRoom(targets, values)}
            onApplyToUpcoming={applyRestToUpcoming}
            onPutRestOn={putRestOn}
            shortfallAcknowledged={shortfallAcknowledged}
            onAcknowledgeShortfall={setShortfallAcknowledged}
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
            {t('confirmMatch.cancel')}
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={!canSave}
            sx={{ textTransform: 'none', fontWeight: 600 }}
          >
            {t('confirmMatch.save')}
          </Button>
        </Box>
      </Box>
    )
  }

  return (
    <ResponsiveModal
      open={open}
      onClose={onClose}
      title={t('confirmMatch.title')}
      maxWidth={480}
    >
      <Typography sx={{ fontSize: 13.5, mb: 2, mt: -1, color: 'text.secondary' }}>
        {t('confirmMatch.subtitle', { name: personName })}
      </Typography>
      {body}
    </ResponsiveModal>
  )
}

export default ConfirmMatchForm
