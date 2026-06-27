/**
 * Accounts — the account list + add/edit surface (ADR-122/123/130, Slice 1).
 *
 * Lists the user's accounts with their type, native currency, and opening
 * balance, and lets them add or edit one (name, type, currency, opening balance)
 * via {@link AccountForm}. Server state comes from TanStack Query
 * ({@link useAccounts}); a mutation invalidates the list AND net worth (a new
 * opening balance changes the total). The page shows a calm loading skeleton, a
 * calm error state if the GET fails (incl. a cross-tenant 404 surfaced calmly per
 * ADR-130), and an empty state inviting the first account (ADR-037).
 *
 * Money is rendered from the Decimal-string `openingBalance` parsed at the
 * display edge via the shared formatter (ADR-102); the stored string is the
 * source of truth. The visible page <h1> ("Accounts") names the route landmark.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import IconButton from '@mui/material/IconButton'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import AddIcon from '@mui/icons-material/Add'
import EditOutlinedIcon from '@mui/icons-material/EditOutlined'
import { SectionCard } from '../../components/SectionCard'
import { ErrorState } from '../../components/ErrorState'
import { formatCurrency } from '../../lib/format'
import type { Account } from '../../mock/types'
import type { AccountWriteBody } from '../../api/accountsClient'
import { useAccounts, useCreateAccount, useUpdateAccount } from './queries'
import { accountTypeLabel } from './presentation'
import { AccountForm } from './AccountForm'

/** Parse the Decimal-string balance to a number for the shared formatter. */
function balanceNumber(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** One account row: name + type/currency chips on the left, balance + edit right. */
function AccountRow({
  account,
  onEdit,
}: {
  account: Account
  onEdit: () => void
}) {
  const { t } = useTranslation('accounts')
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 1.5,
        py: 1.75,
        borderBottom: '1px solid var(--mg-border)',
        '&:last-of-type': { borderBottom: 'none' },
      }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Typography
          sx={{ fontSize: 14.5, fontWeight: 600 }}
          color="text.primary"
          noWrap
        >
          {account.name}
        </Typography>
        <Box sx={{ display: 'flex', gap: 0.75, mt: 0.5, flexWrap: 'wrap' }}>
          <Chip
            label={accountTypeLabel(account.type)}
            size="small"
            variant="outlined"
            sx={{ borderRadius: '8px', fontSize: 12 }}
          />
          <Chip
            label={account.currency}
            size="small"
            variant="outlined"
            sx={{ borderRadius: '8px', fontSize: 12 }}
          />
        </Box>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 'none' }}>
        <Box sx={{ textAlign: 'right' }}>
          <Typography
            sx={{ fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}
            color="text.primary"
          >
            {formatCurrency(balanceNumber(account.openingBalance), account.currency)}
          </Typography>
          <Typography sx={{ fontSize: 11.5 }} color="text.secondary">
            {t('list.openingBalance')}
          </Typography>
        </Box>
        <IconButton
          size="small"
          onClick={onEdit}
          aria-label={t('list.editAria', { name: account.name })}
        >
          <EditOutlinedIcon fontSize="small" />
        </IconButton>
      </Box>
    </Box>
  )
}

export function AccountsPage() {
  const { t } = useTranslation('accounts')
  const accountsQuery = useAccounts()
  const createAccount = useCreateAccount()
  const updateAccount = useUpdateAccount()

  // Dialog state: closed, or open to add (account === null) / edit (an account).
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Account | null>(null)

  const isSaving = createAccount.isPending || updateAccount.isPending
  const saveError = createAccount.isError || updateAccount.isError

  const openAdd = () => {
    createAccount.reset()
    updateAccount.reset()
    setEditing(null)
    setDialogOpen(true)
  }
  const openEdit = (account: Account) => {
    createAccount.reset()
    updateAccount.reset()
    setEditing(account)
    setDialogOpen(true)
  }
  const closeDialog = () => setDialogOpen(false)

  const handleSubmit = (input: AccountWriteBody) => {
    if (editing) {
      updateAccount.mutate(
        { id: editing.id, input },
        { onSuccess: () => setDialogOpen(false) },
      )
    } else {
      createAccount.mutate(input, { onSuccess: () => setDialogOpen(false) })
    }
  }

  const accounts = accountsQuery.data ?? []

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
        onClick={openAdd}
        sx={{ textTransform: 'none', fontWeight: 600, flex: 'none' }}
      >
        {t('addAccount')}
      </Button>
    </Box>
  )

  if (accountsQuery.isError) {
    return (
      <Box>
        {heading}
        <ErrorState
          title={t('error.title')}
          description={t('error.description')}
          onRetry={() => void accountsQuery.refetch()}
        />
      </Box>
    )
  }

  return (
    <Box>
      {heading}

      {accountsQuery.isPending ? (
        <SectionCard title={t('list.title')}>
          <Skeleton variant="rounded" height={56} sx={{ mb: 1.25, borderRadius: '10px' }} />
          <Skeleton variant="rounded" height={56} sx={{ mb: 1.25, borderRadius: '10px' }} />
          <Skeleton variant="rounded" height={56} sx={{ borderRadius: '10px' }} />
        </SectionCard>
      ) : accounts.length === 0 ? (
        <SectionCard title={t('list.title')}>
          <Typography
            sx={{ fontSize: 14, py: 2 }}
            color="text.secondary"
            role="status"
          >
            {t('list.empty')}
          </Typography>
        </SectionCard>
      ) : (
        <SectionCard title={t('list.title')}>
          {accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              onEdit={() => openEdit(account)}
            />
          ))}
        </SectionCard>
      )}

      {/* Only mount the form while open, keyed by the target, so its seeded
          state always reflects the current account and no stale closed instance
          lingers (which would leave the modal content aria-hidden). */}
      {dialogOpen ? (
        <AccountForm
          key={editing?.id ?? 'new'}
          open
          account={editing}
          isSaving={isSaving}
          saveError={saveError}
          onSubmit={handleSubmit}
          onClose={closeDialog}
        />
      ) : null}
    </Box>
  )
}

export default AccountsPage
