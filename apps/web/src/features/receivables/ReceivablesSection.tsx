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
 * NEGATIVE when overpaid — that is the person's CREDIT and reads as "Credit ARS X"
 * (a word, never a signed "owed" figure, ADR-019). Money is a Decimal string
 * end-to-end (ADR-025/034), parsed only here at the display edge (ADR-102).
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
import { formatCurrency } from '../../lib/format'
import type {
  Person,
  ReceivableInstallment,
  ReceivableItem,
} from '../../api/receivablesClient'
import { PersonForm } from './PersonForm'
import { PersonItems } from './PersonItems'
import { ReceivableItemForm } from './ReceivableItemForm'
import { RecordPaymentForm } from './RecordPaymentForm'
import {
  useDeletePerson,
  useDeleteReceivableItem,
  usePardonInstallment,
  usePardonItem,
  useReceivablePeople,
  useUnpardonInstallment,
  useUnpardonItem,
} from './queries'

/** Parse a Decimal string to a number for the display edge (0 on a bad value). */
function num(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** An item write target carries its owning person (item ops need both ids). */
interface ItemTarget {
  personId: string
  item: ReceivableItem
}

/** A cuota write target: the item target plus the cuota (ADR-221). */
interface CuotaTarget extends ItemTarget {
  cuota: ReceivableInstallment
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
  onPardonItem,
  onUnpardonItem,
  onPardonInstallment,
  onUnpardonInstallment,
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
  onPardonItem: (item: ReceivableItem) => void
  onUnpardonItem: (item: ReceivableItem) => void
  onPardonInstallment: (item: ReceivableItem, cuota: ReceivableInstallment) => void
  onUnpardonInstallment: (item: ReceivableItem, cuota: ReceivableInstallment) => void
  onRecordPayment: () => void
}) {
  const { t } = useTranslation('receivables')
  const outstanding = num(person.outstanding)
  // Not-yet-due cuotas are informational, never part of outstanding (ADR-215).
  const upcoming = num(person.upcomingTotal)
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
              sx={{ fontSize: 14, fontWeight: 600, minWidth: 0, color: 'text.primary' }}
              noWrap
            >
              {person.name}
            </Typography>
          </Box>
          <Box sx={{ flex: 'none', textAlign: 'right' }}>
            <Typography
              sx={{
                fontSize: 14,
                fontWeight: 600,
                fontVariantNumeric: 'tabular-nums',
                // A credit (overpaid, ADR-206) is worded as such; color only
                // reinforces the word (ADR-019).
                color: outstanding < 0 ? 'success.main' : 'text.primary',
              }}
            >
              {outstanding < 0
                ? t('credit', { amount: formatCurrency(-outstanding, 'ARS') })
                : formatCurrency(outstanding, 'ARS')}
            </Typography>
            {upcoming > 0 ? (
              <Typography
                sx={{
                  fontSize: 11.5,
                  fontVariantNumeric: 'tabular-nums',
                  color: 'text.secondary',
                }}
              >
                {t('person.upcoming', {
                  amount: formatCurrency(upcoming, 'ARS'),
                })}
              </Typography>
            ) : null}
          </Box>
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
          onPardonItem={onPardonItem}
          onUnpardonItem={onUnpardonItem}
          onPardonInstallment={onPardonInstallment}
          onUnpardonInstallment={onUnpardonInstallment}
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
  const pardonItem = usePardonItem()
  const unpardonItem = useUnpardonItem()
  const pardonInstallment = usePardonInstallment()
  const unpardonInstallment = useUnpardonInstallment()

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
    useState<ItemTarget | null>(null)

  // Pardon (forgive) confirm — un-pardon is a calm direct toggle, no confirm.
  const [pendingPardonItem, setPendingPardonItem] =
    useState<ItemTarget | null>(null)
  // Single-cuota pardon confirm (ADR-221) — same calm pattern as an item.
  const [pendingPardonCuota, setPendingPardonCuota] =
    useState<CuotaTarget | null>(null)

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

  const openPardonItem = (personId: string, item: ReceivableItem) => {
    pardonItem.reset()
    setPendingPardonItem({ personId, item })
  }
  const confirmPardonItem = () => {
    if (!pendingPardonItem) return
    pardonItem.mutate(
      {
        personId: pendingPardonItem.personId,
        itemId: pendingPardonItem.item.id,
      },
      { onSuccess: () => setPendingPardonItem(null) },
    )
  }

  // Un-pardon is non-destructive (it simply restores the item as owed), so it
  // fires directly — no confirm — for a calm one-tap toggle (ADR-210).
  const handleUnpardonItem = (personId: string, item: ReceivableItem) => {
    unpardonItem.mutate({ personId, itemId: item.id })
  }

  const openPardonCuota = (
    personId: string,
    item: ReceivableItem,
    cuota: ReceivableInstallment,
  ) => {
    pardonInstallment.reset()
    setPendingPardonCuota({ personId, item, cuota })
  }
  const confirmPardonCuota = () => {
    if (!pendingPardonCuota) return
    pardonInstallment.mutate(
      {
        personId: pendingPardonCuota.personId,
        itemId: pendingPardonCuota.item.id,
        index: pendingPardonCuota.cuota.index,
      },
      { onSuccess: () => setPendingPardonCuota(null) },
    )
  }
  // Restoring a cuota is non-destructive → direct, like an item (ADR-210/221).
  const handleUnpardonCuota = (
    personId: string,
    item: ReceivableItem,
    cuota: ReceivableInstallment,
  ) => {
    unpardonInstallment.mutate({
      personId,
      itemId: item.id,
      index: cuota.index,
    })
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
        sx={{ fontSize: 13.5, py: 1, color: 'text.secondary' }}
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
        onPardonItem={(item) => openPardonItem(person.id, item)}
        onUnpardonItem={(item) => handleUnpardonItem(person.id, item)}
        onPardonInstallment={(item, cuota) =>
          openPardonCuota(person.id, item, cuota)
        }
        onUnpardonInstallment={(item, cuota) =>
          handleUnpardonCuota(person.id, item, cuota)
        }
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
        <Typography sx={{ fontSize: 14, color: 'text.secondary' }}>
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
        <Typography sx={{ fontSize: 14, color: 'text.secondary' }}>
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

      {/* Calm pardon (forgive) confirm — distinct from delete (ADR-210). */}
      <ResponsiveModal
        open={pendingPardonItem !== null}
        onClose={() => setPendingPardonItem(null)}
        title={t('pardonItem.title')}
        maxWidth={420}
      >
        <Typography sx={{ fontSize: 14, color: 'text.secondary' }}>
          {(pendingPardonItem?.item.installments.length ?? 0) > 0
            ? t('pardonItem.planBody')
            : t('pardonItem.body', {
                date: pendingPardonItem?.item.occurredOn ?? '',
              })}
        </Typography>
        {pardonItem.isError ? (
          <Typography
            role="alert"
            sx={{ fontSize: 13, mt: 1.5, color: 'error.main' }}
          >
            {t('pardonItem.error')}
          </Typography>
        ) : null}
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 3 }}>
          <Button
            type="button"
            onClick={() => setPendingPardonItem(null)}
            color="secondary"
            sx={{ textTransform: 'none' }}
          >
            {t('pardonItem.cancel')}
          </Button>
          <Button
            type="button"
            onClick={confirmPardonItem}
            variant="contained"
            disabled={pardonItem.isPending}
            sx={{ textTransform: 'none', fontWeight: 600 }}
          >
            {t('pardonItem.confirm')}
          </Button>
        </Box>
      </ResponsiveModal>

      {/* Calm single-cuota pardon confirm (ADR-221) — distinct from delete. */}
      <ResponsiveModal
        open={pendingPardonCuota !== null}
        onClose={() => setPendingPardonCuota(null)}
        title={t('pardonCuota.title')}
        maxWidth={420}
      >
        <Typography sx={{ fontSize: 14, color: 'text.secondary' }}>
          {t('pardonCuota.body', {
            index: pendingPardonCuota?.cuota.index ?? 0,
            count: pendingPardonCuota?.item.installments.length ?? 0,
            item:
              pendingPardonCuota?.item.detail ??
              pendingPardonCuota?.item.occurredOn ??
              '',
          })}
        </Typography>
        {pardonInstallment.isError ? (
          <Typography
            role="alert"
            sx={{ fontSize: 13, mt: 1.5, color: 'error.main' }}
          >
            {t('pardonCuota.error')}
          </Typography>
        ) : null}
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 3 }}>
          <Button
            type="button"
            onClick={() => setPendingPardonCuota(null)}
            color="secondary"
            sx={{ textTransform: 'none' }}
          >
            {t('pardonCuota.cancel')}
          </Button>
          <Button
            type="button"
            onClick={confirmPardonCuota}
            variant="contained"
            disabled={pardonInstallment.isPending}
            sx={{ textTransform: 'none', fontWeight: 600 }}
          >
            {t('pardonCuota.confirm')}
          </Button>
        </Box>
      </ResponsiveModal>
    </>
  )
}

export default ReceivablesSection
