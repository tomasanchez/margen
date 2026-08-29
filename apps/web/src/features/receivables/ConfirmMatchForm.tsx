/**
 * Confirm a suggested income match as a payment, allocated across a person's open
 * items (ADR-206/207, ADR-037).
 *
 * Income matching is SUGGESTION-ONLY (ADR-207): nothing auto-applies. When the
 * owner picks a ranked {@link MatchSuggestion} from {@link MatchSuggestions}, this
 * dialog opens to let them settle it — reusing the exact allocate-across-open-items
 * pattern of {@link RecordPaymentForm}, but writing through {@link useConfirmMatch}
 * (which records a `receivable_payment` with `source='matched_income'` linked to the
 * income transaction, ADR-204). The dialog seeds a sensible default allocation
 * (greedily filling each open item up to the income's amount) that the owner can
 * edit before confirming.
 *
 * Money stays a Decimal STRING end-to-end (ADR-025/034): each allocation is typed
 * free-form, parsed only to sum the total and drop zero rows, and serialized to the
 * fixed 2-decimal string the API expects. On the typed 409
 * {@link ReceivableOverpaymentError} (the allocation would push the person past
 * their outstanding), the footer swaps for the same calm confirm-warning as the
 * manual flow; "Record anyway" retries the SAME confirm with `allowOverpayment:
 * true`. Any other failure keeps the dialog open with a calm inline error (ADR-037).
 *
 * On success the dialog closes and the hook invalidates the person's match
 * suggestions, so the now-claimed income drops off the suggestions list (ADR-207).
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Skeleton from '@mui/material/Skeleton'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { ResponsiveModal } from '../../components/ResponsiveModal'
import { ErrorState } from '../../components/ErrorState'
import {
  ReceivableOverpaymentError,
  type MatchSuggestion,
  type PaymentAllocationInput,
  type ReceivableItem,
} from '../../api/receivablesClient'
import { formatCurrency } from '../../lib/format'
import { parseBalance, toDecimalString } from '../accounts/balance'
import { useConfirmMatch, useReceivablePerson } from './queries'

/** Parse a Decimal string to a number for the display edge (0 on a bad value). */
function num(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** The pending overpayment amounts surfaced by the typed 409 (ADR-206). */
interface Overpayment {
  outstanding: string
  requested: string
}

/**
 * Seed a default allocation for the suggested income: fill each open item (in
 * order) up to its remaining until the income's amount is exhausted (ADR-206). A
 * calm one-click default the owner can still edit before confirming.
 */
function seedAllocations(
  openItems: ReceivableItem[],
  incomeAmount: number,
): Record<string, string> {
  const out: Record<string, string> = {}
  let left = incomeAmount
  for (const item of openItems) {
    if (left <= 0) break
    const remaining = num(item.remaining)
    const alloc = Math.min(remaining, left)
    if (alloc > 0) {
      out[item.id] = toDecimalString(alloc)
      left -= alloc
    }
  }
  return out
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

  const [allocations, setAllocations] = useState<Record<string, string>>({})
  const [overpayment, setOverpayment] = useState<Overpayment | null>(null)
  const [saveError, setSaveError] = useState(false)
  const seededRef = useRef(false)

  // Only OPEN items (something still owed AND not forgiven) can take an
  // allocation: a pardoned item (ADR-210) is no longer a valid payment target
  // (the API would 404 it), so it never seeds nor appears in the allocation list.
  const openItems = useMemo<ReceivableItem[]>(
    () =>
      (personQuery.data?.items ?? []).filter(
        (it) => !it.pardoned && num(it.remaining) > 0,
      ),
    [personQuery.data?.items],
  )

  // Seed the default allocation once the items arrive (greedy, editable after).
  useEffect(() => {
    if (seededRef.current || openItems.length === 0) return
    seededRef.current = true
    setAllocations(seedAllocations(openItems, num(suggestion.amount)))
  }, [openItems, suggestion.amount])

  const total = useMemo(() => {
    let sum = 0
    for (const value of Object.values(allocations)) {
      const parsed = parseBalance(value)
      if (Number.isFinite(parsed) && parsed > 0) sum += parsed
    }
    return sum
  }, [allocations])

  const isSaving = confirmMatch.isPending
  const canSave = total > 0 && !isSaving

  const buildAllocations = (): PaymentAllocationInput[] => {
    const out: PaymentAllocationInput[] = []
    for (const item of openItems) {
      const parsed = parseBalance(allocations[item.id] ?? '')
      if (Number.isFinite(parsed) && parsed > 0) {
        out.push({ itemId: item.id, amount: toDecimalString(parsed) })
      }
    }
    return out
  }

  const submit = async (allowOverpayment: boolean) => {
    setSaveError(false)
    try {
      await confirmMatch.mutateAsync({
        personId,
        matchedIncomeTransactionId: suggestion.transactionId,
        allocations: buildAllocations(),
        ...(allowOverpayment ? { allowOverpayment: true } : {}),
      })
      onClose()
    } catch (error) {
      if (error instanceof ReceivableOverpaymentError) {
        setOverpayment({
          outstanding: error.outstanding,
          requested: error.requested,
        })
      } else {
        setSaveError(true)
      }
    }
  }

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSave) return
    void submit(false)
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
  } else if (openItems.length === 0) {
    body = (
      <Typography sx={{ fontSize: 14, py: 1 }} color="text.secondary" role="status">
        {t('confirmMatch.noOpenItems')}
      </Typography>
    )
  } else if (overpayment) {
    // Confirm-warning: the total exceeds outstanding (ADR-206). The user can go
    // back and adjust, or explicitly record it anyway as a credit.
    body = (
      <Box>
        <Typography
          role="alert"
          sx={{ fontSize: 14, color: 'warning.main', fontWeight: 600 }}
        >
          {t('confirmMatch.overpayment.title')}
        </Typography>
        <Typography sx={{ fontSize: 13.5, mt: 1 }} color="text.secondary">
          {t('confirmMatch.overpayment.body', {
            requested: formatCurrency(num(overpayment.requested), 'ARS'),
            outstanding: formatCurrency(num(overpayment.outstanding), 'ARS'),
          })}
        </Typography>
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 3 }}>
          <Button
            type="button"
            onClick={() => setOverpayment(null)}
            color="secondary"
            sx={{ textTransform: 'none' }}
          >
            {t('confirmMatch.overpayment.cancel')}
          </Button>
          <Button
            type="button"
            onClick={() => {
              setOverpayment(null)
              void submit(true)
            }}
            color="warning"
            variant="contained"
            disabled={isSaving}
            sx={{ textTransform: 'none', fontWeight: 600 }}
          >
            {t('confirmMatch.overpayment.confirm')}
          </Button>
        </Box>
      </Box>
    )
  } else {
    body = (
      <Box component="form" onSubmit={handleSubmit}>
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
            <Typography sx={{ fontSize: 12, fontWeight: 600 }} color="text.secondary">
              {t('confirmMatch.incomeLabel')}
            </Typography>
            <Typography
              sx={{ fontSize: 14, fontWeight: 600, mt: 0.25 }}
              color="text.primary"
              noWrap
            >
              {suggestion.name}
            </Typography>
            <Typography sx={{ fontSize: 12.5, mt: 0.25 }} color="text.secondary">
              {t('confirmMatch.incomeSummary', {
                amount: formatCurrency(num(suggestion.amount), 'ARS'),
                date: suggestion.occurredOn,
              })}
            </Typography>
          </Box>

          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            {openItems.map((item) => (
              <Box
                key={item.id}
                sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography
                    sx={{ fontSize: 13.5, fontWeight: 600 }}
                    color="text.primary"
                    noWrap
                  >
                    {item.detail ?? item.occurredOn}
                  </Typography>
                  <Typography sx={{ fontSize: 12.5, mt: 0.25 }} color="text.secondary">
                    {t('confirmMatch.remainingHint', {
                      amount: formatCurrency(num(item.remaining), 'ARS'),
                    })}
                  </Typography>
                </Box>
                <TextField
                  value={allocations[item.id] ?? ''}
                  onChange={(event) =>
                    setAllocations((prev) => ({
                      ...prev,
                      [item.id]: event.target.value,
                    }))
                  }
                  size="small"
                  inputMode="decimal"
                  disabled={isSaving}
                  sx={{ width: '120px', flex: 'none' }}
                  slotProps={{
                    htmlInput: {
                      'aria-label': t('confirmMatch.allocationAria', {
                        date: item.occurredOn,
                      }),
                    },
                  }}
                />
              </Box>
            ))}
          </Box>

          <Box
            sx={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 1,
              pt: 0.5,
              borderTop: '1px solid var(--mg-border)',
            }}
          >
            <Typography sx={{ fontSize: 13.5 }} color="text.secondary">
              {t('confirmMatch.totalLabel')}
            </Typography>
            <Typography
              sx={{
                fontSize: 14,
                fontWeight: 600,
                fontVariantNumeric: 'tabular-nums',
              }}
              color="text.primary"
            >
              {formatCurrency(total, 'ARS')}
            </Typography>
          </Box>
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
      <Typography sx={{ fontSize: 13.5, mb: 2, mt: -1 }} color="text.secondary">
        {t('confirmMatch.subtitle', { name: personName })}
      </Typography>
      {body}
    </ResponsiveModal>
  )
}

export default ConfirmMatchForm
