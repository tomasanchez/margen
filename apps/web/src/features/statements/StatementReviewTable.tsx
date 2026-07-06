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

import { useCallback, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import FormControl from '@mui/material/FormControl'
import InputLabel from '@mui/material/InputLabel'
import CreditCardRoundedIcon from '@mui/icons-material/CreditCardRounded'
import CompareArrowsRoundedIcon from '@mui/icons-material/CompareArrowsRounded'
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded'
import KeyboardArrowUpRoundedIcon from '@mui/icons-material/KeyboardArrowUpRounded'
import { CATEGORIES } from '../../mock/seed'
import { formatCurrency, isoToDispDateLike } from './format'
import { categoryLabel } from '../transactions/presentation'
import { monoFontFamily } from '../../theme'
import {
  useAccounts,
  useCreateAccount,
  useCreateInstitution,
  useInstitutions,
  useNetWorth,
} from '../accounts/queries'
import { buildNetWorthBalanceIndex } from '../accounts/grouping'
import type { Account, Currency } from '../../mock/types'
import type { StatementMatch, StatementParse } from '../../api/statementsClient'
import {
  parseCuota,
  useStatementReviewState,
  type CurrencyAccountChoice,
  type ReviewLine,
  type ReviewResolution,
} from './useStatementReviewState'
import {
  computePaymentPlan,
  pendingDueDate,
  type FundingAccount,
} from './paymentPlan'
import { PaymentPlanPanel } from './PaymentPlanPanel'
import { RegisterCardForm, type RegisterCardSubmit } from './RegisterCardForm'

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
  const { t } = useTranslation('statements')
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
        <CompareField label={t('review.compare.date')} value={date} />
        <CompareField label={t('review.compare.name')} value={name} />
        <CompareField label={t('review.compare.amount')} value={amount} />
        <CompareField label={t('review.compare.category')} value={category} />
        <CompareField label={t('review.compare.card')} value={card} />
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
  const { t } = useTranslation('statements')
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
        heading={t('review.compare.fromStatement')}
        date={isoToDispDateLike(line.occurredOn)}
        name={line.name}
        amount={formatCurrency(line.amount, line.currency)}
        category={line.category ?? t('review.line.uncategorized')}
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
        heading={t('review.compare.alreadyInTransactions')}
        date={isoToDispDateLike(match.occurredOn)}
        name={match.name}
        amount={formatCurrency(match.amount, line.currency)}
        category={match.category ?? t('review.line.uncategorized')}
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
  const { t } = useTranslation('statements')
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
      aria-label={t('review.line.resolutionAriaLabel', { name: line.name })}
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
      <ToggleButton
        value="merge"
        aria-label={t('review.line.mergeAriaLabel', { name: line.name })}
      >
        {t('review.line.merge')}
      </ToggleButton>
      <ToggleButton
        value="keep_both"
        aria-label={t('review.line.keepBothAriaLabel', { name: line.name })}
      >
        {t('review.line.keepBoth')}
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
  const { t } = useTranslation('statements')
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
        {t('review.line.paid', { date: paidDisp })}
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
        {t('review.line.bought', { date: isoToDispDateLike(purchaseDate) })}
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
  onCuotaChange,
  cardLabel,
  disabled,
}: {
  line: ReviewLine
  onToggleKeep: (id: string, keep: boolean) => void
  onCategoryChange: (id: string, category: string) => void
  onResolutionChange: (id: string, resolution: ReviewResolution) => void
  onCuotaChange: (id: string, index: number | null, total: number | null) => void
  cardLabel: string
  disabled: boolean
}) {
  const { t } = useTranslation('statements')
  const selectLabelId = useId()
  const compareRegionId = useId()
  const [compareOpen, setCompareOpen] = useState(false)
  const kept = line.keep
  const match = line.match
  const isDuplicate = match !== undefined
  // The detected installment marker (ADR-175), parsed into editable index/total.
  // Editing either recomposes the `cuota` string, which the backend re-parses into
  // structured installment fields on import. A parse of a `null`/blank/malformed
  // marker yields empty fields.
  const cuota = parseCuota(line.cuota)
  const emitCuota = (index: number | null, total: number | null) =>
    onCuotaChange(line.id, index, total)
  const toIntOrNull = (raw: string): number | null => {
    const trimmed = raw.trim()
    if (!/^\d+$/.test(trimmed)) return null
    const value = Number.parseInt(trimmed, 10)
    return Number.isFinite(value) && value > 0 ? value : null
  }
  // Non-color status: an explicit word + strike-through on skipped rows so the
  // keep/exclude state never depends on the dimmed hue alone (ADR-019).
  const statusWord = kept
    ? t('review.line.willImport')
    : t('review.line.skipped')
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
                label={t('review.line.possibleDuplicate')}
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
              {t('review.line.fee')}
            </Typography>
          ) : null}
          {match ? (
            <Box sx={{ mt: 0.5 }}>
              <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>
                {t('review.line.matchContext', {
                  name: match.name,
                  date: isoToDispDateLike(match.occurredOn),
                  amount: formatCurrency(match.amount, line.currency),
                })}
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
                  {compareOpen
                    ? t('review.line.hideCompare')
                    : t('review.line.compare')}
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
            {t('review.line.categoryFor', { name: line.name })}
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
              <em>{t('review.line.uncategorized')}</em>
            </MenuItem>
            {STATEMENT_CATEGORIES.map((category) => (
              <MenuItem key={category} value={category}>
                {categoryLabel(category)}
              </MenuItem>
            ))}
          </Select>
        </TableCell>
        {/* Installment (cuota) editor (ADR-175): the parser detects "Cuota N/M";
            surface it as an editable index/total pair so the user confirms/corrects
            it before import. The recomposed "N/M" string flows through the import
            request, where the backend re-parses it into structured installment
            fields and stamps recurring_cadence='installment' (ADR-175/176). Fields
            are disabled when the line is skipped. */}
        <TableCell sx={{ minWidth: 130 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <TextField
              value={cuota.index ?? ''}
              onChange={(e) => emitCuota(toIntOrNull(e.target.value), cuota.total)}
              size="small"
              disabled={disabled || !kept}
              placeholder={t('review.line.cuotaIndexPlaceholder')}
              slotProps={{
                htmlInput: {
                  inputMode: 'numeric',
                  'aria-label': t('review.line.cuotaIndexAriaLabel', {
                    name: line.name,
                  }),
                  style: { textAlign: 'center', padding: '4px 2px', width: 34 },
                },
              }}
              sx={{ '& .MuiInputBase-input': { fontFamily: monoFontFamily, fontSize: 12 } }}
            />
            <Typography
              aria-hidden
              component="span"
              sx={{ fontSize: 12, color: 'text.disabled' }}
            >
              /
            </Typography>
            <TextField
              value={cuota.total ?? ''}
              onChange={(e) => emitCuota(cuota.index, toIntOrNull(e.target.value))}
              size="small"
              disabled={disabled || !kept}
              placeholder={t('review.line.cuotaTotalPlaceholder')}
              slotProps={{
                htmlInput: {
                  inputMode: 'numeric',
                  'aria-label': t('review.line.cuotaTotalAriaLabel', {
                    name: line.name,
                  }),
                  style: { textAlign: 'center', padding: '4px 2px', width: 34 },
                },
              }}
              sx={{ '& .MuiInputBase-input': { fontFamily: monoFontFamily, fontSize: 12 } }}
            />
          </Box>
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
                    ? t('review.line.skipAriaLabel', { name: line.name })
                    : t('review.line.importAriaLabel', { name: line.name }),
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

/** A short "Institution · CUR" label for a card-account option. */
function accountOptionLabel(account: Account): string {
  return `${account.institutionName} · ${account.currency}`
}

/**
 * The per-currency card-account attachment control (ADR-184). A statement is
 * from ONE card and Argentine cards carry separate ARS + USD balances, so the
 * attachment is confirmed ONCE per line-currency present in the statement — a
 * calm confirm-the-match affordance, not a noisy per-row selector. Each currency
 * present gets a labeled Select pre-selected to its auto-matched card account
 * (ADR-184); the user can confirm, switch to another card account of the SAME
 * currency, or choose "Don't attach" (import that currency's lines unattached).
 * Only card accounts whose currency equals the section currency are offered.
 */
function AccountAttachSection({
  choices,
  accounts,
  onChange,
  onRegister,
  canRegister,
  disabled,
}: {
  choices: readonly CurrencyAccountChoice[]
  accounts: readonly Account[]
  onChange: (currency: CurrencyAccountChoice['currency'], accountId: string | null) => void
  /** Open the prefilled register-card wizard (ADR-190). */
  onRegister: () => void
  /** Whether a register-card action is offered (the parse carries a card identity). */
  canRegister: boolean
  disabled: boolean
}) {
  const { t } = useTranslation('statements')
  if (choices.length === 0) return null
  return (
    <Box
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'flex-start',
        gap: 2,
        px: 2,
        py: 1.75,
        mb: 2,
        bgcolor: 'var(--mg-paper)',
        border: '1px solid var(--mg-border-2)',
        borderRadius: 2.5,
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography sx={{ fontSize: 13.5, fontWeight: 600, color: 'text.primary' }}>
          {t('review.account.title')}
        </Typography>
        <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.25 }}>
          {t('review.account.subtitle')}
        </Typography>
      </Box>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1.5}
        sx={{ flexWrap: 'wrap', alignItems: 'flex-start' }}
        useFlexGap
      >
        {choices.map((choice) => {
          // Only card accounts of the SAME currency are eligible options (ADR-184).
          const options = accounts.filter(
            (a) => a.type === 'card' && a.currency === choice.currency,
          )
          const value = choice.selectedAccountId ?? ''
          const noMatch = choice.matched === null && options.length === 0
          return (
            <CurrencyAccountSelect
              key={choice.currency}
              currency={choice.currency}
              value={value}
              options={options}
              noMatch={noMatch}
              canRegister={canRegister}
              onRegister={onRegister}
              disabled={disabled}
              onChange={(id) => onChange(choice.currency, id === '' ? null : id)}
            />
          )
        })}
      </Stack>
    </Box>
  )
}

/** One labeled currency section's card-account Select (ADR-184). */
function CurrencyAccountSelect({
  currency,
  value,
  options,
  noMatch,
  canRegister,
  onRegister,
  disabled,
  onChange,
}: {
  currency: CurrencyAccountChoice['currency']
  value: string
  options: readonly Account[]
  noMatch: boolean
  /** Whether the register-card action is offered (parse carries a card identity). */
  canRegister: boolean
  /** Open the prefilled register-card wizard (ADR-190). */
  onRegister: () => void
  disabled: boolean
  onChange: (accountId: string) => void
}) {
  const { t } = useTranslation('statements')
  const labelId = useId()
  const label = t('review.account.currencyLabel', { currency })
  // No card account of this currency exists — the lines import unattached; show a
  // calm caption instead of an empty picker so the state is clear (ADR-184/037).
  // When the parse carries a card identity, also offer a "Register this card"
  // action that opens the prefilled registration wizard (ADR-190).
  if (noMatch) {
    return (
      <Box sx={{ minWidth: 200 }}>
        <FactLabel>{label}</FactLabel>
        <Typography sx={{ fontSize: 13, color: 'text.secondary' }} role="note">
          {t('review.account.noMatch', { currency })}
        </Typography>
        {canRegister ? (
          <Button
            type="button"
            size="small"
            variant="text"
            onClick={onRegister}
            disabled={disabled}
            sx={{
              mt: 0.25,
              px: 0,
              fontSize: 12.5,
              fontWeight: 600,
              textTransform: 'none',
            }}
          >
            {t('review.account.register')}
          </Button>
        ) : null}
      </Box>
    )
  }
  return (
    <FormControl size="small" sx={{ minWidth: 220 }} disabled={disabled}>
      <InputLabel id={labelId}>{label}</InputLabel>
      <Select
        labelId={labelId}
        label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        sx={{ borderRadius: '10px', bgcolor: 'var(--mg-paper)', fontSize: 13 }}
      >
        {options.map((account) => (
          <MenuItem key={account.id} value={account.id}>
            {accountOptionLabel(account)}
          </MenuItem>
        ))}
        <MenuItem value="">
          <em>{t('review.account.dontAttach')}</em>
        </MenuItem>
      </Select>
    </FormControl>
  )
}

export function StatementReviewTable({
  parse,
  onImport,
  isImporting,
}: StatementReviewTableProps) {
  const { t } = useTranslation('statements')
  // The user's accounts + institutions drive the card match (ADR-184/190): the
  // institution is resolved by (brand + last4) when present, else by name, then
  // its per-currency card accounts seed the attachment defaults. While loading,
  // the lists are empty and no defaults are seeded; the selection re-seeds to the
  // auto-match once they resolve.
  const accountsQuery = useAccounts()
  const institutionsQuery = useInstitutions()
  const netWorthQuery = useNetWorth()
  const accounts = useMemo(
    () => accountsQuery.data ?? [],
    [accountsQuery.data],
  )
  const institutions = useMemo(
    () => institutionsQuery.data ?? [],
    [institutionsQuery.data],
  )
  const review = useStatementReviewState(parse, accounts, institutions)

  // AVAILABLE per currency uses each account's as-of-today NATIVE balance (opening
  // + transaction deltas, ADR-186) from the net-worth read model, falling back to
  // the account's opening balance when the read hasn't resolved yet (ADR-188).
  const balanceIndex = useMemo(
    () => buildNetWorthBalanceIndex(netWorthQuery.data?.accounts ?? []),
    [netWorthQuery.data?.accounts],
  )
  // The user's NON-card funding accounts (bank / cash / wallet) with native
  // balances — the AVAILABLE pool + the greedy transfer sources (ADR-188/189).
  const fundingAccounts = useMemo<FundingAccount[]>(
    () =>
      accounts
        .filter((account) => account.type !== 'card')
        .map((account) => {
          const fromNetWorth = balanceIndex.get(account.id)
          const opening = Number.parseFloat(account.openingBalance)
          const balance =
            fromNetWorth != null
              ? fromNetWorth
              : Number.isFinite(opening)
                ? opening
                : 0
          return {
            id: account.id,
            institutionName: account.institutionName,
            type: account.type,
            currency: account.currency,
            balance,
          }
        }),
    [accounts, balanceIndex],
  )

  // The per-currency main / pay-from account selection (ADR-189). Absent entries
  // fall back to the largest-balance default inside computePaymentPlan.
  const [mainByCurrency, setMainByCurrency] = useState<
    Partial<Record<Currency, string>>
  >({})
  const setMainAccount = useCallback((currency: Currency, accountId: string) => {
    setMainByCurrency((current) => ({ ...current, [currency]: accountId }))
  }, [])

  // The kept lines drive NEED; recomputed live as the user toggles keep/exclude or
  // changes a main account (ADR-188). Native amounts only — never cross-summed.
  const paymentPlan = useMemo(
    () =>
      computePaymentPlan(
        review.lines
          .filter((line) => line.keep)
          .map((line) => ({
            currency: line.currency,
            amount: line.amount,
            ...(line.usdAmount !== undefined ? { usdAmount: line.usdAmount } : {}),
          })),
        fundingAccounts,
        mainByCurrency,
      ),
    [review.lines, fundingAccounts, mainByCurrency],
  )
  const pendingDue = useMemo(
    () => pendingDueDate(parse.periodDue, parse.periodClose),
    [parse.periodDue, parse.periodClose],
  )

  // In-flow card registration (ADR-190): opened from the "Register this card"
  // action when a currency has no matching card account. Prefilled from the parse;
  // creates the institution (type=card, brand+last4) then its per-currency accounts.
  const [registerOpen, setRegisterOpen] = useState(false)
  const createInstitution = useCreateInstitution()
  const createAccount = useCreateAccount()
  const [registerError, setRegisterError] = useState(false)
  const registerSaving = createInstitution.isPending || createAccount.isPending
  // The currencies the statement carries — queued as the new card's accounts.
  const statementCurrencies = useMemo<Currency[]>(() => {
    const seen = new Set<Currency>()
    for (const line of parse.lines) seen.add(line.currency)
    return (['ARS', 'USD'] as const).filter((c) => seen.has(c))
  }, [parse.lines])
  // The register action is offered only when the parse carries a card identity.
  const canRegisterCard =
    Boolean(parse.bankName) || Boolean(parse.cardLast4) || Boolean(parse.network)

  const openRegister = () => {
    createInstitution.reset()
    createAccount.reset()
    setRegisterError(false)
    setRegisterOpen(true)
  }
  const closeRegister = () => setRegisterOpen(false)

  const handleRegisterSubmit = async (submit: RegisterCardSubmit) => {
    setRegisterError(false)
    try {
      const created = await createInstitution.mutateAsync(submit.institution)
      for (const account of submit.accounts) {
        await createAccount.mutateAsync({
          institutionId: created.id,
          currency: account.currency,
          openingBalance: account.openingBalance,
        })
      }
      // The accounts/institutions queries are invalidated by the mutations, so the
      // auto-match re-runs and finds the new card by (brand + last4, currency).
      setRegisterOpen(false)
    } catch {
      setRegisterError(true)
    }
  }

  // The detected card identity as "Galicia · VISA ·5771" — the normalized bank
  // joined with the card detail (ADR-117). Falls back gracefully when a part is
  // missing, and to a calm generic label when neither was parsed.
  const cardLabel =
    [parse.bankName, parse.card].filter(Boolean).join(' · ') ||
    t('review.cardFallback')
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
  const summaryText = t('review.summary', { newCount, mergeCount })
  const ctaText = isImporting
    ? t('review.cta.importing')
    : mergeCount > 0
      ? t('review.cta.importMerge', { newCount, mergeCount })
      : t('review.cta.import', { count: newCount })

  return (
    <Box sx={{ width: '100%', minWidth: 0 }}>
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
              ? t('review.statementNumber', { number: parse.statementNumber })
              : t('review.cardFallback')}
          </Typography>
        </Box>
        <Fact label={t('review.period')} value={periodLabel} />
        {parse.totalAmount !== undefined ? (
          <Fact
            label={t('review.statementTotal')}
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
          {t('review.duplicate')}
        </Alert>
      ) : null}

      {/* Per-currency card-payment plan (ADR-188/189): NEED vs AVAILABLE in native
          units + a Sufficient badge or a concrete greedy transfer list. Sits
          between the header strip and the account-attach section; recomputes live
          as lines toggle or the main account changes. Suggest-only (no execute). */}
      <PaymentPlanPanel
        plan={paymentPlan}
        fundingAccounts={fundingAccounts}
        pendingDue={pendingDue}
        disabled={isImporting}
        onMainChange={setMainAccount}
      />

      {/* Per-currency card-account attachment (ADR-184): confirm the auto-matched
          (institution, currency) card account for this statement's lines. When a
          currency has no matching card account, a "Register this card" action opens
          the prefilled registration wizard (ADR-190). */}
      <AccountAttachSection
        choices={review.accountChoices}
        accounts={accounts}
        onChange={review.setAccountForCurrency}
        onRegister={openRegister}
        canRegister={canRegisterCard}
        disabled={isImporting}
      />

      {/* A calm note explaining the two-date model (ADR-089/037). */}
      <Typography
        sx={{ mb: 1, fontSize: 12, color: 'text.secondary' }}
      >
        {t('review.dateNote')}
      </Typography>

      {/* The editable line table. */}
      <TableContainer
        sx={{
          width: '100%',
          // The review table is intrinsically wider than a phone viewport (it has
          // min-width cells). Keep the wide content scrolling INSIDE this bordered
          // container so the page body never scrolls horizontally (ADR-017; the
          // numeric-sx percentage gotcha is fixed separately on the page section).
          overflowX: 'auto',
          border: '1px solid var(--mg-border-2)',
          borderRadius: 2.5,
          maxHeight: { xs: 'none', md: '52vh' },
        }}
      >
        <Table
          stickyHeader
          size="small"
          aria-label={t('review.tableAriaLabel')}
        >
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
              <TableCell>{t('review.columns.date')}</TableCell>
              <TableCell>{t('review.columns.merchant')}</TableCell>
              <TableCell align="right">{t('review.columns.amount')}</TableCell>
              <TableCell>{t('review.columns.category')}</TableCell>
              <TableCell>{t('review.columns.cuota')}</TableCell>
              <TableCell align="right">{t('review.columns.include')}</TableCell>
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
                onCuotaChange={review.setCuota}
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

      {/* In-flow card registration (ADR-190): prefilled from the parse; keyed on
          open so its seeded state starts fresh each time. */}
      {registerOpen ? (
        <RegisterCardForm
          open
          bankName={parse.bankName}
          network={parse.network}
          cardLast4={parse.cardLast4}
          currencies={statementCurrencies}
          isSaving={registerSaving}
          saveError={registerError}
          onSubmit={(submit) => {
            void handleRegisterSubmit(submit)
          }}
          onClose={closeRegister}
        />
      ) : null}
    </Box>
  )
}
