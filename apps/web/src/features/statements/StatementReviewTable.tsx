/**
 * Statement review table (ADR-080).
 *
 * The primary surface of the CC-statement import flow: after a successful parse
 * it shows the detected card identity + statement period in a header strip, a
 * non-blocking duplicate warning when flagged (ADR-077), and an editable table
 * of the parsed line drafts. Each row shows the date, merchant, amount (+ its
 * currency), an editable category selector, the installment (`cuota`) as a
 * read-only chip when present, and an include/exclude toggle (seeded from the
 * parser's `include`). A persistent footer shows the running total of the kept
 * lines and the primary "Import N expenses" action.
 *
 * Accessibility (ADR-019): the keep/exclude state is conveyed beyond hue — each
 * row carries an explicit "Will import" / "Skipped" text status, the Switch has
 * a descriptive `aria-label`, and excluded rows are dimmed AND struck-through (a
 * non-color cue). All controls are keyboard-operable (native Switch / Select).
 */

import { useId } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import Typography from '@mui/material/Typography'
import CreditCardRoundedIcon from '@mui/icons-material/CreditCardRounded'
import { CATEGORIES } from '../../mock/seed'
import { formatCurrency, isoToDispDateLike } from './format'
import { monoFontFamily } from '../../theme'
import type { StatementParse } from '../../api/statementsClient'
import {
  useStatementReviewState,
  type ReviewLine,
} from './useStatementReviewState'

/** Expense categories offered in the per-line editor (statements are expenses). */
const STATEMENT_CATEGORIES = CATEGORIES.filter((c) => c !== 'Income')

/** Uppercase eyebrow used by the header strip facts. */
function FactLabel({ children }: { children: React.ReactNode }) {
  return (
    <Typography
      variant="overline"
      component="span"
      sx={{ display: 'block', color: 'text.disabled', lineHeight: 1.4 }}
    >
      {children}
    </Typography>
  )
}

/** One fact (label + value) in the header strip. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <FactLabel>{label}</FactLabel>
      <Typography sx={{ fontSize: 13.5, color: 'text.primary' }}>
        {value}
      </Typography>
    </Box>
  )
}

export interface StatementReviewTableProps {
  /** The successful (`status: 'ok'`) parse to review. */
  parse: StatementParse
  /** Submit the kept selection for import; receives the built request. */
  onImport: (request: ReturnType<StatementReviewState['buildImportRequest']>) => void
  /** Whether an import mutation is in flight (disables controls / shows progress). */
  isImporting: boolean
}

type StatementReviewState = ReturnType<typeof useStatementReviewState>

/** A single editable line row. */
function LineRow({
  line,
  onToggleKeep,
  onCategoryChange,
  disabled,
}: {
  line: ReviewLine
  onToggleKeep: (id: string, keep: boolean) => void
  onCategoryChange: (id: string, category: string) => void
  disabled: boolean
}) {
  const selectLabelId = useId()
  const kept = line.keep
  // Non-color status: an explicit word + strike-through on skipped rows so the
  // keep/exclude state never depends on the dimmed hue alone (ADR-019).
  const statusWord = kept ? 'Will import' : 'Skipped'
  return (
    <TableRow
      sx={{
        opacity: kept ? 1 : 0.55,
        '& .MuiTableCell-root': { borderColor: 'var(--mg-border-2)' },
      }}
    >
      <TableCell sx={{ whiteSpace: 'nowrap', fontFamily: monoFontFamily, fontSize: 12.5 }}>
        {isoToDispDateLike(line.occurredOn)}
      </TableCell>
      <TableCell sx={{ minWidth: 160 }}>
        <Typography
          sx={{
            fontSize: 13.5,
            color: 'text.primary',
            textDecoration: kept ? 'none' : 'line-through',
          }}
        >
          {line.name}
        </Typography>
        {line.lineKind === 'fee' ? (
          <Typography sx={{ fontSize: 11.5, color: 'text.disabled' }}>
            Fee / charge
          </Typography>
        ) : null}
      </TableCell>
      <TableCell
        align="right"
        sx={{
          whiteSpace: 'nowrap',
          fontFamily: monoFontFamily,
          fontSize: 13,
          textDecoration: kept ? 'none' : 'line-through',
        }}
      >
        {formatCurrency(line.amount, line.currency)}
      </TableCell>
      <TableCell sx={{ minWidth: 150 }}>
        <Typography
          id={selectLabelId}
          component="span"
          sx={visuallyHiddenSx}
        >
          Category for {line.name}
        </Typography>
        <Select
          value={line.category ?? ''}
          onChange={(e) => onCategoryChange(line.id, e.target.value)}
          displayEmpty
          size="small"
          disabled={disabled || !kept}
          aria-labelledby={selectLabelId}
          fullWidth
          sx={{
            fontSize: 13,
            '& .MuiSelect-select': { py: 0.6 },
            '& .MuiOutlinedInput-notchedOutline': {
              borderColor: 'var(--mg-border-2)',
            },
          }}
        >
          <MenuItem value="">
            <em>Uncategorized</em>
          </MenuItem>
          {STATEMENT_CATEGORIES.map((category) => (
            <MenuItem key={category} value={category}>
              {category}
            </MenuItem>
          ))}
        </Select>
      </TableCell>
      <TableCell>
        {line.cuota ? (
          <Chip
            label={line.cuota}
            size="small"
            variant="outlined"
            sx={{
              fontFamily: monoFontFamily,
              fontSize: 11.5,
              borderColor: 'var(--mg-border-2)',
              color: 'text.secondary',
            }}
          />
        ) : (
          <Typography sx={{ fontSize: 12, color: 'text.disabled' }}>—</Typography>
        )}
      </TableCell>
      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
        <Box
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.75,
            justifyContent: 'flex-end',
          }}
        >
          <Typography
            component="span"
            sx={{
              fontSize: 11.5,
              fontWeight: 600,
              color: kept ? 'primary.main' : 'text.disabled',
            }}
          >
            {statusWord}
          </Typography>
          <Switch
            checked={kept}
            onChange={(e) => onToggleKeep(line.id, e.target.checked)}
            disabled={disabled}
            size="small"
            slotProps={{
              input: {
                'aria-label': kept
                  ? `Skip ${line.name} — currently set to import`
                  : `Import ${line.name} — currently skipped`,
              },
            }}
          />
        </Box>
      </TableCell>
    </TableRow>
  )
}

/** Visually-hidden style for off-screen labels (mirrors @mui/utils visuallyHidden). */
const visuallyHiddenSx = {
  border: 0,
  clip: 'rect(0 0 0 0)',
  height: '1px',
  margin: '-1px',
  overflow: 'hidden',
  padding: 0,
  position: 'absolute',
  whiteSpace: 'nowrap',
  width: '1px',
} as const

export function StatementReviewTable({
  parse,
  onImport,
  isImporting,
}: StatementReviewTableProps) {
  const review = useStatementReviewState(parse)

  const cardLabel = parse.paymentMethod ?? 'Card statement'
  const periodLabel =
    parse.periodClose || parse.periodDue
      ? `${parse.periodClose ? isoToDispDateLike(parse.periodClose) : '—'} → ${
          parse.periodDue ? isoToDispDateLike(parse.periodDue) : '—'
        }`
      : '—'

  const handleImport = () => {
    if (review.includedCount === 0 || isImporting) return
    onImport(review.buildImportRequest())
  }

  return (
    <Box>
      {/* Header strip: detected identity + period + a duplicate advisory. */}
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 2,
          px: 2,
          py: 1.75,
          mb: 2,
          bgcolor: 'var(--mg-paper)',
          border: '1px solid var(--mg-border-2)',
          borderRadius: 2.5,
        }}
      >
        <Box
          aria-hidden
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 40,
            height: 40,
            borderRadius: 2,
            color: 'var(--mg-gold)',
            bgcolor: 'color-mix(in srgb, var(--mg-gold) 14%, transparent)',
            flex: 'none',
          }}
        >
          <CreditCardRoundedIcon fontSize="small" />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontSize: 15, fontWeight: 600, color: 'text.primary' }}>
            {cardLabel}
          </Typography>
          <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
            {parse.statementNumber
              ? `Statement ${parse.statementNumber}`
              : 'Card statement'}
          </Typography>
        </Box>
        <Fact label="Period" value={periodLabel} />
        {parse.totalAmount !== undefined ? (
          <Fact
            label="Statement total"
            value={formatCurrency(parse.totalAmount, 'ARS')}
          />
        ) : null}
      </Box>

      {parse.duplicate ? (
        <Alert
          severity="warning"
          variant="outlined"
          sx={{
            mb: 2,
            borderColor: 'var(--mg-border-2)',
            '& .MuiAlert-message': { fontSize: 13 },
          }}
        >
          Looks like you already imported this statement. You can still import it
          if this is intentional.
        </Alert>
      ) : null}

      {/* The editable line table. */}
      <TableContainer
        sx={{
          border: '1px solid var(--mg-border-2)',
          borderRadius: 2.5,
          maxHeight: { xs: 'none', md: '52vh' },
        }}
      >
        <Table stickyHeader size="small" aria-label="Statement line items">
          <TableHead>
            <TableRow
              sx={{
                '& .MuiTableCell-root': {
                  bgcolor: 'var(--mg-paper)',
                  borderColor: 'var(--mg-border-2)',
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: 'text.secondary',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                },
              }}
            >
              <TableCell>Date</TableCell>
              <TableCell>Merchant</TableCell>
              <TableCell align="right">Amount</TableCell>
              <TableCell>Category</TableCell>
              <TableCell>Cuota</TableCell>
              <TableCell align="right">Include</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {review.lines.map((line) => (
              <LineRow
                key={line.id}
                line={line}
                onToggleKeep={review.toggleKeep}
                onCategoryChange={review.setCategory}
                disabled={isImporting}
              />
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Footer: running total of kept lines + the primary import action. */}
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        sx={{
          mt: 2,
          alignItems: { xs: 'stretch', sm: 'center' },
          justifyContent: 'space-between',
        }}
      >
        <Box aria-live="polite">
          <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
            {review.includedCount} of {review.lines.length}{' '}
            {review.lines.length === 1 ? 'expense' : 'expenses'} selected
          </Typography>
          <Typography
            sx={{
              fontFamily: monoFontFamily,
              fontSize: 18,
              fontWeight: 600,
              color: 'text.primary',
            }}
          >
            {formatCurrency(review.includedTotal, 'ARS')}
          </Typography>
        </Box>
        <Button
          type="button"
          variant="contained"
          color="primary"
          onClick={handleImport}
          disabled={review.includedCount === 0 || isImporting}
          startIcon={
            isImporting ? (
              <CircularProgress size={15} thickness={5} color="inherit" />
            ) : undefined
          }
          sx={{ py: 1.25, px: 3, fontWeight: 600, flex: { xs: 'none', sm: '0 0 auto' } }}
        >
          {isImporting
            ? 'Importing…'
            : `Import ${review.includedCount} ${
                review.includedCount === 1 ? 'expense' : 'expenses'
              }`}
        </Button>
      </Stack>
    </Box>
  )
}
