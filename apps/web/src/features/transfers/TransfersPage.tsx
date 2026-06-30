/**
 * Transfers view (ADR-135, ADR-017/019/037).
 *
 * Lists the user's account-to-account transfers newest-first: each row shows the
 * source → destination institution+currency, the amount sent and (when it differs)
 * the amount received, the date, and an optional note, plus a delete action. A
 * "New transfer" button opens the {@link TransferForm} dialog.
 *
 * Transfers are explicitly NOT income or expense (ADR-135) — the page copy says
 * so, and the row uses a neutral "→" framing rather than a +/− sign. Deleting a
 * transfer does NOT delete the fee expenses it created (they are independent
 * transactions); the confirm-delete copy makes that clear so the user is never
 * surprised that a "Fees" expense survives the transfer's removal.
 *
 * Calm states (ADR-037): a loading skeleton, an inline error with retry, and an
 * empty-state nudge. The delete confirm dialog traps focus and is keyboard
 * dismissible (ADR-019); the row's amounts carry locale-aware currency prefixes.
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import IconButton from '@mui/material/IconButton'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import AddIcon from '@mui/icons-material/Add'
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined'
import { ResponsiveModal } from '../../components/ResponsiveModal'
import { SectionCard } from '../../components/SectionCard'
import { ErrorState } from '../../components/ErrorState'
import { formatCurrency } from '../../lib/format'
import { activeIntlLocale } from '../../i18n/locale'
import type { Account, Currency, Transfer } from '../../mock/types'
import { useAccounts } from '../accounts/queries'
import {
  useCreateTransfer,
  useDeleteTransfer,
  useTransfers,
} from './queries'
import { TransferForm } from './TransferForm'

/** Parse a Decimal-string amount to a number for the shared formatter (0 on garbage). */
function asNumber(value: string): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** Format an ISO `YYYY-MM-DD` to a readable, locale-aware date (verbatim on parse fail). */
function formatIsoDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat(activeIntlLocale(), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

/** One transfer row: from → to, amounts, date, note, and a delete action. */
function TransferRow({
  transfer,
  accountsById,
  onDelete,
}: {
  transfer: Transfer
  accountsById: Map<string, Account>
  onDelete: (transfer: Transfer) => void
}) {
  const { t } = useTranslation('transfers')
  const from = accountsById.get(transfer.fromAccountId)
  const to = accountsById.get(transfer.toAccountId)

  const fromCurrency: Currency = from?.currency ?? 'ARS'
  const toCurrency: Currency = to?.currency ?? 'ARS'
  const crossCurrency =
    transfer.amountOut !== transfer.amountIn || fromCurrency !== toCurrency

  const fromLabel = from?.institutionName ?? t('row.unknownAccount')
  const toLabel = to?.institutionName ?? t('row.unknownAccount')

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        py: 1.5,
        borderBottom: '1px solid var(--mg-border)',
        '&:last-of-type': { borderBottom: 'none' },
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        {/* From → To, each with a currency chip. Neutral arrow framing makes
            clear this is a move, not income/expense (ADR-135). */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            flexWrap: 'wrap',
            minWidth: 0,
          }}
        >
          <Typography sx={{ fontSize: 14.5, fontWeight: 600 }} color="text.primary">
            {fromLabel}
          </Typography>
          <Chip
            label={fromCurrency}
            size="small"
            variant="outlined"
            sx={{ borderRadius: '8px', fontSize: 11.5, height: 20, flex: 'none' }}
          />
          <ArrowForwardRoundedIcon
            aria-label={t('row.toAria')}
            fontSize="small"
            sx={{ color: 'text.disabled', flex: 'none' }}
          />
          <Typography sx={{ fontSize: 14.5, fontWeight: 600 }} color="text.primary">
            {toLabel}
          </Typography>
          <Chip
            label={toCurrency}
            size="small"
            variant="outlined"
            sx={{ borderRadius: '8px', fontSize: 11.5, height: 20, flex: 'none' }}
          />
        </Box>

        <Typography sx={{ fontSize: 12.5, mt: 0.5 }} color="text.secondary">
          {formatIsoDate(transfer.occurredOn)}
          {transfer.note ? ` · ${transfer.note}` : ''}
        </Typography>
      </Box>

      {/* Amounts: sent always; received too when the figures differ. */}
      <Box sx={{ textAlign: 'right', flex: 'none' }}>
        <Typography sx={{ fontSize: 14.5, fontWeight: 600 }} color="text.primary">
          {formatCurrency(asNumber(transfer.amountOut), fromCurrency)}
        </Typography>
        {crossCurrency ? (
          <Typography sx={{ fontSize: 12.5 }} color="text.secondary">
            {t('row.received', {
              amount: formatCurrency(asNumber(transfer.amountIn), toCurrency),
            })}
          </Typography>
        ) : null}
      </Box>

      <IconButton
        aria-label={t('row.deleteAria', { from: fromLabel, to: toLabel })}
        onClick={() => onDelete(transfer)}
        size="small"
        sx={{ flex: 'none' }}
      >
        <DeleteOutlineIcon fontSize="small" />
      </IconButton>
    </Box>
  )
}

export function TransfersPage() {
  const { t } = useTranslation('transfers')
  const transfersQuery = useTransfers()
  const accountsQuery = useAccounts()
  const createTransfer = useCreateTransfer()
  const deleteTransfer = useDeleteTransfer()

  const [formOpen, setFormOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<Transfer | null>(null)

  const accounts = useMemo(
    () => accountsQuery.data ?? [],
    [accountsQuery.data],
  )
  const transfers = transfersQuery.data ?? []

  const accountsById = useMemo(() => {
    const map = new Map<string, Account>()
    for (const account of accounts) map.set(account.id, account)
    return map
  }, [accounts])

  const isPending = transfersQuery.isPending || accountsQuery.isPending
  const isError = transfersQuery.isError || accountsQuery.isError

  const openForm = () => {
    createTransfer.reset()
    setFormOpen(true)
  }
  const closeForm = () => setFormOpen(false)

  const handleCreate = (input: Parameters<typeof createTransfer.mutate>[0]) => {
    createTransfer.mutate(input, { onSuccess: () => setFormOpen(false) })
  }

  const confirmDelete = () => {
    if (!pendingDelete) return
    deleteTransfer.mutate(pendingDelete.id, {
      onSuccess: () => setPendingDelete(null),
    })
  }

  const heading = (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 2,
        mb: 2.5,
      }}
    >
      <Box>
        <Typography
          component="h1"
          sx={{ fontSize: { xs: '1.25rem', md: '1.375rem' }, fontWeight: 600 }}
          color="text.primary"
        >
          {t('title')}
        </Typography>
        <Typography sx={{ fontSize: 13.5, mt: 0.25 }} color="text.secondary">
          {t('subtitle')}
        </Typography>
      </Box>
      <Button
        variant="contained"
        startIcon={<AddIcon />}
        onClick={openForm}
        disabled={accounts.length < 2 && !isPending}
        sx={{ textTransform: 'none', fontWeight: 600, flex: 'none' }}
      >
        {t('newTransfer')}
      </Button>
    </Box>
  )

  if (isError) {
    return (
      <Box>
        {heading}
        <ErrorState
          title={t('error.title')}
          description={t('error.description')}
          onRetry={() => {
            void transfersQuery.refetch()
            void accountsQuery.refetch()
          }}
        />
      </Box>
    )
  }

  return (
    <Box>
      {heading}

      {isPending ? (
        <SectionCard title={t('list.title')}>
          <Skeleton variant="rounded" height={56} sx={{ mb: 1.25, borderRadius: '10px' }} />
          <Skeleton variant="rounded" height={56} sx={{ mb: 1.25, borderRadius: '10px' }} />
          <Skeleton variant="rounded" height={56} sx={{ borderRadius: '10px' }} />
        </SectionCard>
      ) : transfers.length === 0 ? (
        <SectionCard title={t('list.title')}>
          <Typography sx={{ fontSize: 14, py: 2 }} color="text.secondary" role="status">
            {accounts.length < 2 ? t('list.needAccounts') : t('list.empty')}
          </Typography>
        </SectionCard>
      ) : (
        <SectionCard title={t('list.title')}>
          {transfers.map((transfer) => (
            <TransferRow
              key={transfer.id}
              transfer={transfer}
              accountsById={accountsById}
              onDelete={setPendingDelete}
            />
          ))}
        </SectionCard>
      )}

      {/* Mounted only while open so its internal draft state starts fresh each
          time the dialog is reopened (no reset effect needed). */}
      {formOpen ? (
        <TransferForm
          open
          accounts={accounts}
          isSaving={createTransfer.isPending}
          saveError={createTransfer.isError}
          onSubmit={handleCreate}
          onClose={closeForm}
        />
      ) : null}

      {/* Delete confirm. Copy spells out that the transfer's fee expenses are
          independent and are NOT removed (ADR-135). A compact desktop size, but
          still a bottom sheet on mobile via the shared ResponsiveModal. */}
      <ResponsiveModal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title={t('delete.title')}
        maxWidth={420}
      >
        <Typography sx={{ fontSize: 14 }} color="text.secondary">
          {t('delete.body')}
        </Typography>
        {deleteTransfer.isError ? (
          <Typography role="alert" sx={{ fontSize: 13, mt: 1.5 }} color="error.main">
            {t('delete.error')}
          </Typography>
        ) : null}
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
            onClick={() => setPendingDelete(null)}
            color="secondary"
            sx={{ textTransform: 'none' }}
          >
            {t('delete.cancel')}
          </Button>
          <Button
            type="button"
            onClick={confirmDelete}
            color="error"
            variant="contained"
            disabled={deleteTransfer.isPending}
            sx={{ textTransform: 'none', fontWeight: 600 }}
          >
            {t('delete.confirm')}
          </Button>
        </Box>
      </ResponsiveModal>
    </Box>
  )
}

export default TransfersPage
