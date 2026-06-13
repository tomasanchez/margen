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

import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import EditOutlinedIcon from '@mui/icons-material/EditOutlined'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined'
import { Amount } from '../../components/Amount'
import { formatDispDate } from '../../lib/format'
import { monoFontFamily } from '../../theme'
import type { Transaction } from '../../mock/types'
import { categoryDotColor } from './presentation'

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
  const label = transaction.name
  return (
    <Stack
      direction="row"
      spacing={0.5}
      className={className}
      sx={{ justifyContent: 'flex-end' }}
    >
      <Tooltip title="Edit">
        <span>
          <IconButton
            size="small"
            aria-label={`Edit ${label}`}
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
      <Tooltip title="Delete">
        <span>
          <IconButton
            size="small"
            aria-label={`Delete ${label}`}
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
          {t.recurring ? <RowBadge>recurring</RowBadge> : null}
          {isUsd ? <RowBadge tone="gold">FX</RowBadge> : null}
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
          {t.bank}
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
          {t.category}
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
        aria-label={`Edit ${t.name}`}
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
          {t.recurring ? <RowBadge>recurring</RowBadge> : null}
          {isUsd ? <RowBadge tone="gold">FX</RowBadge> : null}
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
            {t.category} · {t.bank}
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
        />
        <Typography
          component="span"
          sx={{
            fontFamily: monoFontFamily,
            fontSize: 10.5,
            color: 'text.disabled',
            mt: 0.25,
          }}
        >
          {formatDispDate(t.dispDate)}
        </Typography>
      </Box>

      <Tooltip title="Delete">
        <span>
          <IconButton
            size="small"
            aria-label={`Delete ${t.name}`}
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
