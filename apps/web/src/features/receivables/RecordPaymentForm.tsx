/**
 * Record a manual payment against a person, allocated across their open items
 * (ADR-204/206/208, ADR-037).
 *
 * A payment settles one or more of a person's outstanding items (ADR-206). This
 * form fetches the person's current items ({@link useReceivablePerson} — always
 * fresh, never a mutation return shape), lists the OPEN ones (remaining > 0) with
 * a per-item allocation field, and records the total as one payment via
 * {@link useRecordPayment}. Money stays a Decimal STRING end-to-end (ADR-025/034):
 * each allocation is typed free-form, parsed only to sum the total and to drop
 * zero rows, and serialized to the fixed 2-decimal string the API expects.
 *
 * Overpayment (ADR-206): if the total allocated would exceed the person's
 * outstanding, the API rejects with a typed {@link ReceivableOverpaymentError}
 * (surfaced by {@link useRecordPayment} through `mutateAsync`). We catch it and
 * swap the footer for a calm confirm-warning showing the returned `outstanding` /
 * `requested`; "Record anyway" retries the SAME payment with
 * `allowOverpayment: true`. Any other failure keeps the form open with a calm
 * inline error (never a silent clamp, never a silent negative outstanding).
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
  ReceivableOverpaymentError,
  type PaymentAllocationInput,
  type ReceivableItem,
} from '../../api/receivablesClient'
import { formatCurrency } from '../../lib/format'
import { parseBalance, toDecimalString } from '../accounts/balance'
import { useReceivablePerson, useRecordPayment } from './queries'

/** Parse a Decimal string to a number for the display edge (0 on a bad value). */
function num(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Today's date as an ISO `YYYY-MM-DD` string, seeding the payment date. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

/** The pending overpayment amounts surfaced by the typed 409 (ADR-206). */
interface Overpayment {
  outstanding: string
  requested: string
}

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

export function RecordPaymentForm({
  open,
  personId,
  personName,
  onClose,
}: RecordPaymentFormProps) {
  const { t } = useTranslation('receivables')
  const dateId = useId()
  const errorId = useId()

  const personQuery = useReceivablePerson(personId)
  const recordPayment = useRecordPayment()

  const [dateText, setDateText] = useState<string>(todayIso())
  const [allocations, setAllocations] = useState<Record<string, string>>({})
  const [overpayment, setOverpayment] = useState<Overpayment | null>(null)
  const [saveError, setSaveError] = useState(false)

  // Only OPEN items (something still owed AND not forgiven) can take an
  // allocation: a pardoned item (ADR-210) is no longer a valid payment target
  // (the API would 404 it), so it never appears in the allocation list.
  const openItems = useMemo<ReceivableItem[]>(
    () =>
      (personQuery.data?.items ?? []).filter(
        (it) => !it.pardoned && num(it.remaining) > 0,
      ),
    [personQuery.data?.items],
  )

  // The payment total is the sum of its allocations — so the allocation sum can
  // never exceed the payment amount (the API's hard 422 case, ADR-206).
  const total = useMemo(() => {
    let sum = 0
    for (const value of Object.values(allocations)) {
      const parsed = parseBalance(value)
      if (Number.isFinite(parsed) && parsed > 0) sum += parsed
    }
    return sum
  }, [allocations])

  const isSaving = recordPayment.isPending
  const canSave = total > 0 && dateText.trim().length > 0 && !isSaving

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
      await recordPayment.mutateAsync({
        personId,
        occurredOn: dateText.trim(),
        amount: toDecimalString(total),
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
        {t('payment.noOpenItems')}
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
          {t('payment.overpayment.title')}
        </Typography>
        <Typography sx={{ fontSize: 13.5, mt: 1 }} color="text.secondary">
          {t('payment.overpayment.body', {
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
            {t('payment.overpayment.cancel')}
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
            {t('payment.overpayment.confirm')}
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
            slotProps={{ inputLabel: { shrink: true } }}
          />

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
                    {t('payment.remainingHint', {
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
                  type="number"
                  disabled={isSaving}
                  sx={{ width: '120px', flex: 'none' }}
                  slotProps={{
                    htmlInput: {
                      // `type="number"` gives a clean mobile numeric keypad;
                      // `inputMode="decimal"` + `step="any"` keep decimals, and
                      // `min={0}` rejects negatives. Money still flows as a
                      // Decimal string via parseBalance/toDecimalString (ADR-025).
                      min: 0,
                      step: 'any',
                      inputMode: 'decimal',
                      'aria-label': t('payment.allocationAria', {
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
              {t('payment.totalLabel')}
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
      <Typography sx={{ fontSize: 13.5, mb: 2, mt: -1 }} color="text.secondary">
        {t('payment.subtitle', { name: personName })}
      </Typography>
      {body}
    </ResponsiveModal>
  )
}

export default RecordPaymentForm
