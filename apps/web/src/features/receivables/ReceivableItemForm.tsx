/**
 * Add / edit one itemized debt for a receivables person (ADR-204/208,
 * ADR-214…220, ADR-017/019/037).
 *
 * A receivable item is a debt a person owes: a date, an amount and an optional
 * justification (ADR-204) — optionally SPLIT INTO CUOTAS (ADR-214/216) and
 * optionally LINKED to the owner's expense it came from (ADR-217). This form owns
 * create (no `item`) and edit (an existing `item`), both through
 * {@link useSaveReceivableItem}, which refreshes the receivables tree so the
 * list always reads fresh data.
 *
 * Cuotas: a "Pay in installments" switch reveals the cuota count (2..120) and the
 * first due date (default: one month after the item's date), plus a LIVE preview
 * of the even split the server will store (cents remainder on the last cuota —
 * the exact backend math). Any previewed cuota can be tweaked inline (e.g. a
 * recargo on the last one); a NEW item's tweaks travel in the same create request
 * (`installments.cuotas`), applied atomically. Editing an existing plan:
 * per-cuota edits go through the cuota PATCH (never below what was already paid —
 * a typed 422 the form explains); changing its SHAPE (total, count, first due
 * date, or converting either way) goes through the item PATCH, which the API
 * refuses (409) once the plan has payments or forgiven cuotas — the form disables
 * those fields up front and explains why, and still maps a stale-data 409 to the
 * same calm message (ADR-216).
 *
 * Link: an optional expense picker ({@link TransactionLinkPicker}). Picking one
 * fills the fields the owner hasn't touched yet (date, detail; the amount only
 * for a flat item) and — for a card purchase in cuotas (ADR-174) — turns the
 * plan on with the same cuota count, showing the expense's per-cuota amount as a
 * hint instead of guessing a total. A non-blocking warning appears when the items
 * linking that expense would add up to more than what it stands for in full (its
 * `planTotal`: the whole card purchase for a cuota, ADR-218). The link is
 * reference-only and never nets against balances or budgets (ADR-219).
 *
 * Person: when opened WITHOUT a person (the transactions list's "Someone owes me
 * this" entry point, ADR-220) a {@link PersonPicker} lets the owner pick someone
 * or name a new person, created on save.
 *
 * Money stays a Decimal STRING at the boundary (ADR-025/034) and integer cents
 * inside the preview math; dates must sit within 2000..2100 (the API's range).
 * On failure the dialog stays open with the input intact and a calm inline error
 * (ADR-037). A create is IDEMPOTENT: the form generates one item id when it opens
 * and sends it on every attempt, so retrying after a lost response can never
 * create the item twice (ADR-204); if that id turns out to be taken with other
 * terms, the form says the item may already exist instead of resubmitting.
 */

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import FormControlLabel from '@mui/material/FormControlLabel'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import { ResponsiveModal } from '../../components/ResponsiveModal'
import {
  InstallmentAmountBelowPaidError,
  InstallmentScheduleLockedError,
  ReceivableItemIdConflictError,
  ReceivablesApiError,
  type ItemPatchInput,
  type ReceivableInstallment,
  type ReceivableItem,
} from '../../api/receivablesClient'
import { formatCurrency } from '../../lib/format'
import { parseBalance } from '../accounts/balance'
import { newClientId } from './clientId'
import { InstallmentSchedule } from './InstallmentSchedule'
import {
  EARLIEST_DATE,
  LATEST_DATE,
  MAX_INSTALLMENTS,
  MIN_INSTALLMENTS,
  addMonthsClamped,
  applyOverrides,
  centsToDecimal,
  centsToNumber,
  cuotaEditsFor,
  decimalToCents,
  isReceivableDate,
  isValidCount,
  planSchedule,
  scheduleFromInstallments,
  scheduleLockReason,
  scheduleTotalCents,
  toCents,
  toInputAmount,
  todayIso,
  type CuotaOverride,
  type PlannedCuota,
} from './installments'
import {
  linkedOthersCents,
  overLinkedTotalCents,
  suggestedCuotaCount,
  type LinkedExpense,
} from './linking'
import { PersonPicker } from './PersonPicker'
import {
  EMPTY_PERSON_PICKER,
  resolvePersonChoice,
  type PersonPickerState,
} from './personChoice'
import {
  useCreatePerson,
  useExpenseCandidates,
  useReceivablePeople,
  useSaveReceivableItem,
  type SaveItemInput,
} from './queries'
import { TransactionLinkPicker } from './TransactionLinkPicker'

/** The default cuota count offered when the owner turns the plan on. */
const DEFAULT_CUOTA_COUNT = 3

/** Fields that stop following the linked expense once the owner edits them. */
type AutoField = 'date' | 'amount' | 'detail' | 'installments' | 'count'

/** Every auto-fillable field — all "touched" when editing an existing item. */
const ALL_AUTO_FIELDS: readonly AutoField[] = [
  'date',
  'amount',
  'detail',
  'installments',
  'count',
]

/** Why a save failed, mapped to calm, specific copy (ADR-037). */
type SaveFailure =
  | {
      kind:
        | 'generic'
        | 'lockedAllocations'
        | 'lockedPardons'
        | 'linkMissing'
        | 'invalidPlan'
        | 'idConflict'
    }
  | { kind: 'belowPaid'; index: number; paid: string }

/** The date input range the API accepts (ADR-223 review: 2000..2100). */
const DATE_INPUT_RANGE = { min: EARLIEST_DATE, max: LATEST_DATE } as const

/** Seed values for a NEW item (e.g. from an expense, ADR-220). */
export interface ReceivableItemPrefill {
  /** `YYYY-MM-DD`. */
  occurredOn?: string
  /** A Decimal string; omit to leave the amount for the owner. */
  amount?: string
  detail?: string
  /** The expense to pre-link (reference only, ADR-219). */
  link?: LinkedExpense | null
  /** Turn the cuota plan on with this many cuotas (e.g. the expense's own count). */
  installmentsCount?: number | null
}

/** What was saved, reported to {@link ReceivableItemFormProps.onSaved}. */
export interface ReceivableItemSaved {
  personId: string
  /** The person's name when the form knew it (picker flow), else null. */
  personName: string | null
  /** The saved item's id (`createdItemId` for a create). */
  itemId: string
}

export interface ReceivableItemFormProps {
  /** Whether the dialog is open. */
  open: boolean
  /**
   * The person this item belongs to, or `null` to pick / name one inside the
   * form (the transactions "Someone owes me this" entry point, ADR-220).
   */
  personId: string | null
  /** The item being edited, or `null` to add a new one. */
  item: ReceivableItem | null
  /** Seed values for a new item. Ignored when editing. */
  prefill?: ReceivableItemPrefill
  /** Overrides the dialog title (defaults to Add / Edit item). */
  title?: string
  /** Dismiss / cancel the dialog. */
  onClose: () => void
  /** Called once the item is saved (before the dialog closes). */
  onSaved?: (saved: ReceivableItemSaved) => void
}

/** Map a save error to its calm message kind. */
function classifyFailure(
  error: unknown,
  context: { linked: boolean; installments: boolean },
): SaveFailure {
  if (error instanceof InstallmentScheduleLockedError) {
    return {
      kind: error.reason === 'allocations' ? 'lockedAllocations' : 'lockedPardons',
    }
  }
  if (error instanceof ReceivableItemIdConflictError) return { kind: 'idConflict' }
  if (error instanceof InstallmentAmountBelowPaidError) {
    return { kind: 'belowPaid', index: error.index, paid: error.paid }
  }
  if (error instanceof ReceivablesApiError) {
    if (error.status === 404 && context.linked) return { kind: 'linkMissing' }
    if (error.status === 422 && context.installments) return { kind: 'invalidPlan' }
  }
  return { kind: 'generic' }
}

/** A calm, icon-led inline note (info or warning) — never color alone. */
function InlineNote({
  tone,
  children,
  live = false,
}: {
  tone: 'info' | 'warning'
  children: React.ReactNode
  /** Announce politely when it appears (dynamic warnings). */
  live?: boolean
}) {
  const color = tone === 'warning' ? 'warning.main' : 'text.secondary'
  const Icon = tone === 'warning' ? WarningAmberRoundedIcon : InfoOutlinedIcon
  return (
    <Box
      role={live ? 'status' : undefined}
      sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.75 }}
    >
      <Icon aria-hidden sx={{ fontSize: 16, mt: '2px', color }} />
      <Typography sx={{ fontSize: 12.5, color }}>{children}</Typography>
    </Box>
  )
}

export function ReceivableItemForm({
  open,
  personId,
  item,
  prefill,
  title,
  onClose,
  onSaved,
}: ReceivableItemFormProps) {
  const { t } = useTranslation('receivables')
  const isEdit = item !== null
  const seed = isEdit ? undefined : prefill

  const dateId = useId()
  const amountId = useId()
  const detailId = useId()
  const countId = useId()
  const firstDueId = useId()
  const errorId = useId()

  // --- Field state -----------------------------------------------------------
  const wasInstallments = (item?.installments.length ?? 0) > 0
  const [dateText, setDateText] = useState<string>(
    item?.occurredOn ?? seed?.occurredOn ?? todayIso(),
  )
  const [amountText, setAmountText] = useState<string>(() => {
    if (item) return toInputAmount(item.amount)
    return seed?.amount ? toInputAmount(seed.amount) : ''
  })
  const [detailText, setDetailText] = useState<string>(
    item?.detail ?? seed?.detail ?? '',
  )
  const [link, setLink] = useState<LinkedExpense | null>(
    item?.sourceTransaction ?? seed?.link ?? null,
  )
  const [installmentsOn, setInstallmentsOn] = useState<boolean>(
    item ? wasInstallments : Boolean(seed?.installmentsCount),
  )
  const [countText, setCountText] = useState<string>(() => {
    if (item && wasInstallments) return String(item.installments.length)
    return String(seed?.installmentsCount ?? DEFAULT_CUOTA_COUNT)
  })
  // `null` = follow the item's date (one month later); a string once set.
  const [firstDueText, setFirstDueText] = useState<string | null>(
    item && wasInstallments ? item.installments[0].dueOn : null,
  )
  const [overrides, setOverrides] = useState<Record<number, CuotaOverride>>({})
  // Fields the owner edited — they stop following a picked expense (ADR-220).
  const [touched, setTouched] = useState<ReadonlySet<AutoField>>(
    () => new Set(isEdit ? ALL_AUTO_FIELDS : []),
  )
  const [personState, setPersonState] =
    useState<PersonPickerState>(EMPTY_PERSON_PICKER)
  const [failure, setFailure] = useState<SaveFailure | null>(null)
  // ONE idempotency id per open form, reused on every save attempt (ADR-204).
  const [newItemId] = useState(newClientId)

  const peopleQuery = useReceivablePeople()
  const createPerson = useCreatePerson()
  const saveItem = useSaveReceivableItem()
  const isSaving = createPerson.isPending || saveItem.isPending

  const markTouched = (field: AutoField) =>
    setTouched((current) =>
      current.has(field) ? current : new Set([...current, field]),
    )

  // --- Derived ----------------------------------------------------------------
  const personChoice =
    personId === null
      ? resolvePersonChoice(personState, peopleQuery.data ?? [])
      : null
  const date = dateText.trim()
  const dateValid = isReceivableDate(date)
  const amountCents = toCents(parseBalance(amountText))
  const amountValid = amountCents !== null && amountCents > 0
  const count = Number(countText)
  const countValid = isValidCount(count)
  const firstDue = firstDueText ?? (dateValid ? addMonthsClamped(date, 1) : null) ?? ''
  const firstDueValid = isReceivableDate(firstDue)
  const lockReason = item ? scheduleLockReason(item) : null
  // A plan whose SHAPE is pinned by payments / pardons (ADR-216): its total,
  // count and first due date are read-only; per-cuota edits stay allowed.
  const planShapeLocked = lockReason !== null && wasInstallments
  // A flat item with payments / a pardon can't be converted into cuotas either.
  const toggleLocked = lockReason !== null

  const originalAmountCents = item ? decimalToCents(item.amount) : null
  const reshaped =
    item !== null &&
    wasInstallments &&
    installmentsOn &&
    (count !== item.installments.length ||
      firstDue !== item.installments[0].dueOn ||
      amountCents !== originalAmountCents)

  // The schedule the owner's tweaks apply to: the SAVED cuotas while an
  // existing plan keeps its shape, otherwise the even split the server will
  // generate for the typed plan (null while the plan is incomplete/invalid).
  // Cheap (≤ 120 rows), so it is simply recomputed each render.
  let baseSchedule: PlannedCuota[] | null = null
  // Persisted cuotas keep their status chips in the form (paid / due / …).
  const savedStatus = new Map<number, ReceivableInstallment>()
  if (installmentsOn && item && wasInstallments && !reshaped) {
    baseSchedule = scheduleFromInstallments(item.installments)
    for (const cuota of item.installments) savedStatus.set(cuota.index, cuota)
  } else if (installmentsOn && amountCents !== null) {
    baseSchedule = planSchedule(amountCents, count, firstDue)
  }
  const scheduleRows = baseSchedule ? applyOverrides(baseSchedule, overrides) : []
  const hasOverrides = scheduleRows.some((row) => row.edited)

  const planValid = !installmentsOn || baseSchedule !== null
  const thisAmountCents = installmentsOn
    ? scheduleTotalCents(scheduleRows)
    : (amountCents ?? 0)

  // --- Link over-split warning (ADR-218) ---------------------------------------
  // A link seeded from a transactions-list row doesn't know how much other items
  // already link it, so look it up (by its name on its date) once.
  const needsLinkedLookup = link !== null && link.linkedItemsTotal === null
  const linkedLookup = useExpenseCandidates(
    needsLinkedLookup && link
      ? { q: link.name, from: link.occurredOn, to: link.occurredOn, limit: 50 }
      : null,
  )
  const lookedUp =
    link && link.linkedItemsTotal === null
      ? linkedLookup.data?.find((candidate) => candidate.id === link.id)
      : undefined
  const resolvedLink: LinkedExpense | null =
    link && lookedUp
      ? {
          ...link,
          linkedItemsTotal: lookedUp.linkedItemsTotal,
          planTotal: lookedUp.planTotal,
        }
      : link
  const othersCents = resolvedLink
    ? linkedOthersCents(
        resolvedLink,
        item
          ? {
              linkedExpenseId: item.sourceTransaction?.id ?? null,
              amount: item.amount,
            }
          : null,
      )
    : null
  const overLinkedCents = resolvedLink
    ? overLinkedTotalCents(resolvedLink, othersCents, thisAmountCents)
    : null

  // In picker mode, wait for the people list before saving: resolving a typed
  // name against an unloaded list would create a duplicate person.
  const personValid =
    personId !== null || (personChoice !== null && !peopleQuery.isPending)
  const canSave =
    !isSaving &&
    personValid &&
    dateValid &&
    amountValid &&
    planValid

  // --- Handlers ---------------------------------------------------------------
  const handleLinkChange = (next: LinkedExpense | null) => {
    setLink(next)
    if (!next) return
    // Fill only what the owner hasn't typed themselves (ADR-220).
    if (!touched.has('date')) setDateText(next.occurredOn)
    if (!touched.has('detail')) setDetailText(next.name)
    let nextInstallmentsOn = installmentsOn
    if (!isEdit && !touched.has('installments')) {
      const suggested = suggestedCuotaCount(next)
      nextInstallmentsOn = suggested !== null
      setInstallmentsOn(nextInstallmentsOn)
      if (suggested !== null && !touched.has('count')) {
        setCountText(String(suggested))
      }
    }
    // The expense's amount IS the debt only for a flat item; for a plan it is a
    // single card cuota, so the total is left to the owner (a hint shows it).
    if (!touched.has('amount')) {
      setAmountText(nextInstallmentsOn ? '' : toInputAmount(next.amount))
    }
    setOverrides({})
  }

  const handlePreviewEdit = (
    index: number,
    change: { amountCents: number; dueOn: string },
  ) => {
    setOverrides((current) => ({
      ...current,
      [index]: { amountCents: change.amountCents, dueOn: change.dueOn },
    }))
  }

  const submit = async () => {
    if (!canSave || amountCents === null) return
    setFailure(null)
    const occurredOn = date
    const amount = centsToDecimal(amountCents)
    const detail = detailText.trim()
    // The owner's tweaks to the previewed / saved cuotas (only what changed).
    const cuotaEdits =
      installmentsOn && baseSchedule ? cuotaEditsFor(baseSchedule, overrides) : []
    try {
      // Resolve (or create) the person first; once created, the picker points
      // at them so a retry after a later failure never creates them twice.
      let targetId = personId
      let targetName: string | null = null
      if (targetId === null) {
        if (!personChoice) return
        if (personChoice.kind === 'existing') {
          targetId = personChoice.id
          targetName = personChoice.name
        } else {
          const created = await createPerson.mutateAsync(personChoice.name)
          setPersonState({ text: created.name, selected: created })
          targetId = created.id
          targetName = created.name
        }
      }

      let input: SaveItemInput
      if (item) {
        const patch: ItemPatchInput = {}
        if (occurredOn !== item.occurredOn) patch.occurredOn = occurredOn
        if (detail && detail !== (item.detail ?? '')) patch.detail = detail
        const linkId = link?.id ?? null
        if (linkId !== (item.sourceTransaction?.id ?? null)) {
          patch.sourceTransactionId = linkId
        }
        const amountChanged = amountCents !== originalAmountCents
        if (installmentsOn) {
          // Keep an unchanged plan by OMITTING it (re-sending is a no-op, but
          // omitting can never trip the ADR-216 lock).
          if (!wasInstallments || reshaped) {
            patch.installments = { count, firstDueOn: firstDue }
            if (amountChanged) patch.amount = amount
          }
        } else if (wasInstallments) {
          patch.installments = null
          if (amountChanged) patch.amount = amount
        } else if (amountChanged) {
          patch.amount = amount
        }
        const hasPatch = Object.keys(patch).length > 0
        if (!hasPatch && cuotaEdits.length === 0) {
          onClose()
          return
        }
        input = {
          mode: 'edit',
          personId: targetId,
          itemId: item.id,
          patch: hasPatch ? patch : null,
          cuotaEdits,
        }
      } else {
        // ONE atomic, idempotent create: the plan carries its cuota tweaks.
        input = {
          mode: 'create',
          personId: targetId,
          body: {
            id: newItemId,
            occurredOn,
            amount,
            detail,
            installments: installmentsOn
              ? { count, firstDueOn: firstDue, cuotas: cuotaEdits }
              : null,
            sourceTransactionId: link?.id ?? null,
          },
        }
      }

      const result = await saveItem.mutateAsync(input)
      onSaved?.({ personId: targetId, personName: targetName, itemId: result.itemId })
      onClose()
    } catch (error) {
      setFailure(
        classifyFailure(error, {
          linked: link !== null,
          installments: installmentsOn || wasInstallments,
        }),
      )
    }
  }

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void submit()
  }

  const dialogTitle =
    title ?? (isEdit ? t('itemForm.editTitle') : t('itemForm.addTitle'))

  // --- Copy ---------------------------------------------------------------------
  let failureMessage: string | null = null
  if (failure?.kind === 'belowPaid') {
    failureMessage = t('itemForm.errors.belowPaid', {
      index: failure.index,
      amount: formatCurrency(centsToNumber(decimalToCents(failure.paid)), 'ARS'),
    })
  } else if (failure) {
    failureMessage = t(`itemForm.errors.${failure.kind}`)
  }

  let lockHint: string | null = null
  if (lockReason && wasInstallments) {
    lockHint =
      lockReason === 'allocations'
        ? t('itemForm.lock.planAllocations')
        : t('itemForm.lock.planPardons')
  } else if (lockReason) {
    lockHint =
      lockReason === 'allocations'
        ? t('itemForm.lock.flatAllocations')
        : t('itemForm.lock.flatPardons')
  }

  let countError: string | null = null
  if (installmentsOn && !countValid) {
    countError = t('itemForm.installments.countError', {
      min: MIN_INSTALLMENTS,
      max: MAX_INSTALLMENTS,
    })
  }
  const tooSmallForPlan =
    installmentsOn &&
    countValid &&
    firstDueValid &&
    amountValid &&
    amountCents !== null &&
    amountCents < count

  const linkMoney = (decimal: string) =>
    formatCurrency(centsToNumber(decimalToCents(decimal)), 'ARS')
  const linkCuotaHint =
    resolvedLink?.installmentsTotal != null
      ? resolvedLink.installmentsIndex != null
        ? t('itemForm.link.cuotaHint', {
            index: resolvedLink.installmentsIndex,
            count: resolvedLink.installmentsTotal,
            amount: linkMoney(resolvedLink.amount),
            total: linkMoney(resolvedLink.planTotal),
          })
        : t('itemForm.link.cuotaPlanHint', {
            count: resolvedLink.installmentsTotal,
            amount: linkMoney(resolvedLink.amount),
            total: linkMoney(resolvedLink.planTotal),
          })
      : null

  const scheduleLabel = t('schedule.listAria', {
    item: detailText.trim() || date,
  })

  return (
    <ResponsiveModal open={open} onClose={onClose} title={dialogTitle} maxWidth={480}>
      <Box component="form" onSubmit={handleSubmit} noValidate>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.25 }}>
          {failureMessage ? (
            <Typography
              id={errorId}
              role="alert"
              // MUI v9 `color` prop ignores dotted palette paths — use `sx`.
              sx={{ fontSize: 13, color: 'error.main' }}
            >
              {failureMessage}
            </Typography>
          ) : null}

          {personId === null ? (
            <PersonPicker
              value={personState}
              onChange={setPersonState}
              choice={personChoice}
              disabled={isSaving}
            />
          ) : null}

          <TextField
            id={dateId}
            type="date"
            label={t('itemForm.date.label')}
            value={dateText}
            onChange={(event) => {
              setDateText(event.target.value)
              markTouched('date')
              if (firstDueText === null) setOverrides({})
            }}
            required
            fullWidth
            size="small"
            disabled={isSaving}
            error={!dateValid}
            helperText={dateValid ? undefined : t('itemForm.date.error')}
            slotProps={{
              inputLabel: { shrink: true },
              htmlInput: DATE_INPUT_RANGE,
            }}
          />

          <TextField
            id={amountId}
            label={
              installmentsOn
                ? t('itemForm.amount.totalLabel')
                : t('itemForm.amount.label')
            }
            value={amountText}
            onChange={(event) => {
              setAmountText(event.target.value)
              markTouched('amount')
              setOverrides({})
            }}
            required
            fullWidth
            size="small"
            disabled={isSaving || (planShapeLocked && installmentsOn)}
            type="number"
            helperText={
              installmentsOn
                ? t('itemForm.amount.totalHelper')
                : t('itemForm.amount.helper')
            }
            slotProps={{
              htmlInput: {
                // `type="number"` gives a clean mobile numeric keypad;
                // `inputMode="decimal"` + `step="any"` keep decimals, and
                // `min={0}` rejects negatives. Money still flows as a Decimal
                // string via parseBalance/centsToDecimal (ADR-025).
                min: 0,
                step: 'any',
                inputMode: 'decimal',
                // Point at the error only when there is one, so the helper
                // text keeps its automatic description link otherwise.
                ...(failureMessage ? { 'aria-describedby': errorId } : {}),
              },
            }}
          />

          <TextField
            id={detailId}
            label={t('itemForm.detail.label')}
            value={detailText}
            onChange={(event) => {
              setDetailText(event.target.value)
              markTouched('detail')
            }}
            fullWidth
            size="small"
            disabled={isSaving}
            helperText={t('itemForm.detail.helper')}
          />

          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <TransactionLinkPicker
              value={link}
              onChange={handleLinkChange}
              disabled={isSaving}
            />
            {linkCuotaHint ? <InlineNote tone="info">{linkCuotaHint}</InlineNote> : null}
            {overLinkedCents !== null && resolvedLink ? (
              <InlineNote tone="warning" live>
                {resolvedLink.installmentsTotal != null &&
                resolvedLink.installmentsTotal > 1
                  ? t('itemForm.link.overLinkedPlan', {
                      total: formatCurrency(centsToNumber(overLinkedCents), 'ARS'),
                      expense: linkMoney(resolvedLink.planTotal),
                      count: resolvedLink.installmentsTotal,
                    })
                  : t('itemForm.link.overLinked', {
                      total: formatCurrency(centsToNumber(overLinkedCents), 'ARS'),
                      expense: linkMoney(resolvedLink.planTotal),
                    })}
              </InlineNote>
            ) : null}
          </Box>

          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            <FormControlLabel
              sx={{ m: 0, alignSelf: 'flex-start' }}
              control={
                <Switch
                  checked={installmentsOn}
                  onChange={(event) => {
                    setInstallmentsOn(event.target.checked)
                    markTouched('installments')
                    setOverrides({})
                  }}
                  disabled={isSaving || toggleLocked}
                />
              }
              label={
                <Typography sx={{ fontSize: 14, color: 'text.primary' }}>
                  {t('itemForm.installments.toggle')}
                </Typography>
              }
            />
            {lockHint ? <InlineNote tone="info">{lockHint}</InlineNote> : null}
            {isEdit && wasInstallments && !installmentsOn ? (
              <InlineNote tone="info">{t('itemForm.installments.removeHint')}</InlineNote>
            ) : null}

            {installmentsOn ? (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5 }}>
                  <TextField
                    id={countId}
                    label={t('itemForm.installments.count')}
                    value={countText}
                    onChange={(event) => {
                      setCountText(event.target.value)
                      markTouched('count')
                      setOverrides({})
                    }}
                    size="small"
                    type="number"
                    required
                    disabled={isSaving || planShapeLocked}
                    error={countError !== null}
                    helperText={countError ?? ' '}
                    sx={{ width: '150px' }}
                    slotProps={{
                      htmlInput: {
                        min: MIN_INSTALLMENTS,
                        max: MAX_INSTALLMENTS,
                        step: 1,
                        inputMode: 'numeric',
                      },
                    }}
                  />
                  <TextField
                    id={firstDueId}
                    type="date"
                    label={t('itemForm.installments.firstDue')}
                    value={firstDue}
                    onChange={(event) => {
                      setFirstDueText(event.target.value)
                      setOverrides({})
                    }}
                    size="small"
                    required
                    disabled={isSaving || planShapeLocked}
                    error={!firstDueValid}
                    helperText={
                      firstDueValid ? ' ' : t('itemForm.installments.firstDueError')
                    }
                    sx={{ flex: 1, minWidth: '170px' }}
                    slotProps={{
                      inputLabel: { shrink: true },
                      htmlInput: DATE_INPUT_RANGE,
                    }}
                  />
                </Box>

                {reshaped ? (
                  <InlineNote tone="info">{t('itemForm.installments.resplitHint')}</InlineNote>
                ) : null}
                {!amountValid ? (
                  <InlineNote tone="info">{t('itemForm.installments.needAmount')}</InlineNote>
                ) : null}
                {tooSmallForPlan ? (
                  <InlineNote tone="warning">
                    {t('itemForm.installments.tooSmall', { count })}
                  </InlineNote>
                ) : null}

                {scheduleRows.length > 0 ? (
                  <Box
                    component="section"
                    aria-label={t('itemForm.installments.previewTitle')}
                  >
                    <Typography
                      sx={{
                        fontSize: 12.5,
                        fontWeight: 700,
                        letterSpacing: 0.3,
                        color: 'text.secondary',
                      }}
                    >
                      {t('itemForm.installments.previewTitle')}
                    </Typography>
                    <InstallmentSchedule
                      rows={scheduleRows.map((row) => {
                        const saved = savedStatus.get(row.index)
                        return {
                          index: row.index,
                          dueOn: row.dueOn,
                          amountCents: row.amountCents,
                          edited: row.edited,
                          status: saved?.status,
                          remainingCents: saved
                            ? decimalToCents(saved.remaining)
                            : undefined,
                          // A saved cuota can't go below what was paid (ADR-216).
                          paidCents: saved ? decimalToCents(saved.paid) : undefined,
                        }
                      })}
                      label={scheduleLabel}
                      onEditRow={handlePreviewEdit}
                      disabled={isSaving}
                      maxHeight="280px"
                    />
                    <Box
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        flexWrap: 'wrap',
                        gap: 1,
                        pt: 1,
                        mt: 0.5,
                        borderTop: '1px solid var(--mg-border)',
                      }}
                    >
                      <Typography
                        role="status"
                        sx={{
                          fontSize: 13,
                          fontVariantNumeric: 'tabular-nums',
                          color: 'text.primary',
                        }}
                      >
                        {hasOverrides
                          ? t('itemForm.installments.totalEdited', {
                              count: scheduleRows.length,
                              amount: formatCurrency(
                                centsToNumber(thisAmountCents),
                                'ARS',
                              ),
                            })
                          : t('itemForm.installments.total', {
                              count: scheduleRows.length,
                              amount: formatCurrency(
                                centsToNumber(thisAmountCents),
                                'ARS',
                              ),
                            })}
                      </Typography>
                      {hasOverrides ? (
                        <Button
                          type="button"
                          size="small"
                          color="secondary"
                          onClick={() => setOverrides({})}
                          disabled={isSaving}
                          sx={{ textTransform: 'none' }}
                        >
                          {t('itemForm.installments.resetEdits')}
                        </Button>
                      ) : null}
                    </Box>
                  </Box>
                ) : null}
              </Box>
            ) : null}
          </Box>
        </Box>

        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 3 }}>
          <Button
            type="button"
            onClick={onClose}
            color="secondary"
            sx={{ textTransform: 'none' }}
          >
            {t('itemForm.cancel')}
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={!canSave}
            sx={{ textTransform: 'none', fontWeight: 600 }}
          >
            {isSaving ? t('itemForm.saving') : t('itemForm.save')}
          </Button>
        </Box>
      </Box>
    </ResponsiveModal>
  )
}

export default ReceivableItemForm
