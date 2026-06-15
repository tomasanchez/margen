/**
 * Statement review table (ADR-080, ADR-086).
 *
 * The primary surface of the CC-statement import flow: after a successful parse
 * it shows the detected card identity + statement period in a header strip, a
 * non-blocking duplicate warning when flagged (ADR-077), and an editable table
 * of the parsed line drafts. Each row shows the date, merchant, amount (+ its
 * currency), an editable category selector, the installment (`cuota`) as a
 * read-only chip when present, and an include/exclude toggle (seeded from the
 * parser's `include`). A persistent footer shows the running total of the kept
 * lines and the primary "Import N · merge M" action.
 *
 * Reconciler (ADR-084/086): a parsed line that likely duplicates an existing
 * manual transaction carries a `match`. Those rows get a non-color "Possible
 * duplicate" treatment — a chip + a subtle background — show the matched
 * transaction inline (`↔ "Sushi dinner" · 30 May · $106.000`), expose a per-row
 * Merge / Keep both resolution (Merge default), and offer an expandable
 * side-by-side compare panel (statement line vs the existing transaction) so the
 * user can judge before confirming. Compare is an inline expandable row rather
 * than a dialog — it keeps the user in the single calm review flow (ADR-037) and
 * avoids a modal focus trap.
 *
 * Accessibility (ADR-019): every status is conveyed beyond hue — the keep/exclude
 * state carries an explicit "Will import" / "Skipped" word + strike-through on
 * skipped rows; the duplicate state carries a "Possible duplicate" chip (not the
 * background tint alone). All controls are keyboard-operable (native Switch /
 * Select / ToggleButtonGroup / disclosure Button) with descriptive labels.
 */

import { useId, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Collapse from '@mui/material/Collapse'
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
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import CreditCardRoundedIcon from '@mui/icons-material/CreditCardRounded'
import CompareArrowsRoundedIcon from '@mui/icons-material/CompareArrowsRounded'
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded'
import KeyboardArrowUpRoundedIcon from '@mui/icons-material/KeyboardArrowUpRounded'
import { CATEGORIES } from '../../mock/seed'
import { formatCurrency, isoToDispDateLike } from './format'
import { monoFontFamily } from '../../theme'
import type { StatementMatch, StatementParse } from '../../api/statementsClient'
import {
  useStatementReviewState,
  type ReviewLine,
  type ReviewResolution,
} from './useStatementReviewState'

/** Expense categories offered in the per-line editor (statements are expenses). */
const STATEMENT_CATEGORIES = CATEGORIES.filter((c) => c !== 'Income')

/** Number of body columns (used for the full-width compare detail row). */
const COLUMN_COUNT = 6

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

/** One field pair in the side-by-side compare panel. */
function CompareField({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <FactLabel>{label}</FactLabel>
      <Typography sx={{ fontSize: 13, color: 'text.primary', wordBreak: 'break-word' }}>
        {value || '—'}
      </Typography>
    </Box>
  )
}

/** One column (statement line OR existing transaction) of the compare panel. */
function CompareColumn({
  heading,
  date,
  name,
  amount,
  category,
  card,
}: {
  heading: string
  date: string
  name: string
  amount: string
  category: string
  card: string
}) {
  return (
    <Box
      sx={{
        flex: 1,
        minWidth: 0,
        p: 1.5,
        borderRadius: 2,
        border: '1px solid var(--mg-border-2)',
        bgcolor: 'var(--mg-paper)',
      }}
    >
      <Typography
        sx={{ fontSize: 12.5, fontWeight: 600, color: 'text.secondary', mb: 1 }}
      >
        {heading}
      </Typography>
      <Stack spacing={1}>
        <CompareField label="Date" value={date} />
        <CompareField label="Name" value={name} />
        <CompareField label="Amount" value={amount} />
        <CompareField label="Category" value={category} />
        <CompareField label="Card" value={card} />
      </Stack>
    </Box>
  )
}

/** The expandable side-by-side compare: statement line vs the matched transaction. */
function CompareDetail({
  line,
  match,
  cardLabel,
}: {
  line: ReviewLine
  match: StatementMatch
  cardLabel: string
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: { xs: 'column', sm: 'row' },
        alignItems: { xs: 'stretch', sm: 'stretch' },
        gap: 1.5,
        px: 2,
        py: 2,
        bgcolor: 'var(--mg-raised)',
      }}
    >
      <CompareColumn
        heading="From this statement"
        date={isoToDispDateLike(line.occurredOn)}
        name={line.name}
        amount={formatCurrency(line.amount, line.currency)}
        category={line.category ?? 'Uncategorized'}
        card={cardLabel}
      />
      <Box
        aria-hidden
        sx={{
          display: { xs: 'none', sm: 'flex' },
          alignItems: 'center',
          justifyContent: 'center',
          color: 'text.disabled',
          flex: 'none',
        }}
      >
        <CompareArrowsRoundedIcon fontSize="small" />
      </Box>
      <CompareColumn
        heading="Already in your transactions"
        date={isoToDispDateLike(match.occurredOn)}
        name={match.name}
        amount={formatCurrency(match.amount, line.currency)}
        category={match.category ?? 'Uncategorized'}
        card={match.paymentMethod ?? '—'}
      />
    </Box>
  )
}

/** The per-flagged-row Merge / Keep both segmented control (ADR-086). */
function ResolutionControl({
  line,
  onChange,
  disabled,
}: {
  line: ReviewLine
  onChange: (id: string, resolution: ReviewResolution) => void
  disabled: boolean
}) {
  return (
    <ToggleButtonGroup
      value={line.resolution}
      exclusive
      size="small"
      disabled={disabled || !line.keep}
      onChange={(_event, next: ReviewResolution | null) => {
        // Exclusive group: ignore a null (deselect) so a choice is always set.
        if (next) onChange(line.id, next)
      }}
      aria-label={`Resolution for ${line.name}`}
      sx={{
        '& .MuiToggleButton-root': {
          textTransform: 'none',
          fontSize: 12,
          fontWeight: 600,
          py: 0.35,
          px: 1.25,
          color: 'text.secondary',
          borderColor: 'var(--mg-border-2)',
          '&.Mui-selected': {
            color: 'primary.main',
            bgcolor: 'color-mix(in srgb, var(--mg-gold) 14%, transparent)',
          },
        },
      }}
    >
      <ToggleButton value="merge" aria-label={`Merge ${line.name} into the existing transaction`}>
        Merge
      </ToggleButton>
      <ToggleButton value="keep_both" aria-label={`Keep both — import ${line.name} as a separate expense`}>
        Keep both
      </ToggleButton>
    </ToggleButtonGroup>
  )
}

/**
 * The line's two dates (ADR-089). Since a CC line is now dated on the statement
 * pay date while the original purchase date is preserved separately, show both:
 * a primary "paid {date}" with a calm secondary "bought {date}" caption. When the
 * purchase date is absent or equal to the pay date (shouldn't normally happen for a
 * CC line, but be safe), collapse to a single plain date.
 */
function LineDates({
  occurredOn,
  purchaseDate,
}: {
  occurredOn: string
  purchaseDate?: string
}) {
  const paidDisp = isoToDispDateLike(occurredOn)
  const showBoth = purchaseDate !== undefined && purchaseDate !== occurredOn

  if (!showBoth) {
    return (
      <Typography
        component="span"
        sx={{ fontFamily: monoFontFamily, fontSize: 12.5, color: 'text.primary' }}
      >
        {paidDisp}
      </Typography>
    )
  }

  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography
        component="span"
        sx={{
          display: 'block',
          fontFamily: monoFontFamily,
          fontSize: 12.5,
          color: 'text.primary',
        }}
      >
        {`paid ${paidDisp}`}
      </Typography>
      <Typography
        component="span"
        sx={{
          display: 'block',
          fontFamily: monoFontFamily,
          fontSize: 11,
          color: 'text.secondary',
        }}
      >
        {`bought ${isoToDispDateLike(purchaseDate)}`}
      </Typography>
    </Box>
  )
}

/** A single editable line row (+ an expandable compare row when flagged). */
function LineRow({
  line,
  onToggleKeep,
  onCategoryChange,
  onResolutionChange,
  cardLabel,
  disabled,
}: {
  line: ReviewLine
  onToggleKeep: (id: string, keep: boolean) => void
  onCategoryChange: (id: string, category: string) => void
  onResolutionChange: (id: string, resolution: ReviewResolution) => void
  cardLabel: string
  disabled: boolean
}) {
  const selectLabelId = useId()
  const compareRegionId = useId()
  const [compareOpen, setCompareOpen] = useState(false)
  const kept = line.keep
  const match = line.match
  const isDuplicate = match !== undefined
  // Non-color status: an explicit word + strike-through on skipped rows so the
  // keep/exclude state never depends on the dimmed hue alone (ADR-019).
  const statusWord = kept ? 'Will import' : 'Skipped'
  // A subtle background tints flagged rows, but the chip below is the real cue.
  const rowBg = isDuplicate
    ? 'color-mix(in srgb, var(--mg-gold) 6%, transparent)'
    : undefined

  return (
    <>
      <TableRow
        sx={{
          opacity: kept ? 1 : 0.55,
          bgcolor: rowBg,
          '& .MuiTableCell-root': {
            borderColor: 'var(--mg-border-2)',
            ...(isDuplicate ? { borderBottom: 'none' } : {}),
          },
        }}
      >
        <TableCell sx={{ whiteSpace: 'nowrap' }}>
          <LineDates
            occurredOn={line.occurredOn}
            purchaseDate={line.purchaseDate}
          />
        </TableCell>
        <TableCell sx={{ minWidth: 200 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Typography
              sx={{
                fontSize: 13.5,
                color: 'text.primary',
                textDecoration: kept ? 'none' : 'line-through',
              }}
            >
              {line.name}
            </Typography>
            {isDuplicate ? (
              <Chip
                label="Possible duplicate"
                size="small"
                sx={{
                  height: 20,
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--mg-gold)',
                  bgcolor: 'color-mix(in srgb, var(--mg-gold) 16%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--mg-gold) 32%, transparent)',
                }}
              />
            ) : null}
          </Box>
          {line.lineKind === 'fee' ? (
            <Typography sx={{ fontSize: 11.5, color: 'text.disabled' }}>
              Fee / charge
            </Typography>
          ) : null}
          {match ? (
            <Box sx={{ mt: 0.5 }}>
              <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>
                {`↔ "${match.name}" · ${isoToDispDateLike(match.occurredOn)} · ${formatCurrency(
                  match.amount,
                  line.currency,
                )}`}
              </Typography>
              <Stack
                direction="row"
                spacing={1.5}
                useFlexGap
                sx={{ mt: 0.5, alignItems: 'center', flexWrap: 'wrap' }}
              >
                <ResolutionControl
                  line={line}
                  onChange={onResolutionChange}
                  disabled={disabled}
                />
                <Button
                  type="button"
                  size="small"
                  variant="text"
                  onClick={() => setCompareOpen((open) => !open)}
                  aria-expanded={compareOpen}
                  aria-controls={compareRegionId}
                  endIcon={
                    compareOpen ? (
                      <KeyboardArrowUpRoundedIcon fontSize="small" />
                    ) : (
                      <KeyboardArrowDownRoundedIcon fontSize="small" />
                    )
                  }
                  sx={{
                    textTransform: 'none',
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'text.secondary',
                    px: 0.5,
                  }}
                >
                  {compareOpen ? 'Hide compare' : 'Compare'}
                </Button>
              </Stack>
            </Box>
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
      {match ? (
        <TableRow sx={{ bgcolor: rowBg }}>
          <TableCell
            colSpan={COLUMN_COUNT}
            sx={{ p: 0, borderColor: 'var(--mg-border-2)' }}
          >
            <Collapse
              in={compareOpen}
              timeout="auto"
              unmountOnExit
              id={compareRegionId}
            >
              <CompareDetail line={line} match={match} cardLabel={cardLabel} />
            </Collapse>
          </TableCell>
        </TableRow>
      ) : null}
    </>
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

  // The footer summary + primary CTA split the kept lines into new vs merged.
  const { newCount, mergeCount } = review
  const summaryText = `${newCount} new · ${mergeCount} merged`
  const ctaText = isImporting
    ? 'Importing…'
    : mergeCount > 0
      ? `Import ${newCount} · merge ${mergeCount}`
      : `Import ${newCount} ${newCount === 1 ? 'expense' : 'expenses'}`

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

      {/* A calm note explaining the two-date model (ADR-089/037). */}
      <Typography
        sx={{ mb: 1, fontSize: 12, color: 'text.secondary' }}
      >
        Lines are dated when the card is paid; the original purchase date is shown per row.
      </Typography>

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
                onResolutionChange={review.setResolution}
                cardLabel={cardLabel}
                disabled={isImporting}
              />
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Footer: split counts (new vs merged) + the primary import action. */}
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
            {summaryText}
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
          {ctaText}
        </Button>
      </Stack>
    </Box>
  )
}
