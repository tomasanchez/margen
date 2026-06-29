/**
 * Accounts — institutions grouped with their per-currency accounts (ADR-134).
 *
 * Under ADR-134 the Accounts screen is a two-level view: each INSTITUTION (a
 * provider — bank / card / cash / wallet) is a section showing its per-currency
 * accounts with balances. The page lets the user:
 *  - Add an institution (name + type incl. wallet) via {@link InstitutionForm};
 *  - Add a per-currency account under an institution (currency + opening balance)
 *    via {@link AccountForm}; and edit either.
 *  - Drill into an account's transactions: clicking an account row navigates to
 *    `/transactions?account=<id>`, seeding the account filter (ADR-116/134).
 *
 * Server state comes from TanStack Query ({@link useInstitutions} +
 * {@link useAccounts} + {@link useNetWorth}); a write invalidates all three. The
 * page shows calm loading skeletons, a calm error state if a GET fails (incl. a
 * cross-tenant 404, ADR-130), and an empty state inviting the first institution
 * (ADR-037). The visible page <h1> ("Accounts") names the route landmark.
 *
 * Each account row shows its CURRENT balance — opening + transaction deltas, the
 * same value Home shows (ADR-122). That balance is sourced from the net-worth
 * read model (`useNetWorth`, matched by account id), NOT the stale opening
 * balance the account entity carries; the edit form still edits the opening
 * balance. Institutions are ordered EXACTLY like the Home breakdown — by
 * net-worth subtotal DESC (live MEP, ADR-133), accounts ARS before USD — via the
 * shared {@link buildNetWorthBalanceIndex} / {@link orderInstitutionIds} helpers
 * so the two screens stay in lockstep. Money is parsed at the display edge
 * (ADR-102).
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from '@tanstack/react-router'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import IconButton from '@mui/material/IconButton'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import AddIcon from '@mui/icons-material/Add'
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded'
import EditOutlinedIcon from '@mui/icons-material/EditOutlined'
import SwapHorizIcon from '@mui/icons-material/SwapHoriz'
import { SectionCard } from '../../components/SectionCard'
import { ErrorState } from '../../components/ErrorState'
import { formatCurrency } from '../../lib/format'
import type {
  Account,
  Institution,
  InstitutionWriteBody,
} from '../../mock/types'
import type { AccountWriteBody } from '../../api/accountsClient'
import {
  useAccounts,
  useCreateAccount,
  useCreateInstitution,
  useInstitutions,
  useNetWorth,
  useUpdateAccount,
  useUpdateInstitution,
} from './queries'
import { useFxRates } from '../home/queries'
import {
  asCurrency,
  buildNetWorthBalanceIndex,
  compareAccountCurrencies,
  orderInstitutionIds,
  usableMep,
} from './grouping'
import { accountTypeLabel } from './presentation'
import { AccountForm } from './AccountForm'
import { InstitutionForm } from './InstitutionForm'
import {
  InstitutionWizard,
  type AccountResult,
  type WizardSubmit,
} from './InstitutionWizard'

/** A drilldown route + search to the account's transactions (ADR-116/134). */
const accountDrilldownClass = 'mg-account-row-link'

/**
 * One account row: currency + CURRENT balance, clickable to drill into its
 * transactions (ADR-134). The balance is the net-worth value (opening +
 * transaction deltas, ADR-122) passed in — NOT the account's stale opening
 * balance. A bare TanStack {@link Link} preserves the typed `to` / `search`
 * inference against the route's search schema; the right edit button is a sibling
 * (not nested in the link) so the two actions stay independently operable.
 */
function AccountRow({
  account,
  balance,
  onEdit,
}: {
  account: Account
  /** The account's current native balance from the net-worth read model. */
  balance: number
  onEdit: () => void
}) {
  const { t } = useTranslation('accounts')
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
      <Link
        to="/transactions"
        search={{ account: account.id, month: 'all' as const }}
        aria-label={t('list.drilldownAria', {
          institution: account.institutionName,
          currency: account.currency,
        })}
        className={accountDrilldownClass}
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          textDecoration: 'none',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
          <Chip
            label={account.currency}
            size="small"
            variant="outlined"
            sx={{ borderRadius: '8px', fontSize: 12, flex: 'none' }}
          />
          <ChevronRightRoundedIcon
            aria-hidden
            fontSize="small"
            sx={{ color: 'text.disabled', flex: 'none' }}
          />
        </Box>
        <Typography
          sx={{
            fontSize: 14,
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
          }}
          color="text.primary"
        >
          {formatCurrency(balance, account.currency)}
        </Typography>
      </Link>
      <IconButton
        size="small"
        onClick={onEdit}
        aria-label={t('list.editAccountAria', {
          institution: account.institutionName,
          currency: account.currency,
        })}
        sx={{ flex: 'none' }}
      >
        <EditOutlinedIcon fontSize="small" />
      </IconButton>
    </Box>
  )
}

/** One institution section: heading + type chip + edit, with its accounts. */
function InstitutionSection({
  institution,
  accounts,
  balanceOf,
  onEditInstitution,
  onAddAccount,
  onEditAccount,
}: {
  institution: Institution
  /** This institution's accounts, already ordered ARS before USD. */
  accounts: Account[]
  /** Current native balance for an account (net-worth, ADR-122). */
  balanceOf: (account: Account) => number
  onEditInstitution: () => void
  onAddAccount: () => void
  onEditAccount: (account: Account) => void
}) {
  const { t } = useTranslation('accounts')
  return (
    <SectionCard
      title={institution.name}
      action={
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Chip
            label={accountTypeLabel(institution.type)}
            size="small"
            variant="outlined"
            sx={{ borderRadius: '8px', fontSize: 12 }}
          />
          <IconButton
            size="small"
            onClick={onEditInstitution}
            aria-label={t('list.editInstitutionAria', { name: institution.name })}
          >
            <EditOutlinedIcon fontSize="small" />
          </IconButton>
        </Box>
      }
    >
      {accounts.length === 0 ? (
        <Typography
          sx={{ fontSize: 13.5, py: 1 }}
          color="text.secondary"
          role="status"
        >
          {t('list.noAccounts')}
        </Typography>
      ) : (
        accounts.map((account) => (
          <AccountRow
            key={account.id}
            account={account}
            balance={balanceOf(account)}
            onEdit={() => onEditAccount(account)}
          />
        ))
      )}
      <Button
        startIcon={<AddIcon />}
        onClick={onAddAccount}
        size="small"
        sx={{ mt: 1, textTransform: 'none', fontWeight: 600 }}
      >
        {t('list.addAccount')}
      </Button>
    </SectionCard>
  )
}

export function AccountsPage() {
  const { t } = useTranslation('accounts')
  const institutionsQuery = useInstitutions()
  const accountsQuery = useAccounts()
  const netWorthQuery = useNetWorth()
  // Live FX rates drive the institution ORDER (subtotals at the MEP), matching
  // Home's default (MEP) view (ADR-133). Rows themselves show NATIVE balances, so
  // the page never blocks on rates — order degrades gracefully if they're slow.
  const fxQuery = useFxRates()
  const createInstitution = useCreateInstitution()
  const updateInstitution = useUpdateInstitution()
  const createAccount = useCreateAccount()
  const updateAccount = useUpdateAccount()

  // Onboarding wizard (NEW institution + optional accounts). The per-section
  // "Add account" + "Edit institution" affordances stay for existing rows.
  const [wizardOpen, setWizardOpen] = useState(false)
  // The institution id once it has been created — drives retry-only Finish and
  // never discards a created institution on a partial failure (ADR-037).
  const [wizardInstitutionId, setWizardInstitutionId] = useState<string | null>(
    null,
  )
  const [wizardInstitutionError, setWizardInstitutionError] = useState(false)
  const [wizardSubmitting, setWizardSubmitting] = useState(false)
  // Per-queued-account outcome by the wizard's local key.
  const [wizardResults, setWizardResults] = useState<
    Record<string, AccountResult>
  >({})
  const [wizardAllDone, setWizardAllDone] = useState(false)

  // Edit-institution dialog: closed, or edit (the wizard owns "add" now).
  const [institutionDialogOpen, setInstitutionDialogOpen] = useState(false)
  const [editingInstitution, setEditingInstitution] =
    useState<Institution | null>(null)

  // Account dialog: closed, or open for a given institution to add / edit.
  const [accountDialogInstitution, setAccountDialogInstitution] =
    useState<Institution | null>(null)
  const [editingAccount, setEditingAccount] = useState<Account | null>(null)

  const institutionSaving =
    createInstitution.isPending || updateInstitution.isPending
  const institutionSaveError =
    createInstitution.isError || updateInstitution.isError
  const accountSaving = createAccount.isPending || updateAccount.isPending
  const accountSaveError = createAccount.isError || updateAccount.isError

  // Open the onboarding wizard with a clean slate.
  const openWizard = () => {
    createInstitution.reset()
    createAccount.reset()
    setWizardInstitutionId(null)
    setWizardInstitutionError(false)
    setWizardSubmitting(false)
    setWizardResults({})
    setWizardAllDone(false)
    setWizardOpen(true)
  }
  const closeWizard = () => setWizardOpen(false)

  /**
   * Finish the wizard: create the institution first (unless it already exists
   * from a prior partial-failure attempt), then create each queued account that
   * has not yet succeeded. On a partial failure we keep the created institution
   * + the successful accounts, mark the failed ones, and let the user retry —
   * never discarding the institution silently (ADR-037).
   */
  const handleWizardFinish = async (submit: WizardSubmit) => {
    setWizardSubmitting(true)
    setWizardInstitutionError(false)

    let institutionId = wizardInstitutionId
    if (!institutionId) {
      try {
        const created = await createInstitution.mutateAsync(submit.institution)
        institutionId = created.id
        setWizardInstitutionId(created.id)
      } catch {
        // Institution itself failed: surface it and stop — nothing to retry yet.
        setWizardInstitutionError(true)
        setWizardSubmitting(false)
        return
      }
    }

    // Create only the accounts that have not already succeeded (retry-safe).
    const nextResults: Record<string, AccountResult> = { ...wizardResults }
    let anyFailed = false
    for (const account of submit.accounts) {
      if (nextResults[account.key] === 'created') continue
      try {
        await createAccount.mutateAsync({
          institutionId,
          currency: account.currency,
          openingBalance: account.openingBalance,
        })
        nextResults[account.key] = 'created'
      } catch {
        nextResults[account.key] = 'failed'
        anyFailed = true
      }
    }

    setWizardResults(nextResults)
    setWizardSubmitting(false)
    if (!anyFailed) setWizardAllDone(true)
  }

  const openEditInstitution = (institution: Institution) => {
    createInstitution.reset()
    updateInstitution.reset()
    setEditingInstitution(institution)
    setInstitutionDialogOpen(true)
  }
  const closeInstitutionDialog = () => setInstitutionDialogOpen(false)

  const openAddAccount = (institution: Institution) => {
    createAccount.reset()
    updateAccount.reset()
    setEditingAccount(null)
    setAccountDialogInstitution(institution)
  }
  const openEditAccount = (institution: Institution, account: Account) => {
    createAccount.reset()
    updateAccount.reset()
    setEditingAccount(account)
    setAccountDialogInstitution(institution)
  }
  const closeAccountDialog = () => setAccountDialogInstitution(null)

  const handleInstitutionSubmit = (input: InstitutionWriteBody) => {
    if (editingInstitution) {
      updateInstitution.mutate(
        { id: editingInstitution.id, input },
        { onSuccess: () => setInstitutionDialogOpen(false) },
      )
    } else {
      createInstitution.mutate(input, {
        onSuccess: () => setInstitutionDialogOpen(false),
      })
    }
  }

  const handleAccountSubmit = (input: AccountWriteBody) => {
    if (editingAccount) {
      updateAccount.mutate(
        { id: editingAccount.id, input },
        { onSuccess: () => setAccountDialogInstitution(null) },
      )
    } else {
      createAccount.mutate(input, {
        onSuccess: () => setAccountDialogInstitution(null),
      })
    }
  }

  const netWorth = netWorthQuery.data
  const fxRates = fxQuery.data

  // Current native balance per account id, sourced from net worth (opening +
  // transaction deltas, ADR-122) — the SAME value Home shows. A missing id (the
  // net-worth read should include every account, even zero-transaction ones)
  // falls back to the account's opening balance so a row is never blank.
  const balanceIndex = useMemo(
    () => buildNetWorthBalanceIndex(netWorth?.accounts ?? []),
    [netWorth?.accounts],
  )
  const balanceOf = (account: Account): number => {
    const fromNetWorth = balanceIndex.get(account.id)
    if (fromNetWorth != null) return fromNetWorth
    const parsed = Number.parseFloat(account.openingBalance)
    return Number.isFinite(parsed) ? parsed : 0
  }

  // Group accounts by institution id, ordering each group's accounts ARS before
  // USD — the SAME within-institution order Home uses.
  const accountsByInstitution = useMemo(() => {
    const map = new Map<string, Account[]>()
    for (const account of accountsQuery.data ?? []) {
      const list = map.get(account.institutionId) ?? []
      list.push(account)
      map.set(account.institutionId, list)
    }
    for (const list of map.values()) {
      list.sort((a, b) =>
        compareAccountCurrencies(asCurrency(a.currency), asCurrency(b.currency)),
      )
    }
    return map
  }, [accountsQuery.data])

  // Order institutions EXACTLY like Home: by net-worth subtotal DESC (live MEP,
  // name tie-break). Institutions absent from net worth (e.g. no accounts yet)
  // are appended after, sorted by name, so every institution still renders.
  const institutions = useMemo(() => {
    const data = institutionsQuery.data ?? []
    if (!netWorth) return data
    const displayCurrency = asCurrency(netWorth.currency)
    const mep = usableMep(fxRates?.mep)
    const order = orderInstitutionIds(netWorth.accounts, displayCurrency, mep)
    const rank = new Map(order.map((id, index) => [id, index]))
    return [...data].sort((a, b) => {
      const ra = rank.get(a.id)
      const rb = rank.get(b.id)
      if (ra != null && rb != null) return ra - rb
      if (ra != null) return -1
      if (rb != null) return 1
      return a.name.localeCompare(b.name)
    })
  }, [institutionsQuery.data, netWorth, fxRates?.mep])

  const isPending =
    institutionsQuery.isPending ||
    accountsQuery.isPending ||
    netWorthQuery.isPending
  const isError =
    institutionsQuery.isError ||
    accountsQuery.isError ||
    netWorthQuery.isError

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
      <Box sx={{ display: 'flex', gap: 1, flex: 'none' }}>
        <Button
          component={Link}
          to="/transfers"
          variant="outlined"
          color="secondary"
          startIcon={<SwapHorizIcon />}
          sx={{ textTransform: 'none', fontWeight: 600, flex: 'none' }}
        >
          {t('transfers')}
        </Button>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={openWizard}
          sx={{ textTransform: 'none', fontWeight: 600, flex: 'none' }}
        >
          {t('addInstitution')}
        </Button>
      </Box>
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
            void institutionsQuery.refetch()
            void accountsQuery.refetch()
            void netWorthQuery.refetch()
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
          <Skeleton
            variant="rounded"
            height={56}
            sx={{ mb: 1.25, borderRadius: '10px' }}
          />
          <Skeleton
            variant="rounded"
            height={56}
            sx={{ mb: 1.25, borderRadius: '10px' }}
          />
          <Skeleton variant="rounded" height={56} sx={{ borderRadius: '10px' }} />
        </SectionCard>
      ) : institutions.length === 0 ? (
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
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {institutions.map((institution) => (
            <InstitutionSection
              key={institution.id}
              institution={institution}
              accounts={accountsByInstitution.get(institution.id) ?? []}
              balanceOf={balanceOf}
              onEditInstitution={() => openEditInstitution(institution)}
              onAddAccount={() => openAddAccount(institution)}
              onEditAccount={(account) => openEditAccount(institution, account)}
            />
          ))}
        </Box>
      )}

      {/* Onboarding wizard for a NEW institution (+ optional accounts).
          Remounted per open so its internal step/queue state starts fresh. */}
      {wizardOpen ? (
        <InstitutionWizard
          open
          institutionCreated={wizardInstitutionId !== null}
          isSubmitting={wizardSubmitting}
          institutionError={wizardInstitutionError}
          accountResults={wizardResults}
          allDone={wizardAllDone}
          onFinish={(submit) => {
            void handleWizardFinish(submit)
          }}
          onClose={closeWizard}
        />
      ) : null}

      {/* Keyed by the target so the seeded state always reflects the current
          institution and no stale closed instance lingers (aria-hidden). */}
      {institutionDialogOpen ? (
        <InstitutionForm
          key={editingInstitution?.id ?? 'new-institution'}
          open
          institution={editingInstitution}
          isSaving={institutionSaving}
          saveError={institutionSaveError}
          onSubmit={handleInstitutionSubmit}
          onClose={closeInstitutionDialog}
        />
      ) : null}

      {accountDialogInstitution ? (
        <AccountForm
          key={editingAccount?.id ?? `new-account-${accountDialogInstitution.id}`}
          open
          institution={accountDialogInstitution}
          account={editingAccount}
          isSaving={accountSaving}
          saveError={accountSaveError}
          onSubmit={handleAccountSubmit}
          onClose={closeAccountDialog}
        />
      ) : null}
    </Box>
  )
}

export default AccountsPage
