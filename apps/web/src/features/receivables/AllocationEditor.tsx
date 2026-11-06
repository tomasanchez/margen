/**
 * Shared allocation UI for the two receivables payment flows — a manual payment
 * ({@link RecordPaymentForm}) and a confirmed income match
 * ({@link ConfirmMatchForm}) — ADR-206/207/215/221.
 *
 *  - {@link AllocationEditor}: one editable row per open TARGET — a flat item, or
 *    one cuota of an installment item ("Dinner · Cuota 2/6"). Rows are prefilled
 *    by the caller from the server's suggested allocation and stay editable. A
 *    row above what its target still owes says so inline (the extra becomes a
 *    credit, confirmed through the 409 warning). UPCOMING cuotas (not due yet)
 *    sit behind a "Show upcoming cuotas" toggle — paying them is an early payment
 *    — but a row that holds an amount is always shown so nothing sent is hidden.
 *  - {@link AllocationBalance}: the total being applied against the money
 *    received. Saving is only possible once they MATCH, so the recorded payment
 *    is never silently smaller or larger than what came in; the panel offers the
 *    explicit ways to get there — apply the rest to upcoming cuotas, put the rest
 *    on a chosen debt, set the received amount to the lines' total (manual
 *    payments), or, for an income match, acknowledge claiming the income for less.
 *  - {@link OverpaymentConfirm}: the ADR-206 confirm-warning shown on a typed 409
 *    — the person-level overpayment (worded for an early payment when upcoming
 *    cuotas are included, or for an existing credit) or one target paid beyond
 *    what it owes, naming that item / cuota and its remainder.
 *
 * Money is es-AR formatted (ADR-102); every state reads as words (ADR-019). The
 * "put the rest on" menu sets `disableScrollLock` for the single-scroll shell.
 */

import { useId, useState, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import FormControlLabel from '@mui/material/FormControlLabel'
import ListItemText from '@mui/material/ListItemText'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { formatCurrency } from '../../lib/format'
import { findTarget, rowCents, type AllocationTarget } from './allocation'
import { centsToNumber, decimalToCents } from './installments'

/** The label, hint and accessible name of a target row. */
function useTargetText() {
  const { t } = useTranslation('receivables')
  return (target: AllocationTarget) => {
    const itemLabel = target.item.detail ?? target.item.occurredOn
    const amount = formatCurrency(centsToNumber(target.remainingCents), 'ARS')
    if (!target.cuota) {
      return {
        label: itemLabel,
        hint: t('allocation.remainingHint', { amount }),
        aria: t('allocation.itemAria', { date: target.item.occurredOn }),
      }
    }
    const shape = {
      index: target.cuota.index,
      count: target.item.installments.length,
    }
    return {
      label: t('allocation.cuotaLabel', { item: itemLabel, ...shape }),
      hint: target.upcoming
        ? t('allocation.upcomingHint', { amount, date: target.cuota.dueOn })
        : t('allocation.dueHint', { amount, date: target.cuota.dueOn }),
      aria: t('allocation.cuotaAria', { ...shape, date: target.item.occurredOn }),
    }
  }
}

/** Money for the display edge. */
function money(cents: number): string {
  return formatCurrency(centsToNumber(cents), 'ARS')
}

/** One editable allocation row, with its inline "beyond what it owes" note. */
function AllocationRow({
  target,
  value,
  onChange,
  disabled,
}: {
  target: AllocationTarget
  value: string
  onChange: (value: string) => void
  disabled: boolean
}) {
  const { t } = useTranslation('receivables')
  const textFor = useTargetText()
  const noteId = useId()
  const text = textFor(target)
  const overBy = rowCents(value) - target.remainingCents
  return (
    <Box data-testid="allocation-row">
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            sx={{ fontSize: 13.5, fontWeight: 600, color: 'text.primary' }}
            noWrap
          >
            {text.label}
          </Typography>
          <Typography sx={{ fontSize: 12.5, mt: 0.25, color: 'text.secondary' }}>
            {text.hint}
          </Typography>
        </Box>
        <TextField
          value={value}
          onChange={(event) => onChange(event.target.value)}
          size="small"
          type="number"
          disabled={disabled}
          sx={{ width: '120px', flex: 'none' }}
          slotProps={{
            htmlInput: {
              // `type="number"` gives a clean mobile numeric keypad;
              // `inputMode="decimal"` + `step="any"` keep decimals, and
              // `min={0}` rejects negatives. Money still flows as a Decimal
              // string (ADR-025).
              min: 0,
              step: 'any',
              inputMode: 'decimal',
              'aria-label': text.aria,
              ...(overBy > 0 ? { 'aria-describedby': noteId } : {}),
            },
          }}
        />
      </Box>
      {overBy > 0 ? (
        <Typography
          id={noteId}
          role="status"
          sx={{ fontSize: 12, mt: 0.5, color: 'warning.main' }}
        >
          {t('allocation.overTarget', {
            amount: money(target.remainingCents),
            extra: money(overBy),
          })}
        </Typography>
      ) : null}
    </Box>
  )
}

export interface AllocationEditorProps {
  targets: readonly AllocationTarget[]
  /** The current row values (input text) by target key. */
  values: Readonly<Record<string, string>>
  onChange: (key: string, value: string) => void
  /** Whether upcoming cuotas without an amount are listed. */
  showUpcoming: boolean
  onToggleUpcoming: () => void
  disabled?: boolean
}

export function AllocationEditor({
  targets,
  values,
  onChange,
  showUpcoming,
  onToggleUpcoming,
  disabled = false,
}: AllocationEditorProps) {
  const { t } = useTranslation('receivables')
  const current = targets.filter((target) => !target.upcoming)
  const upcoming = targets.filter((target) => target.upcoming)
  // An upcoming row holding an amount is ALWAYS shown — never hide money sent.
  const visibleUpcoming = upcoming.filter(
    (target) => showUpcoming || rowCents(values[target.key]) > 0,
  )

  const row = (target: AllocationTarget) => (
    <AllocationRow
      key={target.key}
      target={target}
      value={values[target.key] ?? ''}
      onChange={(value) => onChange(target.key, value)}
      disabled={disabled}
    />
  )

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      {current.map(row)}
      {upcoming.length > 0 ? (
        <Button
          type="button"
          size="small"
          color="secondary"
          onClick={onToggleUpcoming}
          aria-expanded={showUpcoming}
          sx={{ alignSelf: 'flex-start', textTransform: 'none', fontWeight: 600 }}
        >
          {showUpcoming
            ? t('allocation.hideUpcoming')
            : t('allocation.showUpcoming', { count: upcoming.length })}
        </Button>
      ) : null}
      {visibleUpcoming.map(row)}
    </Box>
  )
}

/** A "Put the rest on…" button + target menu (deliberate over-allocation). */
function PutRestOnMenu({
  targets,
  onPick,
  disabled,
}: {
  targets: readonly AllocationTarget[]
  onPick: (key: string) => void
  disabled: boolean
}) {
  const { t } = useTranslation('receivables')
  const textFor = useTargetText()
  const menuId = useId()
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const open = anchorEl !== null
  return (
    <>
      <Button
        type="button"
        size="small"
        color="secondary"
        disabled={disabled}
        onClick={(event: MouseEvent<HTMLElement>) => setAnchorEl(event.currentTarget)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        sx={{ textTransform: 'none', fontWeight: 600 }}
      >
        {t('allocation.putRestOn')}
      </Button>
      <Menu
        id={menuId}
        anchorEl={anchorEl}
        open={open}
        onClose={() => setAnchorEl(null)}
        // Single-scroll shell (ADR-017): `<main>` is the only scroller, so MUI's
        // body scroll-lock has nothing to lock and can leave iOS Safari stuck.
        disableScrollLock
        slotProps={{
          list: { 'aria-label': t('allocation.putRestOnMenu') },
        }}
      >
        {targets.map((target) => {
          const text = textFor(target)
          return (
            <MenuItem
              key={target.key}
              onClick={() => {
                setAnchorEl(null)
                onPick(target.key)
              }}
            >
              <ListItemText primary={text.label} secondary={text.hint} />
            </MenuItem>
          )
        })}
      </Menu>
    </>
  )
}

export interface AllocationBalanceProps {
  /** Σ of the rows, in cents. */
  totalCents: number
  /**
   * The money received (typed amount / matched income), in cents; null while
   * nothing valid is entered (manual payments only).
   */
  receivedCents: number | null
  /** `payment` = a manual payment (received is editable); `income` = a match. */
  mode: 'payment' | 'income'
  /** The total line's label (e.g. "Total payment"). */
  totalLabel: string
  targets: readonly AllocationTarget[]
  /** Whether upcoming cuotas still have room for the rest. */
  canApplyToUpcoming: boolean
  onApplyToUpcoming: () => void
  /** Add the unassigned rest on top of this target's row. */
  onPutRestOn: (key: string) => void
  /** Manual payments: make the received amount equal the lines' total. */
  onSetReceivedToTotal?: () => void
  /** Income matches: the owner accepts claiming the income for less. */
  shortfallAcknowledged?: boolean
  onAcknowledgeShortfall?: (acknowledged: boolean) => void
  disabled?: boolean
}

export function AllocationBalance({
  totalCents,
  receivedCents,
  mode,
  totalLabel,
  targets,
  canApplyToUpcoming,
  onApplyToUpcoming,
  onPutRestOn,
  onSetReceivedToTotal,
  shortfallAcknowledged = false,
  onAcknowledgeShortfall,
  disabled = false,
}: AllocationBalanceProps) {
  const { t } = useTranslation('receivables')
  const rest = receivedCents !== null ? receivedCents - totalCents : 0
  const setReceivedButton =
    mode === 'payment' && onSetReceivedToTotal && totalCents > 0 ? (
      <Button
        type="button"
        size="small"
        color="secondary"
        onClick={onSetReceivedToTotal}
        disabled={disabled}
        sx={{ textTransform: 'none', fontWeight: 600 }}
      >
        {t('allocation.setReceived', { amount: money(totalCents) })}
      </Button>
    ) : null

  let status: React.ReactNode = null
  if (receivedCents === null) {
    if (totalCents > 0) {
      status = (
        <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
          {t('allocation.needReceived')}
        </Typography>
      )
    }
  } else if (rest > 0) {
    status = (
      <Typography sx={{ fontSize: 12.5, color: 'warning.main' }}>
        {mode === 'income'
          ? t('allocation.unassignedIncome', {
              amount: money(rest),
              received: money(receivedCents),
            })
          : t('allocation.unassigned', {
              amount: money(rest),
              received: money(receivedCents),
            })}
      </Typography>
    )
  } else if (rest < 0) {
    status = (
      <Typography sx={{ fontSize: 12.5, color: 'warning.main' }}>
        {mode === 'income'
          ? t('allocation.overIncome', {
              amount: money(-rest),
              received: money(receivedCents),
            })
          : t('allocation.overReceived', {
              amount: money(-rest),
              received: money(receivedCents),
            })}
      </Typography>
    )
  }

  const showRestActions = receivedCents !== null && rest > 0
  const actions =
    showRestActions || setReceivedButton ? (
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
        {showRestActions && canApplyToUpcoming ? (
          <Button
            type="button"
            size="small"
            onClick={onApplyToUpcoming}
            disabled={disabled}
            sx={{ textTransform: 'none', fontWeight: 600 }}
          >
            {t('allocation.applyToUpcoming')}
          </Button>
        ) : null}
        {showRestActions && targets.length > 0 ? (
          <PutRestOnMenu
            targets={targets}
            onPick={onPutRestOn}
            disabled={disabled}
          />
        ) : null}
        {rest !== 0 || receivedCents === null ? setReceivedButton : null}
      </Box>
    ) : null

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        pt: 0.5,
        borderTop: '1px solid var(--mg-border)',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 1,
        }}
      >
        <Typography sx={{ fontSize: 13.5, color: 'text.secondary' }}>
          {totalLabel}
        </Typography>
        <Typography
          sx={{
            fontSize: 14,
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
            color: 'text.primary',
          }}
        >
          {money(totalCents)}
        </Typography>
      </Box>
      <Box role="status" sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
        {status}
      </Box>
      {actions}
      {mode === 'income' && rest > 0 && totalCents > 0 && onAcknowledgeShortfall ? (
        <FormControlLabel
          sx={{ m: 0, alignItems: 'flex-start' }}
          control={
            <Checkbox
              size="small"
              checked={shortfallAcknowledged}
              onChange={(event) => onAcknowledgeShortfall(event.target.checked)}
              disabled={disabled}
              sx={{ mt: -0.5 }}
            />
          }
          label={
            <Typography sx={{ fontSize: 13, color: 'text.primary' }}>
              {t('allocation.acknowledgeShortfall', {
                amount: money(totalCents),
                received: money(receivedCents ?? 0),
              })}
            </Typography>
          }
        />
      ) : null}
    </Box>
  )
}

/** A typed 409 the confirm explains (ADR-206). */
export type OverpaymentConflict =
  | {
      kind: 'person'
      /** The person's due-only outstanding (may be ≤ 0: an existing credit). */
      outstanding: string
      requested: string
    }
  | {
      kind: 'target'
      itemId: string
      installmentId: string | null
      /** What the item / cuota still owes. */
      remaining: string
      /** What the payment applies to it. */
      requested: string
    }

export interface OverpaymentConfirmProps {
  conflict: OverpaymentConflict
  /** The targets, to name the item / cuota a target conflict is about. */
  targets: readonly AllocationTarget[]
  /** True when the rows pay upcoming cuotas early (ADR-215). */
  early: boolean
  onBack: () => void
  onConfirm: () => void
  disabled?: boolean
}

export function OverpaymentConfirm({
  conflict,
  targets,
  early,
  onBack,
  onConfirm,
  disabled = false,
}: OverpaymentConfirmProps) {
  const { t } = useTranslation('receivables')
  const textFor = useTargetText()

  let title: string
  let body: string
  if (conflict.kind === 'target') {
    const target = findTarget(targets, conflict.itemId, conflict.installmentId)
    const label = target ? textFor(target).label : t('overpayment.unknownTarget')
    const remainingCents = decimalToCents(conflict.remaining)
    title = t('overpayment.targetTitle')
    body = t('overpayment.targetBody', {
      target: label,
      remaining: money(remainingCents),
      requested: money(decimalToCents(conflict.requested)),
      extra: money(decimalToCents(conflict.requested) - remainingCents),
    })
  } else {
    const outstandingCents = decimalToCents(conflict.outstanding)
    const amounts = {
      requested: money(decimalToCents(conflict.requested)),
      outstanding: money(outstandingCents),
    }
    if (outstandingCents <= 0) {
      title = t('overpayment.title')
      body = t('overpayment.creditBody', {
        requested: amounts.requested,
        credit: money(-outstandingCents),
      })
    } else if (early) {
      title = t('overpayment.earlyTitle')
      body = t('overpayment.earlyBody', amounts)
    } else {
      title = t('overpayment.title')
      body = t('overpayment.body', amounts)
    }
  }

  return (
    <Box>
      <Typography
        role="alert"
        sx={{ fontSize: 14, color: 'warning.main', fontWeight: 600 }}
      >
        {title}
      </Typography>
      <Typography sx={{ fontSize: 13.5, mt: 1, color: 'text.secondary' }}>
        {body}
      </Typography>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 3 }}>
        <Button
          type="button"
          onClick={onBack}
          color="secondary"
          sx={{ textTransform: 'none' }}
        >
          {t('overpayment.cancel')}
        </Button>
        <Button
          type="button"
          onClick={onConfirm}
          color="warning"
          variant="contained"
          disabled={disabled}
          sx={{ textTransform: 'none', fontWeight: 600 }}
        >
          {t('overpayment.confirm')}
        </Button>
      </Box>
    </Box>
  )
}
