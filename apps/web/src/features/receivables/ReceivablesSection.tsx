/**
 * "Money owed to me" (receivables) section for the Accounts page
 * (ADR-204/206/208, ADR-127/172 — no new nav).
 *
 * The conceptual inverse of the adjacent {@link DebtsSection} (money the owner
 * OWES): here each row is a person who owes the owner, showing their outstanding
 * total. A row expands to reveal that person's itemized debts ({@link PersonItems})
 * with full CRUD, and a record-payment flow that allocates a payment across their
 * open items (ADR-206). It mirrors the Debts section's conventions: a
 * {@link CollapsibleSection} with an "Add person" header action, calm loading
 * skeletons, a calm error state (ADR-037), an inviting empty state, and shared
 * {@link ResponsiveModal} dialogs rendered OUTSIDE the collapsible body so an open
 * form/confirm is never unmounted when the section collapses.
 *
 * This section owns the people list + the two delete-confirm flows (person cascade,
 * item); the create/rename/item/payment forms own their own write mutations. Every
 * write invalidates the people list + affected person (task 7 hooks), so the UI
 * always reads FRESH data — never a mutation's return shape. Receivables are
 * ARS-only (ADR-204); a person's outstanding (or an item's remainder) can go
 * NEGATIVE when overpaid — it renders red + signed (ADR-019). Money is a Decimal
 * string end-to-end (ADR-025/034), parsed only here at the display edge (ADR-102).
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import AddIcon from '@mui/icons-material/Add'
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined'
import EditOutlinedIcon from '@mui/icons-material/EditOutlined'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { ErrorState } from '../../components/ErrorState'
import { ResponsiveModal } from '../../components/ResponsiveModal'
import {
  balanceColor,
  formatSignedBalance,
} from '../../lib/format'
import type { Person, ReceivableItem } from '../../api/receivablesClient'
import { PersonForm } from './PersonForm'
import { PersonItems } from './PersonItems'
import { ReceivableItemForm } from './ReceivableItemForm'
import { RecordPaymentForm } from './RecordPaymentForm'
import {
  useDeletePerson,
  useDeleteReceivableItem,
  useReceivablePeople,
} from './queries'

/** Parse a Decimal string to a number for the display edge (0 on a bad value). */
function num(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** An item delete target carries its owning person (delete needs both ids). */
interface ItemDeleteTarget {
  personId: string
  item: ReceivableItem
}

/**
 * One person row: an expand/collapse disclosure showing the name + outstanding
 * total, with rename + delete actions. When expanded it reveals the person's
 * itemized debts via {@link PersonItems}.
 */
function PersonRow({
  person,
  expanded,
  onToggle,
  onRename,
  onDelete,
  onAddItem,
  onEditItem,
  onDeleteItem,
  onRecordPayment,
}: {
  person: Person
  expanded: boolean
  onToggle: () => void
  onRename: () => void
  onDelete: () => void
  onAddItem: () => void
  onEditItem: (item: ReceivableItem) => void
  onDeleteItem: (item: ReceivableItem) => void
  onRecordPayment: () => void
}) {
  const { t } = useTranslation('receivables')
  const outstanding = num(person.outstanding)
  return (
    <Box
      sx={{
        py: 0.5,
        borderBottom: '1px solid var(--mg-border)',
        '&:last-of-type': { borderBottom: 'none' },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.75 }}>
        <Box
          component="button"
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={
            expanded
              ? t('person.collapseAria', { name: person.name })
              : t('person.expandAria', { name: person.name })
          }
          sx={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 1.5,
            m: 0,
            p: 0,
            border: 'none',
            background: 'none',
            cursor: 'pointer',
            color: 'inherit',
            font: 'inherit',
            textAlign: 'left',
            borderRadius: '6px',
            '&:focus-visible': {
              outline: '2px solid',
              outlineColor: 'primary.main',
              outlineOffset: 2,
            },
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
            <ChevronRightRoundedIcon
              aria-hidden
              fontSize="small"
              sx={{
                flex: 'none',
                color: 'text.disabled',
                transition: 'transform 150ms',
                transform: expanded ? 'rotate(90deg)' : 'none',
                '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
              }}
            />
            <Typography
              sx={{ fontSize: 14, fontWeight: 600, minWidth: 0 }}
              color="text.primary"
              noWrap
            >
              {person.name}
            </Typography>
          </Box>
          <Typography
            sx={{
              fontSize: 14,
              fontWeight: 600,
              fontVariantNumeric: 'tabular-nums',
              flex: 'none',
              // A negative outstanding (overpaid, ADR-206) reads red + signed.
              color: balanceColor(outstanding),
            }}
          >
            {formatSignedBalance(outstanding, 'ARS')}
          </Typography>
        </Box>
        <IconButton
          size="small"
          onClick={onRename}
          aria-label={t('person.renameAria', { name: person.name })}
          sx={{ flex: 'none' }}
        >
          <EditOutlinedIcon fontSize="small" />
        </IconButton>
        <IconButton
          size="small"
          onClick={onDelete}
          aria-label={t('person.deleteAria', { name: person.name })}
          sx={{ flex: 'none' }}
        >
          <DeleteOutlineIcon fontSize="small" />
        </IconButton>
      </Box>

      {expanded ? (
        <PersonItems
          personId={person.id}
          personName={person.name}
          onAddItem={onAddItem}
          onEditItem={onEditItem}
          onDeleteItem={onDeleteItem}
          onRecordPayment={onRecordPayment}
        />
      ) : null}
    </Box>
  )
}

export function ReceivablesSection() {
  const { t } = useTranslation('receivables')
  const peopleQuery = useReceivablePeople()
  const deletePerson = useDeletePerson()
  const deleteItem = useDeleteReceivableItem()

  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Person create / rename form (null person = create).
  const [personFormOpen, setPersonFormOpen] = useState(false)
  const [editingPerson, setEditingPerson] = useState<Person | null>(null)

  // Item add / edit form — always scoped to a person id.
  const [itemForm, setItemForm] = useState<{
    personId: string
    item: ReceivableItem | null
  } | null>(null)

  // Record-payment form target.
  const [paymentTarget, setPaymentTarget] = useState<Person | null>(null)

  // Delete confirms.
  const [pendingDeletePerson, setPendingDeletePerson] = useState<Person | null>(
    null,
  )
  const [pendingDeleteItem, setPendingDeleteItem] =
    useState<ItemDeleteTarget | null>(null)

  const people = peopleQuery.data ?? []

  const toggleExpanded = (id: string) =>
    setExpandedId((current) => (current === id ? null : id))

  const openAddPerson = () => {
    setEditingPerson(null)
    setPersonFormOpen(true)
  }
  const openRenamePerson = (person: Person) => {
    setEditingPerson(person)
    setPersonFormOpen(true)
  }
  const closePersonForm = () => setPersonFormOpen(false)

  const openAddItem = (personId: string) =>
    setItemForm({ personId, item: null })
  const openEditItem = (personId: string, item: ReceivableItem) =>
    setItemForm({ personId, item })
  const closeItemForm = () => setItemForm(null)

  const openDeletePerson = (person: Person) => {
    deletePerson.reset()
    setPendingDeletePerson(person)
  }
  const confirmDeletePerson = () => {
    if (!pendingDeletePerson) return
    deletePerson.mutate(pendingDeletePerson.id, {
      onSuccess: () => {
        if (expandedId === pendingDeletePerson.id) setExpandedId(null)
        setPendingDeletePerson(null)
      },
    })
  }

  const openDeleteItem = (personId: string, item: ReceivableItem) => {
    deleteItem.reset()
    setPendingDeleteItem({ personId, item })
  }
  const confirmDeleteItem = () => {
    if (!pendingDeleteItem) return
    deleteItem.mutate(
      {
        personId: pendingDeleteItem.personId,
        itemId: pendingDeleteItem.item.id,
      },
      { onSuccess: () => setPendingDeleteItem(null) },
    )
  }

  const addAction = (
    <Button
      startIcon={<AddIcon />}
      onClick={openAddPerson}
      size="small"
      sx={{ textTransform: 'none', fontWeight: 600 }}
    >
      {t('addPerson')}
    </Button>
  )

  let body: React.ReactNode
  if (peopleQuery.isPending) {
    body = (
      <>
        <Skeleton
          variant="rounded"
          height={48}
          sx={{ mb: 1.25, borderRadius: '10px' }}
        />
        <Skeleton variant="rounded" height={48} sx={{ borderRadius: '10px' }} />
      </>
    )
  } else if (peopleQuery.isError) {
    body = (
      <ErrorState
        title={t('error.title')}
        description={t('error.description')}
        onRetry={() => {
          void peopleQuery.refetch()
        }}
      />
    )
  } else if (people.length === 0) {
    body = (
      <Typography
        sx={{ fontSize: 13.5, py: 1 }}
        color="text.secondary"
        role="status"
      >
        {t('empty')}
      </Typography>
    )
  } else {
    body = people.map((person) => (
      <PersonRow
        key={person.id}
        person={person}
        expanded={expandedId === person.id}
        onToggle={() => toggleExpanded(person.id)}
        onRename={() => openRenamePerson(person)}
        onDelete={() => openDeletePerson(person)}
        onAddItem={() => openAddItem(person.id)}
        onEditItem={(item) => openEditItem(person.id, item)}
        onDeleteItem={(item) => openDeleteItem(person.id, item)}
        onRecordPayment={() => setPaymentTarget(person)}
      />
    ))
  }

  return (
    <>
      <CollapsibleSection
        storageKey="receivables"
        sectionLabel={t('title')}
        title={t('title')}
        subtitle={t('subtitle')}
        action={addAction}
      >
        {body}
      </CollapsibleSection>

      {personFormOpen ? (
        <PersonForm
          key={editingPerson?.id ?? 'new-person'}
          open
          person={editingPerson}
          onClose={closePersonForm}
        />
      ) : null}

      {itemForm ? (
        <ReceivableItemForm
          key={itemForm.item?.id ?? `new-item-${itemForm.personId}`}
          open
          personId={itemForm.personId}
          item={itemForm.item}
          onClose={closeItemForm}
        />
      ) : null}

      {paymentTarget ? (
        <RecordPaymentForm
          key={`payment-${paymentTarget.id}`}
          open
          personId={paymentTarget.id}
          personName={paymentTarget.name}
          onClose={() => setPaymentTarget(null)}
        />
      ) : null}

      {/* Calm person-delete confirm — copy notes the cascade (items + payments). */}
      <ResponsiveModal
        open={pendingDeletePerson !== null}
        onClose={() => setPendingDeletePerson(null)}
        title={t('deletePerson.title')}
        maxWidth={420}
      >
        <Typography sx={{ fontSize: 14 }} color="text.secondary">
          {t('deletePerson.body', { name: pendingDeletePerson?.name ?? '' })}
        </Typography>
        {deletePerson.isError ? (
          <Typography
            role="alert"
            sx={{ fontSize: 13, mt: 1.5, color: 'error.main' }}
          >
            {t('deletePerson.error')}
          </Typography>
        ) : null}
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 3 }}>
          <Button
            type="button"
            onClick={() => setPendingDeletePerson(null)}
            color="secondary"
            sx={{ textTransform: 'none' }}
          >
            {t('deletePerson.cancel')}
          </Button>
          <Button
            type="button"
            onClick={confirmDeletePerson}
            color="error"
            variant="contained"
            disabled={deletePerson.isPending}
            sx={{ textTransform: 'none', fontWeight: 600 }}
          >
            {t('deletePerson.confirm')}
          </Button>
        </Box>
      </ResponsiveModal>

      {/* Calm item-delete confirm. */}
      <ResponsiveModal
        open={pendingDeleteItem !== null}
        onClose={() => setPendingDeleteItem(null)}
        title={t('deleteItem.title')}
        maxWidth={420}
      >
        <Typography sx={{ fontSize: 14 }} color="text.secondary">
          {t('deleteItem.body', {
            date: pendingDeleteItem?.item.occurredOn ?? '',
          })}
        </Typography>
        {deleteItem.isError ? (
          <Typography
            role="alert"
            sx={{ fontSize: 13, mt: 1.5, color: 'error.main' }}
          >
            {t('deleteItem.error')}
          </Typography>
        ) : null}
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 3 }}>
          <Button
            type="button"
            onClick={() => setPendingDeleteItem(null)}
            color="secondary"
            sx={{ textTransform: 'none' }}
          >
            {t('deleteItem.cancel')}
          </Button>
          <Button
            type="button"
            onClick={confirmDeleteItem}
            color="error"
            variant="contained"
            disabled={deleteItem.isPending}
            sx={{ textTransform: 'none', fontWeight: 600 }}
          >
            {t('deleteItem.confirm')}
          </Button>
        </Box>
      </ResponsiveModal>
    </>
  )
}

export default ReceivablesSection
