/**
 * A single transaction row, in two density variants (ADR-017).
 *
 * Desktop: a 5-column grid — date (mono), description + card meta (with optional
 * "recurring" and FX badges, ellipsis-truncated), category (color dot + label),
 * the <Amount> (right-aligned, FX subline on USD rows), and a trailing overflow
 * "Actions" menu (⋮) that fades in on row hover/focus-within. Mobile: a condensed
 * two-column layout (name + category·bank on the left, amount + date on the
 * right) with the row itself tappable to edit and the SAME trailing overflow menu
 * (always visible). Both breakpoints share ONE menu-driven actions affordance
 * ({@link RowOverflowMenu}); only the trigger's visibility differs.
 *
 * All money goes through <Amount>/format; the row never inlines number styling.
 */

import { useCallback, useId, useState, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import EditOutlinedIcon from '@mui/icons-material/EditOutlined'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined'
import AttachFileIcon from '@mui/icons-material/AttachFile'
import MoreVertIcon from '@mui/icons-material/MoreVert'
import NotesOutlinedIcon from '@mui/icons-material/NotesOutlined'
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined'
import UndoOutlinedIcon from '@mui/icons-material/UndoOutlined'
import { Amount } from '../../components/Amount'
import { FxBadge } from '../../components/FxBadge'
import { formatDispDate } from '../../lib/format'
import { monoFontFamily } from '../../theme'
import type { Transaction } from '../../mock/types'
import { fetchInvoiceDocument } from '../../api/invoicesClient'
import { useDocumentOpener } from '../../api/useDocumentOpener'
import {
  attributionLabel,
  categoryDotColor,
  categoryLabel,
} from './presentation'

/**
 * Compact attachment control for an imported invoice (ADR-072). Imported ARCA
 * invoices are persisted with `kind === 'invoice'`, so we surface a small "PDF"
 * chip that opens the stored document in a new tab.
 *
 * Every API route now requires a Supabase bearer token (ADR-092), so this can no
 * longer be a plain `<a href>` (a bare GET sends no token and 401s). It is an
 * accessible button that fetches the bytes through {@link fetchInvoiceDocument}
 * (authed), opens a short-lived object URL, then revokes it (the PDF is sensitive
 * PII — ADR-073). It shows a calm inline spinner while fetching and a calm error
 * tooltip on failure (ADR-037), carries an icon + text label (not color alone —
 * ADR-019), and stops the click from triggering the row's edit affordance.
 */
function InvoiceAttachmentBadge({ transaction }: { transaction: Transaction }) {
  const { t } = useTranslation('transactions')
  const fetchBlob = useCallback(
    () => fetchInvoiceDocument(transaction.id),
    [transaction.id],
  )
  const { open, loading, error } = useDocumentOpener(fetchBlob)

  if (transaction.kind !== 'invoice') return null

  const label = t('row.openInvoicePdfFor', { name: transaction.name })

  return (
    <Box
      sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}
    >
      <Tooltip title={error ?? t('row.openInvoicePdf')}>
        <Box
          component="button"
          type="button"
          disabled={loading}
          aria-label={label}
          aria-busy={loading || undefined}
          onClick={(event) => {
            event.stopPropagation()
            open()
          }}
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.375,
            flex: 'none',
            fontSize: 10,
            lineHeight: 1.6,
            px: 0.625,
            py: 0,
            borderRadius: '5px',
            border: '1px solid',
            borderColor: error ? 'error.main' : 'var(--mg-border-2)',
            color: error ? 'error.main' : 'text.secondary',
            bgcolor: 'var(--mg-raised)',
            font: 'inherit',
            cursor: loading ? 'default' : 'pointer',
            whiteSpace: 'nowrap',
            '&:hover': {
              color: error ? 'error.main' : 'primary.main',
              borderColor: error ? 'error.main' : 'primary.main',
            },
            '&:focus-visible': {
              outline: '2px solid',
              outlineColor: 'primary.main',
              outlineOffset: 2,
            },
            '&:disabled': { cursor: 'default' },
          }}
        >
          {loading ? (
            <CircularProgress
              size={9}
              thickness={6}
              color="inherit"
              aria-hidden
            />
          ) : (
            <AttachFileIcon sx={{ fontSize: 11 }} aria-hidden />
          )}
          PDF
        </Box>
      </Tooltip>
      {/* Calm, polite error surfaced as text (not color alone — ADR-019/037).
          aria-live announces it to screen readers; it is always in the DOM so
          mouse, keyboard, and AT users all get the failure without hovering. */}
      {error ? (
        <Typography
          role="alert"
          component="span"
          sx={{
            fontSize: 10,
            lineHeight: 1.6,
            color: 'error.main',
            whiteSpace: 'nowrap',
          }}
        >
          {error}
        </Typography>
      ) : null}
    </Box>
  )
}

/**
 * Calm per-row notes indicator (ADR-037). When a transaction carries free-text
 * notes — now including statement installment detail like
 * "Compra 20-03-26 · Cuota 03/03" (ADR-088/089) — we surface a small, muted
 * notes icon beside the name; the note itself shows in a Tooltip on hover OR
 * focus.
 *
 * It is an indicator, not an action: it never triggers the row's edit affordance
 * (it stops click propagation, mirroring the attachment badge). But it must still
 * be reachable without a mouse (ADR-019) — hover alone is insufficient — so it is
 * a focusable element (`tabIndex={0}`) carrying an `aria-label` that announces the
 * label + the note text, and the Tooltip opens on focus too. Renders nothing when
 * there are no notes (no empty affordance).
 */
function NotesIndicator({ notes }: { notes?: string }) {
  const { t } = useTranslation('transactions')

  const trimmed = notes?.trim()
  if (!trimmed) return null

  return (
    <Tooltip title={trimmed}>
      <Box
        component="span"
        role="note"
        tabIndex={0}
        aria-label={`${t('row.notes')}: ${trimmed}`}
        onClick={(event) => event.stopPropagation()}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          flex: 'none',
          color: 'text.disabled',
          cursor: 'default',
          borderRadius: '5px',
          '&:hover': { color: 'text.secondary' },
          '&:focus-visible': {
            outline: '2px solid',
            outlineColor: 'primary.main',
            outlineOffset: 2,
          },
        }}
      >
        <NotesOutlinedIcon sx={{ fontSize: 13 }} aria-hidden />
      </Box>
    </Tooltip>
  )
}

/** Shared grid template so the column header and each desktop row align. */
export const DESKTOP_GRID_COLUMNS = '58px minmax(0, 1fr) 140px 150px 72px'

interface TransactionRowProps {
  transaction: Transaction
  /** Open the Add/Edit seam prefilled from this row. */
  onEdit: (transaction: Transaction) => void
  /** Delete this row (delete mutation). */
  onDelete: (transaction: Transaction) => void
  /**
   * Open the Add flow to record a REIMBURSEMENT (payback) against this EXPENSE
   * row (ADR-158/159). Present only for expense rows; when omitted (or the row
   * isn't an expense) the action is hidden.
   */
  onReimburse?: (transaction: Transaction) => void
  /** Disable the actions while a delete for this row is in flight. */
  busy?: boolean
  /**
   * `accountId → institutionName` lookup built once on the page from the loaded
   * accounts (ADR-136 extension). Drives the row's attribution line: a linked
   * account resolves to its institution name; an unlinked row falls back to the
   * legacy `bank · card` tag. Defaults to an empty map so the row degrades to the
   * bank fallback when accounts haven't loaded (or in bare tests).
   */
  accountNames?: ReadonlyMap<string, string>
}

/** Shared empty lookup so a missing `accountNames` prop is a stable reference. */
const EMPTY_ACCOUNT_NAMES: ReadonlyMap<string, string> = new Map()

/** Small inline badge (recurring / FX) — a bordered pill, token-colored. */
function RowBadge({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode
  tone?: 'neutral' | 'gold'
}) {
  return (
    <Box
      component="span"
      sx={{
        flex: 'none',
        fontSize: 10,
        lineHeight: 1.6,
        px: 0.75,
        borderRadius: '5px',
        border: '1px solid',
        borderColor: tone === 'gold' ? 'primary.main' : 'var(--mg-border-2)',
        color: tone === 'gold' ? 'primary.main' : 'text.secondary',
        bgcolor:
          tone === 'gold'
            ? 'color-mix(in srgb, var(--mg-gold) 12%, transparent)'
            : 'var(--mg-raised)',
        fontFamily: tone === 'gold' ? monoFontFamily : undefined,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </Box>
  )
}

/** A 6px category dot — a redundant cue beside the category text. */
function CategoryDot({ category }: { category: Transaction['category'] }) {
  return (
    <Box
      aria-hidden
      sx={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        flex: 'none',
        bgcolor: categoryDotColor(category),
      }}
    />
  )
}

/**
 * Whether a row has a stored document to open — the same condition the inline
 * {@link InvoiceAttachmentBadge} uses (imported ARCA invoices are persisted with
 * `kind === 'invoice'`, ADR-072). Drives the "Open PDF" overflow item.
 */
function hasAttachedDocument(transaction: Transaction): boolean {
  return transaction.kind === 'invoice'
}

/**
 * A single entry in the row's actions menu — a declarative descriptor so new
 * actions can be added by pushing to the list (below) rather than hand-writing
 * per-breakpoint JSX. `render()` returns whether the item is shown for a given
 * row; `danger` flags the destructive Remove item for `error.main` styling; a
 * `dividerBefore` renders a separator above the item (used before Remove).
 */
interface RowActionItem {
  key: string
  label: string
  icon: React.ReactNode
  onSelect: () => void
  /** Predicate deciding whether this item is present for the current row. */
  show: boolean
  /** Disable (but keep visible) while a mutation is in flight (ADR-036/037). */
  disabled?: boolean
  /** Destructive styling for the Remove item. */
  danger?: boolean
  /** Render a <Divider /> above this item. */
  dividerBefore?: boolean
}

/**
 * Shared kebab (⋮) overflow "Actions" menu for BOTH row variants (ADR-017).
 * Consolidates the per-row actions — Edit, Add reimbursement (expense-only),
 * Open PDF (when a document is attached), and Remove — behind a single labeled
 * icon button. This is the ONE affordance for desktop and mobile alike: the
 * desktop grid row and the condensed mobile row both render it. The only
 * difference is visibility of the TRIGGER — desktop hides it until the row is
 * hovered/focused (`hideTriggerUntilActive`, via the `.tx-row-actions` opacity
 * fade — opacity, not display, so keyboard users keep it in the tab order);
 * mobile always shows the kebab. The MENU and its items are identical.
 *
 * Items are built as a declarative {@link RowActionItem} list filtered by each
 * item's `show` predicate, so future actions are added by extending the list
 * (Edit, Add reimbursement, Open PDF, divider, Remove) — no duplicated JSX.
 *
 * Accessibility (ADR-019): the trigger carries an `aria-label`, `aria-haspopup`,
 * and `aria-expanded`; the menu items are real `MenuItem`s with an icon AND a
 * text label (non-color cues); the menu is keyboard-operable, closes on action,
 * and returns focus to the trigger (MUI Menu). Remove/Reimburse preserve the
 * calm `busy` disabled state (ADR-036/037).
 *
 * "Open PDF" drives the SAME authed document opener as the inline badge: it
 * fetches the stored bytes WITH the bearer token (ADR-092), opens a short-lived
 * object URL (ADR-073/081), and surfaces a calm error as text — not color alone
 * (ADR-019/037) — beside the trigger on failure.
 */
function RowOverflowMenu({
  transaction,
  onEdit,
  onDelete,
  onReimburse,
  busy,
  hideTriggerUntilActive,
}: TransactionRowProps & {
  /**
   * Desktop calm UX: hide the trigger until the row is hovered/focused-within.
   * The trigger stays in the tab order (opacity, not display), so keyboard users
   * never lose the affordance (ADR-019). Mobile leaves this off (kebab always
   * visible).
   */
  hideTriggerUntilActive?: boolean
}) {
  const { t } = useTranslation(['transactions', 'common'])
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const open = Boolean(anchorEl)
  const menuId = useId()

  const fetchBlob = useCallback(
    () => fetchInvoiceDocument(transaction.id),
    [transaction.id],
  )
  const { open: openDocument, loading, error } = useDocumentOpener(fetchBlob)

  const handleClose = () => setAnchorEl(null)
  const handleOpen = (event: MouseEvent<HTMLElement>) => {
    event.stopPropagation()
    setAnchorEl(event.currentTarget)
  }
  /** Close the menu, then run the action (keeps focus return to the trigger). */
  const runAndClose = (action: () => void) => () => {
    handleClose()
    action()
  }

  // Declarative item list. Order: Edit, Add reimbursement, Open PDF, divider,
  // Remove. Each item's `show` gates its presence; extend this list to add
  // future actions without touching the render below.
  const items: RowActionItem[] = [
    {
      key: 'edit',
      label: t('common:actions.edit'),
      icon: <EditOutlinedIcon fontSize="small" />,
      onSelect: runAndClose(() => onEdit(transaction)),
      show: true,
    },
    {
      key: 'reimburse',
      label: t('transactions:row.reimburse'),
      icon: <UndoOutlinedIcon fontSize="small" />,
      onSelect: runAndClose(() => onReimburse?.(transaction)),
      // The "add reimbursement" action links a payback to THIS expense
      // (ADR-158/159); shown only for expense rows that have a handler wired.
      show: Boolean(onReimburse) && transaction.type === 'expense',
      disabled: busy,
    },
    {
      key: 'openPdf',
      label: t('transactions:row.openPdf'),
      icon: <OpenInNewOutlinedIcon fontSize="small" />,
      onSelect: runAndClose(() => openDocument()),
      show: hasAttachedDocument(transaction),
      disabled: loading,
    },
    {
      key: 'delete',
      label: t('common:actions.delete'),
      icon: <DeleteOutlineIcon fontSize="small" />,
      onSelect: runAndClose(() => onDelete(transaction)),
      show: true,
      disabled: busy,
      danger: true,
      dividerBefore: true,
    },
  ]
  const visibleItems = items.filter((item) => item.show)

  return (
    <Box
      className={hideTriggerUntilActive ? 'tx-row-actions' : undefined}
      sx={{
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 0.5,
        // Desktop: fade the trigger in on row hover/focus-within. Kept in the tab
        // order (opacity, not display), and forced visible while the menu is open
        // so it never vanishes mid-interaction.
        ...(hideTriggerUntilActive
          ? { opacity: open ? 1 : 0, transition: 'opacity 120ms ease' }
          : null),
      }}
      // The kebab and its menu are actions, not the row's edit affordance: keep
      // taps from bubbling to the surrounding tappable name button.
      onClick={(event) => event.stopPropagation()}
    >
      {/* Calm, polite failure surfaced as text — not color alone (ADR-019/037).
          Always in the DOM (role="alert" + aria-live) so mouse, keyboard, and
          AT users all learn the open failed without hovering anything. */}
      {error ? (
        <Typography
          role="alert"
          component="span"
          sx={{
            fontSize: 10,
            lineHeight: 1.4,
            color: 'error.main',
            textAlign: 'right',
            maxWidth: 120,
          }}
        >
          {error}
        </Typography>
      ) : null}
      <IconButton
        size="small"
        aria-label={t('transactions:row.actionsAriaLabel', {
          name: transaction.name,
        })}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        aria-expanded={open ? 'true' : undefined}
        aria-busy={loading || undefined}
        onClick={handleOpen}
        sx={{ color: 'text.disabled', '&:hover': { color: 'text.primary' } }}
      >
        {loading ? (
          <CircularProgress size={18} thickness={5} color="inherit" aria-hidden />
        ) : (
          <MoreVertIcon fontSize="small" />
        )}
      </IconButton>

      <Menu
        id={menuId}
        anchorEl={anchorEl}
        open={open}
        onClose={handleClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{
          paper: {
            elevation: 0,
            sx: {
              mt: 0.5,
              minWidth: 184,
              borderRadius: 2,
              border: 1,
              borderColor: 'divider',
              bgcolor: 'background.paper',
              boxShadow: '0 12px 32px -12px rgba(0,0,0,0.45)',
            },
          },
          list: {
            sx: { py: 0.5 },
            'aria-label': t('transactions:row.actionsAriaLabel', {
              name: transaction.name,
            }),
          },
        }}
      >
        {visibleItems.map((item) => [
          item.dividerBefore ? (
            <Divider key={`${item.key}-divider`} sx={{ my: 0.5 }} />
          ) : null,
          <MenuItem
            key={item.key}
            onClick={item.onSelect}
            disabled={item.disabled}
            sx={{ py: 1.25, ...(item.danger ? { color: 'error.main' } : null) }}
          >
            <ListItemIcon
              sx={{ color: item.danger ? 'error.main' : 'text.secondary' }}
            >
              {item.icon}
            </ListItemIcon>
            <ListItemText primary={item.label} />
          </MenuItem>,
        ])}
      </Menu>
    </Box>
  )
}

/** Desktop grid row. Actions fade in on row hover/focus-within for calm UX. */
export function TransactionRow(props: TransactionRowProps) {
  const { t: translate } = useTranslation('transactions')
  const { transaction: t, accountNames = EMPTY_ACCOUNT_NAMES } = props
  const isUsd = t.currency === 'USD'

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: DESKTOP_GRID_COLUMNS,
        gap: 1.75,
        alignItems: 'center',
        px: 0.5,
        py: 1.5,
        borderBottom: 1,
        borderColor: 'var(--mg-border)',
        // Actions stay visible on hover and whenever a control inside is focused
        // (keyboard users never lose the affordance — ADR-019).
        '&:hover .tx-row-actions, &:focus-within .tx-row-actions': {
          opacity: 1,
        },
      }}
    >
      <Typography
        component="span"
        sx={{
          fontFamily: monoFontFamily,
          fontSize: 12.5,
          color: 'text.disabled',
          whiteSpace: 'nowrap',
        }}
      >
        {formatDispDate(t.dispDate)}
      </Typography>

      <Box sx={{ minWidth: 0 }}>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            minWidth: 0,
          }}
        >
          <Typography
            component="span"
            color="text.primary"
            sx={{
              fontSize: 14,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            {t.name}
          </Typography>
          {t.kind === 'reimbursement' ? (
            <RowBadge tone="gold">{translate('row.reimbursement')}</RowBadge>
          ) : null}
          {t.recurring ? <RowBadge>{translate('row.recurring')}</RowBadge> : null}
          {isUsd ? <FxBadge /> : null}
          <InvoiceAttachmentBadge transaction={t} />
          <NotesIndicator notes={t.notes} />
        </Box>
        <Typography
          component="span"
          sx={{
            display: 'block',
            mt: 0.375,
            fontFamily: monoFontFamily,
            fontSize: 11.5,
            color: 'text.disabled',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {attributionLabel(t, accountNames)}
        </Typography>
      </Box>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          minWidth: 0,
          color: 'var(--mg-text-mid)',
          fontSize: 13,
        }}
      >
        <CategoryDot category={t.category} />
        <Box
          component="span"
          sx={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {categoryLabel(t.category)}
        </Box>
      </Box>

      <Box sx={{ justifySelf: 'end', textAlign: 'right' }}>
        <Amount
          value={t.amountNum}
          type={t.type}
          currency="ARS"
          size="sm"
          fxUsd={isUsd ? t.usd : undefined}
          fxRate={isUsd ? t.rate : undefined}
          fxSource={isUsd ? t.fxRateType : undefined}
        />
      </Box>

      {/* Trailing actions column: the SAME overflow menu the mobile row uses,
          but the trigger fades in on row hover/focus-within (desktop calm). It
          stays keyboard-reachable — opacity, not display, keeps it in the tab
          order (ADR-019). */}
      <RowOverflowMenu {...props} hideTriggerUntilActive />
    </Box>
  )
}

/**
 * Condensed mobile row (ADR-017). Three zones: a tappable LEFT column (name +
 * `category · bank`, truncated), a right-aligned AMOUNT column (signed amount,
 * its FX subline, and the date stacked beneath), and a trailing kebab (⋮)
 * overflow menu that consolidates Edit / Remove / Open PDF (replacing the old
 * inline trash icon + "PDF" chip that crowded the row).
 *
 * The informational FX badge and notes indicator stay inline next to the name
 * (they are cues, not actions — ADR-019), not buried in the menu. The left text
 * truncates via `minWidth: 0` + ellipsis (never numeric `sx` widths — those are
 * percentages, not px) so a long name can't push the amount off-screen.
 */
export function TransactionRowMobile(props: TransactionRowProps) {
  const { t: translate } = useTranslation(['transactions', 'common'])
  const { transaction: t, onEdit, accountNames = EMPTY_ACCOUNT_NAMES } = props
  const isUsd = t.currency === 'USD'
  // Attribution can be empty now that the bank column is retired (ADR-136); when
  // it is, show the category alone (no dangling " · " separator).
  const attribution = attributionLabel(t, accountNames)
  const categoryText = categoryLabel(t.category)

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        py: 1.375,
        borderBottom: 1,
        borderColor: 'var(--mg-border)',
      }}
    >
      {/* LEFT: tappable name + meta. flex:1 + minWidth:0 lets it shrink and
          ellipsis-truncate instead of shoving the amount column off-screen. */}
      <Box
        component="button"
        type="button"
        onClick={() => onEdit(t)}
        aria-label={translate('transactions:row.edit', { name: t.name })}
        sx={{
          flex: 1,
          minWidth: 0,
          textAlign: 'left',
          background: 'none',
          border: 'none',
          p: 0,
          cursor: 'pointer',
          color: 'inherit',
          font: 'inherit',
          '&:focus-visible': {
            outline: '2px solid',
            outlineColor: 'primary.main',
            outlineOffset: 2,
            borderRadius: 1,
          },
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
          <Typography
            component="span"
            color="text.primary"
            sx={{
              fontSize: 13.5,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            {t.name}
          </Typography>
          {t.kind === 'reimbursement' ? (
            <RowBadge tone="gold">
              {translate('transactions:row.reimbursement')}
            </RowBadge>
          ) : null}
          {t.recurring ? (
            <RowBadge>{translate('transactions:row.recurring')}</RowBadge>
          ) : null}
          {isUsd ? <FxBadge /> : null}
          <NotesIndicator notes={t.notes} />
        </Box>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            mt: 0.25,
            fontSize: 11,
            color: 'text.disabled',
            minWidth: 0,
          }}
        >
          <CategoryDot category={t.category} />
          <Box
            component="span"
            sx={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {attribution ? `${categoryText} · ${attribution}` : categoryText}
          </Box>
        </Box>
      </Box>

      {/* RIGHT: right-aligned amount column — amount, FX subline, then date. */}
      <Box
        sx={{
          flex: 'none',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          textAlign: 'right',
        }}
      >
        <Amount
          value={t.amountNum}
          type={t.type}
          currency="ARS"
          size="sm"
          fxUsd={isUsd ? t.usd : undefined}
          fxRate={isUsd ? t.rate : undefined}
          fxSource={isUsd ? t.fxRateType : undefined}
        />
        <Typography
          component="span"
          sx={{
            mt: 0.25,
            fontFamily: monoFontFamily,
            fontSize: 10.5,
            color: 'text.disabled',
            whiteSpace: 'nowrap',
          }}
        >
          {formatDispDate(t.dispDate)}
        </Typography>
      </Box>

      <RowOverflowMenu {...props} />
    </Box>
  )
}
