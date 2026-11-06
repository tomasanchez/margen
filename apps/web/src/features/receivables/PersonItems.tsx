/**
 * The expanded detail panel for one receivables person (ADR-204/206/208,
 * ADR-214…222).
 *
 * Mounted only while a person row is expanded, this fetches that person's items
 * ({@link useReceivablePerson} — always fresh, per the invalidation contract)
 * and lists each itemized debt: its date, its optional justification, the
 * original amount, and what is still owed. A remainder can go NEGATIVE when a
 * person has overpaid an item (ADR-206) — it renders red + signed via
 * {@link formatSignedBalance} / {@link balanceColor}, so the overpaid state reads
 * without relying on color alone (ADR-019).
 *
 * Installment items (ADR-214/215) read as a plan: "1/6 cuotas due · ARS X owed ·
 * ARS Y upcoming" — what is owed TODAY counts only due cuotas, and the due count
 * comes from the server's own cuota status (never the browser clock) — with a disclosure
 * revealing the cuota list ({@link InstallmentSchedule}): each cuota's status
 * chip (due / upcoming / paid / covered), an inline amount/due-date edit
 * (written straight through the cuota PATCH, allowed even after payments,
 * ADR-216) and a per-cuota forgive / restore (ADR-221). The item-level forgive on
 * a plan forgives every cuota still owed.
 *
 * An item linked to an expense (ADR-217) shows a chip that opens the
 * transactions list filtered to that expense (by name, within its month —
 * there is no per-transaction deep link, ADR-116), plus a calm warning when the
 * items linking that expense add up to more than what it stands for in full (its
 * `planTotal` — the whole card purchase for a cuota, ADR-218). The link is
 * reference-only (ADR-219).
 *
 * A remainder below zero is the person's CREDIT (they paid more than owed,
 * ADR-206) and reads as "Credit ARS X", never as a negative amount owed. While any
 * write for an item is in flight, every action on that item (and its cuotas) is
 * held so two writes can't race on the same plan. Item / cuota writes that need a
 * confirm bubble up to the section, which owns the shared dialogs. Receivables
 * are ARS-only (ADR-204).
 */

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from '@tanstack/react-router'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import IconButton from '@mui/material/IconButton'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import AddIcon from '@mui/icons-material/Add'
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded'
import PaymentsOutlinedIcon from '@mui/icons-material/PaymentsOutlined'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined'
import EditOutlinedIcon from '@mui/icons-material/EditOutlined'
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined'
import VolunteerActivismOutlinedIcon from '@mui/icons-material/VolunteerActivismOutlined'
import RestoreOutlinedIcon from '@mui/icons-material/RestoreOutlined'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import { ErrorState } from '../../components/ErrorState'
import { formatCurrency } from '../../lib/format'
import type {
  ReceivableInstallment,
  ReceivableItem,
  SourceTransaction,
} from '../../api/receivablesClient'
import { InstallmentSchedule, type InstallmentRowChange } from './InstallmentSchedule'
import {
  centsToDecimal,
  centsToNumber,
  decimalToCents,
  dueCuotaCount,
} from './installments'
import { transactionsSearchFor } from './linking'
import { MatchSuggestions } from './MatchSuggestions'
import { PersonPdfButton } from './PersonPdfButton'
import {
  useEditInstallment,
  useIsItemMutating,
  useReceivablePerson,
} from './queries'

/** Parse a Decimal string to a number for the display edge (0 on a bad value). */
function num(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Money a person owes, worded for the list: a positive amount as-is, a NEGATIVE
 * one as their credit ("Credit ARS X" / "Saldo a favor ARS X", ADR-206) — never a
 * signed "owed" figure.
 */
function useOwedText() {
  const { t } = useTranslation('receivables')
  return (amount: number) =>
    amount < 0
      ? t('credit', { amount: formatCurrency(-amount, 'ARS') })
      : formatCurrency(amount, 'ARS')
}

/**
 * The linked-expense chip: a real link to the transactions list filtered to the
 * expense (ADR-116). A BARE TanStack {@link Link} keeps the typed `to` / `search`
 * checked against the route's schema; the chip inside is presentational.
 */
function SourceLink({ source }: { source: SourceTransaction }) {
  const { t } = useTranslation('receivables')
  return (
    <Link
      to="/transactions"
      search={transactionsSearchFor(source)}
      aria-label={t('items.linkAria', {
        name: source.name,
        date: source.occurredOn,
      })}
      className="mg-receivable-link"
    >
      <Chip
        label={source.name}
        size="small"
        variant="outlined"
        icon={<ReceiptLongOutlinedIcon />}
        sx={{
          maxWidth: '240px',
          height: '22px',
          fontSize: 11.5,
          fontWeight: 600,
          cursor: 'pointer',
          color: 'text.secondary',
          borderColor: 'var(--mg-border-2)',
          '& .MuiChip-icon': { fontSize: 14, color: 'text.secondary' },
          '&:hover': { color: 'primary.main', borderColor: 'primary.main' },
        }}
      />
    </Link>
  )
}

/**
 * One item row: date + optional detail, its amount, what's still owed, and its
 * actions — plus, for a plan, its cuota summary and expandable cuota list.
 *
 * A PARDONED item (ADR-210) reads visibly distinct: a calm "Covered" badge, its
 * remaining amount de-emphasized + struck (it no longer counts as owed — the
 * strike is the non-color cue, ADR-019), and its forgive action swapped to
 * "Un-pardon" (restore as owed). Delete is unchanged in both states — it stays
 * the separate "this was an error" path.
 */
function ItemRow({
  personId,
  item,
  onEdit,
  onDelete,
  onPardon,
  onUnpardon,
  onPardonInstallment,
  onUnpardonInstallment,
}: {
  personId: string
  item: ReceivableItem
  onEdit: () => void
  onDelete: () => void
  onPardon: () => void
  onUnpardon: () => void
  onPardonInstallment: (cuota: ReceivableInstallment) => void
  onUnpardonInstallment: (cuota: ReceivableInstallment) => void
}) {
  const { t } = useTranslation('receivables')
  const owedText = useOwedText()
  const listId = useId()
  const [cuotasOpen, setCuotasOpen] = useState(false)
  const editInstallment = useEditInstallment()
  // Hold every action on this item while ANY write for it is in flight.
  const busy = useIsItemMutating(item.id)
  const { pardoned, installments, sourceTransaction: source } = item
  const isPlan = installments.length > 0
  const dueCents = decimalToCents(item.dueOutstanding)
  const upcomingCents = decimalToCents(item.upcomingTotal)
  // A plan's "still owed" excludes forgiven cuotas (its gross `remaining`
  // would include them); a forgiven item shows what was covered, struck.
  const owed = pardoned || !isPlan
    ? num(item.remaining)
    : centsToNumber(dueCents + upcomingCents)
  const canPardon = !pardoned && (!isPlan || dueCents + upcomingCents > 0)
  const amountText = formatCurrency(num(item.amount), 'ARS')

  let detailLine: string
  if (isPlan) {
    const plan = t('items.planLine', { amount: amountText, count: installments.length })
    detailLine = item.detail ? `${item.occurredOn} · ${plan}` : plan
  } else {
    detailLine = item.detail ? `${item.occurredOn} · ${amountText}` : amountText
  }

  const editCuota = (
    cuota: ReceivableInstallment,
    change: InstallmentRowChange,
  ): Promise<unknown> => {
    const amountChanged = change.amountCents !== decimalToCents(cuota.amount)
    const dateChanged = change.dueOn !== cuota.dueOn
    if (!amountChanged && !dateChanged) return Promise.resolve()
    return editInstallment.mutateAsync({
      personId,
      itemId: item.id,
      index: cuota.index,
      ...(amountChanged ? { amount: centsToDecimal(change.amountCents) } : {}),
      ...(dateChanged ? { dueOn: change.dueOn } : {}),
    })
  }

  const cuotaAt = (index: number) =>
    installments.find((cuota) => cuota.index === index)

  return (
    <Box
      data-testid="receivable-item"
      sx={{
        py: 1.25,
        borderBottom: '1px solid var(--mg-border)',
        '&:last-of-type': { borderBottom: 'none' },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
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
          <Typography sx={{ fontSize: 12.5, mt: 0.25, color: 'text.secondary' }}>
            {detailLine}
          </Typography>
          {isPlan && !pardoned ? (
            <Typography sx={{ fontSize: 12.5, mt: 0.25, color: 'text.secondary' }}>
              {[
                t('items.planDue', {
                  due: dueCuotaCount(installments),
                  count: installments.length,
                }),
                // Owed now — or, when paid ahead beyond it, the person's credit.
                dueCents < 0
                  ? owedText(centsToNumber(dueCents))
                  : t('items.planOwed', {
                      amount: formatCurrency(centsToNumber(dueCents), 'ARS'),
                    }),
                ...(upcomingCents > 0
                  ? [
                      t('items.planUpcoming', {
                        amount: formatCurrency(centsToNumber(upcomingCents), 'ARS'),
                      }),
                    ]
                  : []),
              ].join(' · ')}
            </Typography>
          ) : null}
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
                  // A credit (overpaid, ADR-206) is worded as such — the WORD
                  // carries the meaning, color only reinforces it (ADR-019).
                  color: owed < 0 ? 'success.main' : 'text.primary',
                }),
          }}
        >
          {owed < 0 && !pardoned
            ? owedText(owed)
            : t('items.remaining', {
                amount: formatCurrency(owed, 'ARS'),
              })}
        </Typography>
        <IconButton
          size="small"
          onClick={onEdit}
          disabled={busy}
          aria-label={t('items.editAria', { date: item.occurredOn })}
          sx={{ flex: 'none' }}
        >
          <EditOutlinedIcon fontSize="small" />
        </IconButton>
        {pardoned ? (
          <IconButton
            size="small"
            onClick={onUnpardon}
            disabled={busy}
            aria-label={t('items.unpardonAria', { date: item.occurredOn })}
            sx={{ flex: 'none' }}
          >
            <RestoreOutlinedIcon fontSize="small" />
          </IconButton>
        ) : canPardon ? (
          <IconButton
            size="small"
            onClick={onPardon}
            disabled={busy}
            aria-label={
              isPlan
                ? t('items.pardonPlanAria', { date: item.occurredOn })
                : t('items.pardonAria', { date: item.occurredOn })
            }
            sx={{ flex: 'none' }}
          >
            <VolunteerActivismOutlinedIcon fontSize="small" />
          </IconButton>
        ) : null}
        <IconButton
          size="small"
          onClick={onDelete}
          disabled={busy}
          aria-label={t('items.deleteAria', { date: item.occurredOn })}
          sx={{ flex: 'none' }}
        >
          <DeleteOutlineIcon fontSize="small" />
        </IconButton>
      </Box>

      {source || isPlan ? (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 1,
            mt: 0.75,
          }}
        >
          {isPlan ? (
            <Button
              type="button"
              size="small"
              color="secondary"
              onClick={() => setCuotasOpen((open) => !open)}
              aria-expanded={cuotasOpen}
              aria-controls={cuotasOpen ? listId : undefined}
              endIcon={
                <ExpandMoreRoundedIcon
                  sx={{
                    transition: 'transform 150ms',
                    transform: cuotasOpen ? 'rotate(180deg)' : 'none',
                    '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
                  }}
                />
              }
              sx={{ textTransform: 'none', fontWeight: 600, px: 1, minHeight: '32px' }}
            >
              {cuotasOpen
                ? t('items.hideCuotas')
                : t('items.showCuotas', { count: installments.length })}
            </Button>
          ) : null}
          {source ? <SourceLink source={source} /> : null}
        </Box>
      ) : null}

      {item.linkedTotalExceedsExpense && source ? (
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.75, mt: 0.75 }}>
          <WarningAmberRoundedIcon
            aria-hidden
            sx={{ fontSize: 16, mt: '2px', color: 'warning.main' }}
          />
          <Typography sx={{ fontSize: 12.5, color: 'warning.main' }}>
            {source.installmentsTotal != null && source.installmentsTotal > 1
              ? t('items.overLinkedPlan', {
                  amount: formatCurrency(num(source.planTotal), 'ARS'),
                  count: source.installmentsTotal,
                })
              : t('items.overLinked', {
                  amount: formatCurrency(num(source.planTotal), 'ARS'),
                })}
          </Typography>
        </Box>
      ) : null}

      {isPlan && cuotasOpen ? (
        <Box id={listId} sx={{ mt: 0.5, pl: 1.5, borderLeft: '2px solid var(--mg-border)' }}>
          <InstallmentSchedule
            rows={installments.map((cuota) => ({
              index: cuota.index,
              dueOn: cuota.dueOn,
              amountCents: decimalToCents(cuota.amount),
              status: cuota.status,
              remainingCents: decimalToCents(cuota.remaining),
              paidCents: decimalToCents(cuota.paid),
            }))}
            label={t('schedule.listAria', { item: item.detail ?? item.occurredOn })}
            onEditRow={(index, change) => {
              const cuota = cuotaAt(index)
              return cuota ? editCuota(cuota, change) : undefined
            }}
            onPardonRow={(index) => {
              const cuota = cuotaAt(index)
              if (cuota) onPardonInstallment(cuota)
            }}
            onUnpardonRow={(index) => {
              const cuota = cuotaAt(index)
              if (cuota) onUnpardonInstallment(cuota)
            }}
            disabled={busy}
          />
        </Box>
      ) : null}
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
  /**
   * Forgive an item (ADR-210) — for a plan, every cuota still owed (ADR-221).
   * Goes through a confirm at the section level.
   */
  onPardonItem: (item: ReceivableItem) => void
  /** Restore a forgiven item as owed (ADR-210) — the un-pardon toggle. */
  onUnpardonItem: (item: ReceivableItem) => void
  /** Forgive one cuota (ADR-221) — goes through a confirm at the section level. */
  onPardonInstallment: (item: ReceivableItem, cuota: ReceivableInstallment) => void
  /** Restore a forgiven cuota as owed (ADR-221). */
  onUnpardonInstallment: (item: ReceivableItem, cuota: ReceivableInstallment) => void
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
  onPardonInstallment,
  onUnpardonInstallment,
  onRecordPayment,
}: PersonItemsProps) {
  const { t } = useTranslation('receivables')
  const owedText = useOwedText()
  const personQuery = useReceivablePerson(personId)
  const detail = personQuery.data
  const upcomingCents = detail ? decimalToCents(detail.upcomingTotal) : 0

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
  } else if ((detail?.items ?? []).length === 0) {
    list = (
      <Typography
        sx={{ fontSize: 13.5, py: 1, color: 'text.secondary' }}
        role="status"
      >
        {t('items.empty')}
      </Typography>
    )
  } else {
    list = detail?.items.map((item) => (
      <ItemRow
        key={item.id}
        personId={personId}
        item={item}
        onEdit={() => onEditItem(item)}
        onDelete={() => onDeleteItem(item)}
        onPardon={() => onPardonItem(item)}
        onUnpardon={() => onUnpardonItem(item)}
        onPardonInstallment={(cuota) => onPardonInstallment(item, cuota)}
        onUnpardonInstallment={(cuota) => onUnpardonInstallment(item, cuota)}
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
      {/* What's owed now vs. the not-yet-due cuotas (ADR-215) — only when the
          person has upcoming cuotas, so the headline figure reads correctly. */}
      {detail && upcomingCents > 0 ? (
        <Typography sx={{ fontSize: 12.5, pt: 0.5, color: 'text.secondary' }}>
          {num(detail.outstanding) < 0
            ? t('items.personSummaryCredit', {
                credit: owedText(num(detail.outstanding)),
                upcoming: formatCurrency(centsToNumber(upcomingCents), 'ARS'),
              })
            : t('items.personSummary', {
                owed: formatCurrency(num(detail.outstanding), 'ARS'),
                upcoming: formatCurrency(centsToNumber(upcomingCents), 'ARS'),
              })}
        </Typography>
      ) : null}

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
