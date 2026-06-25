/**
 * A single transaction row, in two density variants (ADR-017).
 *
 * Desktop: a 5-column grid — date (mono), description + card meta (with optional
 * "recurring" and FX badges, ellipsis-truncated), category (color dot + label),
 * the <Amount> (right-aligned, FX subline on USD rows), and hover/focus Edit +
 * Delete actions. Mobile: a condensed two-column layout (name + category·bank on
 * the left, amount + date on the right) with the row itself tappable to edit and
 * a trailing delete action.
 *
 * All money goes through <Amount>/format; the row never inlines number styling.
 */

import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import EditOutlinedIcon from '@mui/icons-material/EditOutlined'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined'
import AttachFileIcon from '@mui/icons-material/AttachFile'
import NotesOutlinedIcon from '@mui/icons-material/NotesOutlined'
import { Amount } from '../../components/Amount'
import { FxBadge } from '../../components/FxBadge'
import { formatDispDate } from '../../lib/format'
import { monoFontFamily } from '../../theme'
import type { Transaction } from '../../mock/types'
import { fetchInvoiceDocument } from '../../api/invoicesClient'
import { useDocumentOpener } from '../../api/useDocumentOpener'
import { bankLabel, categoryDotColor, categoryLabel } from './presentation'

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
  /** Disable the actions while a delete for this row is in flight. */
  busy?: boolean
}

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

/** Edit + Delete action cluster, reused by both variants. */
function RowActions({
  transaction,
  onEdit,
  onDelete,
  busy,
  className,
}: TransactionRowProps & { className?: string }) {
  const { t } = useTranslation(['transactions', 'common'])
  const label = transaction.name
  return (
    <Stack
      direction="row"
      spacing={0.5}
      className={className}
      sx={{ justifyContent: 'flex-end' }}
    >
      <Tooltip title={t('common:actions.edit')}>
        <span>
          <IconButton
            size="small"
            aria-label={t('transactions:row.edit', { name: label })}
            disabled={busy}
            onClick={() => onEdit(transaction)}
            sx={{
              color: 'text.disabled',
              '&:hover': { color: 'primary.main' },
            }}
          >
            <EditOutlinedIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title={t('common:actions.delete')}>
        <span>
          <IconButton
            size="small"
            aria-label={t('transactions:row.delete', { name: label })}
            disabled={busy}
            onClick={() => onDelete(transaction)}
            sx={{
              color: 'text.disabled',
              '&:hover': { color: 'error.main' },
            }}
          >
            <DeleteOutlineIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
    </Stack>
  )
}

/** Desktop grid row. Actions fade in on row hover/focus-within for calm UX. */
export function TransactionRow(props: TransactionRowProps) {
  const { t: translate } = useTranslation('transactions')
  const { transaction: t } = props
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
          {bankLabel(t.bank)}
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

      <RowActions
        {...props}
        className="tx-row-actions"
        // Hidden until hover/focus-within (desktop calm), but reachable: opacity
        // (not display) keeps the buttons in the tab order.
      />
    </Box>
  )
}

/** Condensed mobile row: name + meta on the left, amount + date on the right. */
export function TransactionRowMobile(props: TransactionRowProps) {
  const { t: translate } = useTranslation(['transactions', 'common'])
  const { transaction: t, onEdit } = props
  const isUsd = t.currency === 'USD'

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        py: 1.375,
        borderBottom: 1,
        borderColor: 'var(--mg-border)',
      }}
    >
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
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
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
          {t.recurring ? (
            <RowBadge>{translate('transactions:row.recurring')}</RowBadge>
          ) : null}
          {isUsd ? <FxBadge /> : null}
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
            {categoryLabel(t.category)} · {bankLabel(t.bank)}
          </Box>
        </Box>
      </Box>

      <Box
        sx={{
          flex: 'none',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
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
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            mt: 0.25,
          }}
        >
          <InvoiceAttachmentBadge transaction={t} />
          <NotesIndicator notes={t.notes} />
          <Typography
            component="span"
            sx={{
              fontFamily: monoFontFamily,
              fontSize: 10.5,
              color: 'text.disabled',
            }}
          >
            {formatDispDate(t.dispDate)}
          </Typography>
        </Box>
      </Box>

      <Tooltip title={translate('common:actions.delete')}>
        <span>
          <IconButton
            size="small"
            aria-label={translate('transactions:row.delete', { name: t.name })}
            disabled={props.busy}
            onClick={() => props.onDelete(t)}
            sx={{ color: 'text.disabled', '&:hover': { color: 'error.main' } }}
          >
            <DeleteOutlineIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
    </Box>
  )
}
