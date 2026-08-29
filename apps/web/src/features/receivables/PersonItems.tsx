/**
 * The expanded detail panel for one receivables person (ADR-204/206/208).
 *
 * Mounted only while a person row is expanded, this fetches that person's items
 * ({@link useReceivablePerson} — always fresh, per task 7's invalidation) and
 * lists each itemized debt: its date, its optional justification, the original
 * amount, and the still-owed remainder. A remainder can go NEGATIVE when a person
 * has overpaid an item (ADR-206) — it renders red + signed via
 * {@link formatSignedBalance} / {@link balanceColor}, so the overpaid state reads
 * without relying on color alone (ADR-019).
 *
 * Actions (add / edit / delete item, record payment) bubble up to the section,
 * which owns the shared dialogs. A clearly-marked mount point is left for task 9
 * (match-suggestions review + PDF export) so that work has an obvious home here.
 * Receivables are ARS-only (ADR-204), so every amount formats as ARS.
 */

import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import IconButton from '@mui/material/IconButton'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import AddIcon from '@mui/icons-material/Add'
import PaymentsOutlinedIcon from '@mui/icons-material/PaymentsOutlined'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined'
import EditOutlinedIcon from '@mui/icons-material/EditOutlined'
import VolunteerActivismOutlinedIcon from '@mui/icons-material/VolunteerActivismOutlined'
import RestoreOutlinedIcon from '@mui/icons-material/RestoreOutlined'
import { ErrorState } from '../../components/ErrorState'
import { balanceColor, formatCurrency, formatSignedBalance } from '../../lib/format'
import type { ReceivableItem } from '../../api/receivablesClient'
import { MatchSuggestions } from './MatchSuggestions'
import { PersonPdfButton } from './PersonPdfButton'
import { useReceivablePerson } from './queries'

/** Parse a Decimal string to a number for the display edge (0 on a bad value). */
function num(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * One item row: date + optional detail, its amount, remaining, and its actions.
 *
 * A PARDONED item (ADR-210) reads visibly distinct: a calm "Covered" badge, its
 * remaining amount de-emphasized + struck (it no longer counts as owed — the
 * strike is the non-color cue, ADR-019), and its forgive action swapped to
 * "Un-pardon" (restore as owed). Delete is unchanged in both states — it stays
 * the separate "this was an error" path.
 */
function ItemRow({
  item,
  onEdit,
  onDelete,
  onPardon,
  onUnpardon,
}: {
  item: ReceivableItem
  onEdit: () => void
  onDelete: () => void
  onPardon: () => void
  onUnpardon: () => void
}) {
  const { t } = useTranslation('receivables')
  const remaining = num(item.remaining)
  const { pardoned } = item
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
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
          <Typography
            sx={{
              fontSize: 14,
              fontWeight: 600,
              minWidth: 0,
              // A covered debt is de-emphasized — it no longer counts as owed.
              color: pardoned ? 'text.secondary' : 'text.primary',
            }}
            noWrap
          >
            {item.detail ?? item.occurredOn}
          </Typography>
          {pardoned ? (
            <Chip
              label={t('items.coveredBadge')}
              size="small"
              variant="outlined"
              icon={<VolunteerActivismOutlinedIcon />}
              sx={{
                flex: 'none',
                height: 20,
                fontSize: 11,
                fontWeight: 600,
                color: 'text.secondary',
                borderColor: 'var(--mg-border-2)',
                '& .MuiChip-icon': { fontSize: 13, color: 'text.secondary' },
              }}
            />
          ) : null}
        </Box>
        <Typography sx={{ fontSize: 12.5, mt: 0.25 }} color="text.secondary">
          {item.detail
            ? `${item.occurredOn} · ${formatCurrency(num(item.amount), 'ARS')}`
            : formatCurrency(num(item.amount), 'ARS')}
        </Typography>
      </Box>
      <Typography
        sx={{
          fontSize: 14,
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          flex: 'none',
          ...(pardoned
            ? {
                // Covered → de-emphasized + struck (the strike is the non-color
                // cue, ADR-019); it no longer reads as an owed balance.
                color: 'text.disabled',
                textDecoration: 'line-through',
              }
            : {
                // A negative remainder (overpaid, ADR-206) reads red; the SIGN
                // carries the meaning and color merely reinforces it (ADR-019).
                color: balanceColor(remaining),
              }),
        }}
      >
        {t('items.remaining', {
          amount: formatSignedBalance(remaining, 'ARS'),
        })}
      </Typography>
      <IconButton
        size="small"
        onClick={onEdit}
        aria-label={t('items.editAria', { date: item.occurredOn })}
        sx={{ flex: 'none' }}
      >
        <EditOutlinedIcon fontSize="small" />
      </IconButton>
      {pardoned ? (
        <IconButton
          size="small"
          onClick={onUnpardon}
          aria-label={t('items.unpardonAria', { date: item.occurredOn })}
          sx={{ flex: 'none' }}
        >
          <RestoreOutlinedIcon fontSize="small" />
        </IconButton>
      ) : (
        <IconButton
          size="small"
          onClick={onPardon}
          aria-label={t('items.pardonAria', { date: item.occurredOn })}
          sx={{ flex: 'none' }}
        >
          <VolunteerActivismOutlinedIcon fontSize="small" />
        </IconButton>
      )}
      <IconButton
        size="small"
        onClick={onDelete}
        aria-label={t('items.deleteAria', { date: item.occurredOn })}
        sx={{ flex: 'none' }}
      >
        <DeleteOutlineIcon fontSize="small" />
      </IconButton>
    </Box>
  )
}

export interface PersonItemsProps {
  /** The person whose items to load + list. */
  personId: string
  /** The person's display name (for the PDF export + match-review labels). */
  personName: string
  /** Add a new item to this person. */
  onAddItem: () => void
  /** Edit an existing item. */
  onEditItem: (item: ReceivableItem) => void
  /** Delete an item (goes through a confirm at the section level). */
  onDeleteItem: (item: ReceivableItem) => void
  /** Forgive an item (ADR-210) — goes through a confirm at the section level. */
  onPardonItem: (item: ReceivableItem) => void
  /** Restore a forgiven item as owed (ADR-210) — the un-pardon toggle. */
  onUnpardonItem: (item: ReceivableItem) => void
  /** Open the record-payment flow for this person. */
  onRecordPayment: () => void
}

export function PersonItems({
  personId,
  personName,
  onAddItem,
  onEditItem,
  onDeleteItem,
  onPardonItem,
  onUnpardonItem,
  onRecordPayment,
}: PersonItemsProps) {
  const { t } = useTranslation('receivables')
  const personQuery = useReceivablePerson(personId)

  let list: React.ReactNode
  if (personQuery.isPending) {
    list = (
      <Box aria-label={t('items.loadingAria')}>
        <Skeleton
          variant="rounded"
          height={44}
          sx={{ mb: 1, borderRadius: '10px' }}
        />
        <Skeleton variant="rounded" height={44} sx={{ borderRadius: '10px' }} />
      </Box>
    )
  } else if (personQuery.isError) {
    list = (
      <ErrorState
        title={t('items.errorTitle')}
        description={t('items.errorDescription')}
        onRetry={() => {
          void personQuery.refetch()
        }}
      />
    )
  } else if ((personQuery.data?.items ?? []).length === 0) {
    list = (
      <Typography
        sx={{ fontSize: 13.5, py: 1 }}
        color="text.secondary"
        role="status"
      >
        {t('items.empty')}
      </Typography>
    )
  } else {
    list = personQuery.data?.items.map((item) => (
      <ItemRow
        key={item.id}
        item={item}
        onEdit={() => onEditItem(item)}
        onDelete={() => onDeleteItem(item)}
        onPardon={() => onPardonItem(item)}
        onUnpardon={() => onUnpardonItem(item)}
      />
    ))
  }

  return (
    <Box
      sx={{
        pl: 1.5,
        mt: 0.5,
        borderLeft: '2px solid var(--mg-border)',
      }}
    >
      {list}

      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1 }}>
        <Button
          startIcon={<AddIcon />}
          onClick={onAddItem}
          size="small"
          sx={{ textTransform: 'none', fontWeight: 600 }}
        >
          {t('items.add')}
        </Button>
        <Button
          startIcon={<PaymentsOutlinedIcon />}
          onClick={onRecordPayment}
          size="small"
          color="secondary"
          sx={{ textTransform: 'none', fontWeight: 600 }}
        >
          {t('items.recordPayment')}
        </Button>
      </Box>

      {/*
        Task 9 mount point — the match-suggestions review UI and the "Export PDF"
        button (ADR-207/209) live HERE, in the person detail. The PDF export sits
        just under the CRUD actions; the suggestion-only match review follows it.
      */}
      <Box data-testid="receivables-person-task9-mount">
        <PersonPdfButton personId={personId} personName={personName} />
        <MatchSuggestions personId={personId} personName={personName} />
      </Box>
    </Box>
  )
}

export default PersonItems
