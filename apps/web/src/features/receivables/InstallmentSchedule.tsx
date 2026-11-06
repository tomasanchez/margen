/**
 * A cuota schedule list for one receivable item (ADR-214/215/216/221).
 *
 * One component for both places a plan is shown:
 *  - the item form's LIVE PREVIEW of the even split the server will generate —
 *    rows are flagged "Edited" once the owner tweaks them, and edits stay local
 *    until the form is saved;
 *  - the person's expanded item, where each persisted cuota carries its as-of
 *    status chip (due / upcoming / paid / covered), and edits / pardons write
 *    through immediately.
 *
 * Each row can be edited INLINE (amount + due date, e.g. a recargo added to the
 * last cuota): the row's edit button reveals two fields and Save/Cancel. Enter
 * saves and never submits a surrounding form; Escape cancels. When the parent's
 * `onEditRow` returns a promise, the editor shows a pending state and keeps the
 * input with a calm inline error if it rejects (ADR-037). A cuota can't be
 * lowered below what was already paid toward it: the editor says so up front
 * (when it knows `paidCents`) and maps the API's typed 422 to the same words.
 * While `disabled` (any write for the item in flight) every action — including
 * an open editor's Save — is held.
 *
 * A cuota paid beyond its amount (negative remaining) reads as a CREDIT, never
 * as a negative amount owed.
 *
 * Status is always carried by a WORD + icon, never color alone (ADR-019); money
 * renders through the shared es-AR formatter (ADR-102). Pixel sizes are strings
 * (numeric `sx` sizes are percentages in MUI).
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import IconButton from '@mui/material/IconButton'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded'
import EditOutlinedIcon from '@mui/icons-material/EditOutlined'
import EventOutlinedIcon from '@mui/icons-material/EventOutlined'
import RestoreOutlinedIcon from '@mui/icons-material/RestoreOutlined'
import ScheduleRoundedIcon from '@mui/icons-material/ScheduleRounded'
import VolunteerActivismOutlinedIcon from '@mui/icons-material/VolunteerActivismOutlined'
import {
  InstallmentAmountBelowPaidError,
  type InstallmentStatus,
} from '../../api/receivablesClient'
import { formatCurrency } from '../../lib/format'
import { parseBalance } from '../accounts/balance'
import {
  EARLIEST_DATE,
  LATEST_DATE,
  centsToDecimal,
  centsToNumber,
  decimalToCents,
  isReceivableDate,
  toCents,
  toInputAmount,
} from './installments'

/** One cuota row as the list renders it (money in cents). */
export interface InstallmentScheduleRow {
  /** 1-based position in the plan. */
  index: number
  /** Due date (`YYYY-MM-DD`). */
  dueOn: string
  amountCents: number
  /** Persisted rows: the cuota's as-of status (ADR-215). Absent in a preview. */
  status?: InstallmentStatus
  /** Persisted rows: what is still owed on the cuota, in cents (negative = credit). */
  remainingCents?: number
  /** Persisted rows: already paid toward the cuota — its lowest allowed amount. */
  paidCents?: number
  /** Preview rows: true once the owner tweaked the even split. */
  edited?: boolean
}

/** A saved change to one cuota. */
export interface InstallmentRowChange {
  amountCents: number
  dueOn: string
}

export interface InstallmentScheduleProps {
  rows: InstallmentScheduleRow[]
  /** Accessible name for the list (e.g. "Cuotas of Dinner"). */
  label: string
  /**
   * Save an edit to one cuota. Return a promise for an async (persisted) edit:
   * a rejection keeps the editor open with an inline error.
   */
  onEditRow?: (index: number, change: InstallmentRowChange) => void | Promise<unknown>
  /** Forgive one cuota (persisted rows only). */
  onPardonRow?: (index: number) => void
  /** Restore a forgiven cuota as owed (persisted rows only). */
  onUnpardonRow?: (index: number) => void
  /** Disable every row action (e.g. while the parent saves). */
  disabled?: boolean
  /** Cap the list height (a px string) so a long plan scrolls inside. */
  maxHeight?: string
}

/** Icon + text color reinforcing each status word (never color alone). */
const STATUS_STYLE: Record<
  InstallmentStatus,
  { icon: React.ReactElement; color: string }
> = {
  due: { icon: <ScheduleRoundedIcon />, color: 'warning.main' },
  upcoming: { icon: <EventOutlinedIcon />, color: 'text.secondary' },
  paid: { icon: <CheckCircleOutlineRoundedIcon />, color: 'success.main' },
  pardoned: { icon: <VolunteerActivismOutlinedIcon />, color: 'text.secondary' },
}

/** A small status chip: the status WORD + icon, color only reinforcing it. */
function StatusChip({ status }: { status: InstallmentStatus }) {
  const { t } = useTranslation('receivables')
  const style = STATUS_STYLE[status]
  return (
    <Chip
      label={t(`schedule.status.${status}`)}
      size="small"
      variant="outlined"
      icon={style.icon}
      sx={{
        flex: 'none',
        height: '20px',
        fontSize: 11,
        fontWeight: 600,
        color: style.color,
        borderColor: 'var(--mg-border-2)',
        '& .MuiChip-icon': { fontSize: 13, color: style.color },
      }}
    />
  )
}

/** Why the last persisted save of a cuota failed (shown inline, ADR-037). */
type EditorFailure =
  | { kind: 'belowPaid'; paidCents: number }
  | { kind: 'generic' }

/** The inline editor for one cuota (amount + due date, Save / Cancel). */
function RowEditor({
  index,
  count,
  initial,
  disabled,
  onSave,
  onCancel,
}: {
  index: number
  count: number
  initial: InstallmentScheduleRow
  /** Hold Save while another write for the item is in flight. */
  disabled: boolean
  onSave: (change: InstallmentRowChange) => void | Promise<unknown>
  onCancel: () => void
}) {
  const { t } = useTranslation('receivables')
  const errorId = useId()
  const [amountText, setAmountText] = useState(
    toInputAmount(centsToDecimal(initial.amountCents)),
  )
  const [dueText, setDueText] = useState(initial.dueOn)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<EditorFailure | null>(null)

  const cents = toCents(parseBalance(amountText))
  // Never below what was already paid toward the cuota (the API 422s it).
  const belowPaid =
    cents !== null &&
    initial.paidCents !== undefined &&
    initial.paidCents > 0 &&
    cents < initial.paidCents
  const dueValid = isReceivableDate(dueText)
  const valid = cents !== null && cents > 0 && !belowPaid && dueValid

  const save = () => {
    if (!valid || pending || disabled || cents === null) return
    setFailure(null)
    const result = onSave({ amountCents: cents, dueOn: dueText.trim() })
    if (result instanceof Promise) {
      setPending(true)
      result.then(
        () => setPending(false),
        (error: unknown) => {
          setPending(false)
          setFailure(
            error instanceof InstallmentAmountBelowPaidError
              ? { kind: 'belowPaid', paidCents: decimalToCents(error.paid) }
              : { kind: 'generic' },
          )
        },
      )
    }
  }

  let message: string | null = null
  if (belowPaid && initial.paidCents !== undefined) {
    message = t('schedule.editor.belowPaid', {
      amount: formatCurrency(centsToNumber(initial.paidCents), 'ARS'),
    })
  } else if (failure?.kind === 'belowPaid') {
    message = t('schedule.editor.belowPaid', {
      amount: formatCurrency(centsToNumber(failure.paidCents), 'ARS'),
    })
  } else if (failure) {
    message = t('schedule.editor.error')
  } else if (!dueValid) {
    message = t('schedule.editor.dueOnError')
  }

  // Enter saves THIS cuota (never the surrounding item form); Escape cancels.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      save()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
  }

  return (
    <Box
      onKeyDown={handleKeyDown}
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'flex-start',
        gap: 1,
        mt: 1,
        p: 1.25,
        borderRadius: '10px',
        bgcolor: 'var(--mg-raised)',
        border: '1px solid var(--mg-border-2)',
      }}
    >
      <TextField
        label={t('schedule.editor.amount')}
        value={amountText}
        onChange={(event) => {
          setAmountText(event.target.value)
          setFailure(null)
        }}
        size="small"
        type="number"
        disabled={pending}
        autoFocus
        error={belowPaid || failure?.kind === 'belowPaid'}
        sx={{ width: '140px' }}
        slotProps={{
          htmlInput: {
            min: 0,
            step: 'any',
            inputMode: 'decimal',
            'aria-label': t('schedule.editor.amountAria', { index, count }),
            ...(message ? { 'aria-describedby': errorId } : {}),
          },
        }}
      />
      <TextField
        label={t('schedule.editor.dueOn')}
        value={dueText}
        onChange={(event) => {
          setDueText(event.target.value)
          setFailure(null)
        }}
        size="small"
        type="date"
        disabled={pending}
        error={!dueValid}
        sx={{ width: '170px' }}
        slotProps={{
          inputLabel: { shrink: true },
          htmlInput: {
            min: EARLIEST_DATE,
            max: LATEST_DATE,
            'aria-label': t('schedule.editor.dueOnAria', { index, count }),
          },
        }}
      />
      <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center', pt: 0.25 }}>
        <Button
          type="button"
          size="small"
          variant="contained"
          onClick={save}
          disabled={!valid || pending || disabled}
          // Distinct from the surrounding form's own Save (label-in-name kept).
          aria-label={t('schedule.editor.saveAria', { index, count })}
          sx={{ textTransform: 'none', fontWeight: 600 }}
        >
          {pending ? t('schedule.editor.saving') : t('schedule.editor.save')}
        </Button>
        <Button
          type="button"
          size="small"
          color="secondary"
          onClick={onCancel}
          disabled={pending}
          aria-label={t('schedule.editor.cancelAria', { index, count })}
          sx={{ textTransform: 'none' }}
        >
          {t('schedule.editor.cancel')}
        </Button>
      </Box>
      {message ? (
        <Typography
          id={errorId}
          role="alert"
          sx={{ flexBasis: '100%', fontSize: 12.5, color: 'error.main' }}
        >
          {message}
        </Typography>
      ) : null}
    </Box>
  )
}

export function InstallmentSchedule({
  rows,
  label,
  onEditRow,
  onPardonRow,
  onUnpardonRow,
  disabled = false,
  maxHeight,
}: InstallmentScheduleProps) {
  const { t } = useTranslation('receivables')
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const count = rows.length
  // Each row's edit button, so closing an editor hands focus back to it
  // (keyboard users never land on <body>, ADR-019).
  const editButtons = useRef(new Map<number, HTMLButtonElement>())
  const focusAfterClose = useRef<number | null>(null)

  // Return focus once the editor is gone AND the button is enabled again (it is
  // held while the item's write is in flight) — but only if focus was actually
  // lost with the editor, never stealing it from wherever the owner moved on to.
  useEffect(() => {
    const index = focusAfterClose.current
    if (index === null || disabled) return
    focusAfterClose.current = null
    const active = document.activeElement
    if (active === null || active === document.body) {
      editButtons.current.get(index)?.focus()
    }
  })

  const closeEditor = (index: number) => {
    focusAfterClose.current = index
    setEditingIndex(null)
  }

  const saveRow = (index: number, change: InstallmentRowChange) => {
    const result = onEditRow?.(index, change)
    if (result instanceof Promise) {
      // Persisted edit: close only once it lands; a rejection propagates to the
      // editor (it shows the inline error and keeps the input).
      return result.then(() => closeEditor(index))
    }
    closeEditor(index)
    return undefined
  }

  return (
    <Box
      sx={
        maxHeight
          ? { maxHeight, overflowY: 'auto', pr: 0.5 }
          : undefined
      }
    >
      <Box
        component="ul"
        aria-label={label}
        sx={{ listStyle: 'none', m: 0, p: 0 }}
      >
        {rows.map((row) => {
          const { status } = row
          const pardoned = status === 'pardoned'
          const partiallyPaid =
            (status === 'due' || status === 'upcoming') &&
            row.remainingCents !== undefined &&
            row.remainingCents > 0 &&
            row.remainingCents < row.amountCents
          // Paid beyond its amount: the excess is a credit, not "negative owed".
          const creditCents =
            row.remainingCents !== undefined && row.remainingCents < 0
              ? -row.remainingCents
              : 0
          const canPardon =
            Boolean(onPardonRow) && (status === 'due' || status === 'upcoming')
          const canUnpardon = Boolean(onUnpardonRow) && pardoned
          return (
            <Box
              component="li"
              key={row.index}
              data-testid="installment-row"
              sx={{
                py: 0.875,
                borderBottom: '1px solid var(--mg-border)',
                '&:last-of-type': { borderBottom: 'none' },
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      gap: 0.75,
                    }}
                  >
                    <Typography
                      sx={{ fontSize: 13.5, fontWeight: 600, color: 'text.primary' }}
                    >
                      {t('schedule.cuotaLabel', { index: row.index, count })}
                    </Typography>
                    {status ? <StatusChip status={status} /> : null}
                    {row.edited ? (
                      <Typography
                        component="span"
                        sx={{
                          fontSize: 11,
                          fontWeight: 600,
                          px: 0.75,
                          borderRadius: '999px',
                          border: '1px solid var(--mg-border-2)',
                          color: 'primary.main',
                        }}
                      >
                        {t('schedule.edited')}
                      </Typography>
                    ) : null}
                  </Box>
                  <Typography sx={{ fontSize: 12, mt: 0.25, color: 'text.secondary' }}>
                    {creditCents > 0
                      ? t('schedule.dueOnWithCredit', {
                          date: row.dueOn,
                          amount: formatCurrency(centsToNumber(creditCents), 'ARS'),
                        })
                      : partiallyPaid
                        ? t('schedule.dueOnWithLeft', {
                            date: row.dueOn,
                            amount: formatCurrency(
                              centsToNumber(row.remainingCents ?? 0),
                              'ARS',
                            ),
                          })
                        : t('schedule.dueOn', { date: row.dueOn })}
                  </Typography>
                </Box>
                <Typography
                  sx={{
                    flex: 'none',
                    fontSize: 13.5,
                    fontWeight: 600,
                    fontVariantNumeric: 'tabular-nums',
                    ...(pardoned
                      ? { color: 'text.disabled', textDecoration: 'line-through' }
                      : { color: status === 'paid' ? 'text.secondary' : 'text.primary' }),
                  }}
                >
                  {formatCurrency(centsToNumber(row.amountCents), 'ARS')}
                </Typography>
                {onEditRow ? (
                  <IconButton
                    ref={(button: HTMLButtonElement | null) => {
                      if (button) editButtons.current.set(row.index, button)
                      else editButtons.current.delete(row.index)
                    }}
                    size="small"
                    onClick={() =>
                      setEditingIndex((current) =>
                        current === row.index ? null : row.index,
                      )
                    }
                    disabled={disabled}
                    aria-expanded={editingIndex === row.index}
                    aria-label={t('schedule.editAria', { index: row.index, count })}
                    sx={{ flex: 'none' }}
                  >
                    <EditOutlinedIcon fontSize="small" />
                  </IconButton>
                ) : null}
                {canPardon ? (
                  <IconButton
                    size="small"
                    onClick={() => onPardonRow?.(row.index)}
                    disabled={disabled}
                    aria-label={t('schedule.pardonAria', { index: row.index, count })}
                    sx={{ flex: 'none' }}
                  >
                    <VolunteerActivismOutlinedIcon fontSize="small" />
                  </IconButton>
                ) : null}
                {canUnpardon ? (
                  <IconButton
                    size="small"
                    onClick={() => onUnpardonRow?.(row.index)}
                    disabled={disabled}
                    aria-label={t('schedule.unpardonAria', { index: row.index, count })}
                    sx={{ flex: 'none' }}
                  >
                    <RestoreOutlinedIcon fontSize="small" />
                  </IconButton>
                ) : null}
              </Box>
              {editingIndex === row.index && onEditRow ? (
                <RowEditor
                  index={row.index}
                  count={count}
                  initial={row}
                  disabled={disabled}
                  onSave={(change) => saveRow(row.index, change)}
                  onCancel={() => closeEditor(row.index)}
                />
              ) : null}
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

export default InstallmentSchedule
