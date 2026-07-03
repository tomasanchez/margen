/**
 * Debts section for the Accounts page (ADR-187, ADR-127/172 — no new nav).
 *
 * A self-contained section that lists the user's manual debts and offers add /
 * edit / delete, reusing the app's form + modal conventions ({@link DebtForm} over
 * the shared {@link ResponsiveModal}, a bottom sheet on mobile). It mirrors the
 * institution/account patterns on {@link AccountsPage}: a {@link SectionCard} with
 * an "Add debt" header action, a calm loading skeleton, a calm error state
 * (ADR-037), and an inviting empty state.
 *
 * Each row shows the debt name + its current balance (the formatted amount carries
 * the currency, so no separate currency chip) and, when set, its monthly minimum
 * and rate. Delete goes through a calm confirm dialog (ADR-019) whose copy notes
 * the debt is removed from net worth. Every write invalidates the debts list AND
 * the net-worth query (the "other debts" leg depends on debts, ADR-187), wired in
 * {@link useCreateDebt} / {@link useUpdateDebt} / {@link useDeleteDebt}.
 *
 * Money is a Decimal string end-to-end (ADR-025/034), parsed only here at the
 * display edge (ADR-102). Balances are shown natively (no FX in this section) —
 * the cross-currency conversion happens on the net-worth card (ADR-183).
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import AddIcon from '@mui/icons-material/Add'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined'
import EditOutlinedIcon from '@mui/icons-material/EditOutlined'
import { SectionCard } from '../../components/SectionCard'
import { ErrorState } from '../../components/ErrorState'
import { ResponsiveModal } from '../../components/ResponsiveModal'
import { formatCurrency } from '../../lib/format'
import type { Debt, DebtFormInput } from '../../api/debtsClient'
import { DebtForm } from './DebtForm'
import {
  useCreateDebt,
  useDebts,
  useDeleteDebt,
  useUpdateDebt,
} from './debtsQueries'

/** Parse a Decimal string to a number for the display edge (0 on a bad value). */
function num(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** One debt row: name over its meta line, current balance, edit + delete. */
function DebtRow({
  debt,
  onEdit,
  onDelete,
}: {
  debt: Debt
  onEdit: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation('accounts')
  // Optional meta: the monthly minimum and/or the rate, shown only when set.
  const meta: string[] = []
  if (debt.monthlyMinimum != null) {
    meta.push(
      t('debts.list.monthlyMinimum', {
        amount: formatCurrency(num(debt.monthlyMinimum), debt.currency),
      }),
    )
  }
  if (debt.rate != null) {
    meta.push(t('debts.list.rate', { rate: debt.rate }))
  }

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        py: 1.25,
        borderBottom: '1px solid var(--mg-border)',
        '&:last-of-type': { borderBottom: 'none' },
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          sx={{ fontSize: 14, fontWeight: 600 }}
          color="text.primary"
          noWrap
        >
          {debt.name}
        </Typography>
        {meta.length > 0 ? (
          <Typography sx={{ fontSize: 12.5, mt: 0.25 }} color="text.secondary">
            {meta.join(' · ')}
          </Typography>
        ) : null}
      </Box>
      <Typography
        sx={{
          fontSize: 14,
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          flex: 'none',
        }}
        color="text.primary"
      >
        {formatCurrency(num(debt.currentBalance), debt.currency)}
      </Typography>
      <IconButton
        size="small"
        onClick={onEdit}
        aria-label={t('debts.list.editAria', { name: debt.name })}
        sx={{ flex: 'none' }}
      >
        <EditOutlinedIcon fontSize="small" />
      </IconButton>
      <IconButton
        size="small"
        onClick={onDelete}
        aria-label={t('debts.list.deleteAria', { name: debt.name })}
        sx={{ flex: 'none' }}
      >
        <DeleteOutlineIcon fontSize="small" />
      </IconButton>
    </Box>
  )
}

export function DebtsSection() {
  const { t } = useTranslation('accounts')
  const debtsQuery = useDebts()
  const createDebt = useCreateDebt()
  const updateDebt = useUpdateDebt()
  const deleteDebt = useDeleteDebt()

  const [formOpen, setFormOpen] = useState(false)
  const [editingDebt, setEditingDebt] = useState<Debt | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Debt | null>(null)

  const saving = createDebt.isPending || updateDebt.isPending
  const saveError = createDebt.isError || updateDebt.isError

  const openAdd = () => {
    createDebt.reset()
    updateDebt.reset()
    setEditingDebt(null)
    setFormOpen(true)
  }
  const openEdit = (debt: Debt) => {
    createDebt.reset()
    updateDebt.reset()
    setEditingDebt(debt)
    setFormOpen(true)
  }
  const closeForm = () => setFormOpen(false)

  const handleSubmit = (input: DebtFormInput) => {
    if (editingDebt) {
      updateDebt.mutate(
        { id: editingDebt.id, input },
        { onSuccess: () => setFormOpen(false) },
      )
    } else {
      createDebt.mutate(input, { onSuccess: () => setFormOpen(false) })
    }
  }

  const openDelete = (debt: Debt) => {
    deleteDebt.reset()
    setPendingDelete(debt)
  }
  const confirmDelete = () => {
    if (!pendingDelete) return
    deleteDebt.mutate(pendingDelete.id, {
      onSuccess: () => setPendingDelete(null),
    })
  }

  const addAction = (
    <Button
      startIcon={<AddIcon />}
      onClick={openAdd}
      size="small"
      sx={{ textTransform: 'none', fontWeight: 600 }}
    >
      {t('debts.add')}
    </Button>
  )

  const debts = debtsQuery.data ?? []

  let body: React.ReactNode
  if (debtsQuery.isPending) {
    body = (
      <>
        <Skeleton
          variant="rounded"
          height={52}
          sx={{ mb: 1.25, borderRadius: '10px' }}
        />
        <Skeleton variant="rounded" height={52} sx={{ borderRadius: '10px' }} />
      </>
    )
  } else if (debtsQuery.isError) {
    body = (
      <ErrorState
        title={t('debts.error.title')}
        description={t('debts.error.description')}
        onRetry={() => {
          void debtsQuery.refetch()
        }}
      />
    )
  } else if (debts.length === 0) {
    body = (
      <Typography
        sx={{ fontSize: 13.5, py: 1 }}
        color="text.secondary"
        role="status"
      >
        {t('debts.empty')}
      </Typography>
    )
  } else {
    body = debts.map((debt) => (
      <DebtRow
        key={debt.id}
        debt={debt}
        onEdit={() => openEdit(debt)}
        onDelete={() => openDelete(debt)}
      />
    ))
  }

  return (
    <SectionCard
      title={t('debts.title')}
      subtitle={t('debts.subtitle')}
      action={addAction}
    >
      {body}

      {formOpen ? (
        <DebtForm
          key={editingDebt?.id ?? 'new-debt'}
          open
          debt={editingDebt}
          isSaving={saving}
          saveError={saveError}
          onSubmit={handleSubmit}
          onClose={closeForm}
        />
      ) : null}

      {/* Calm delete confirm. Copy notes the debt drops out of net worth (ADR-187).
          Bottom sheet on mobile via the shared ResponsiveModal. */}
      <ResponsiveModal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title={t('debts.delete.title')}
        maxWidth={420}
      >
        <Typography sx={{ fontSize: 14 }} color="text.secondary">
          {t('debts.delete.body', { name: pendingDelete?.name ?? '' })}
        </Typography>
        {deleteDebt.isError ? (
          <Typography role="alert" sx={{ fontSize: 13, mt: 1.5 }} color="error.main">
            {t('debts.delete.error')}
          </Typography>
        ) : null}
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 3 }}>
          <Button
            type="button"
            onClick={() => setPendingDelete(null)}
            color="secondary"
            sx={{ textTransform: 'none' }}
          >
            {t('debts.delete.cancel')}
          </Button>
          <Button
            type="button"
            onClick={confirmDelete}
            color="error"
            variant="contained"
            disabled={deleteDebt.isPending}
            sx={{ textTransform: 'none', fontWeight: 600 }}
          >
            {t('debts.delete.confirm')}
          </Button>
        </Box>
      </ResponsiveModal>
    </SectionCard>
  )
}

export default DebtsSection
