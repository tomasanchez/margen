/**
 * Shared Add/Edit transaction form (ADR-017, ADR-019).
 *
 * One form, rendered inside either a Dialog (desktop) or a bottom Drawer
 * (mobile) by {@link AddEditTransaction}. It ports the concept's Add modal
 * (Margen Home.dc.html) to MUI: segmented Expense / Invoice·income tabs, a large
 * IBM Plex Mono amount input with a currency-symbol prefix, an ARS/USD toggle
 * with an editable MEP FX context line, category chips, an account selector, a native date
 * picker (default today, max today; backdating allowed — ADR-041), an optional
 * "More details" section, and Cancel / Save.
 *
 * Color comes from the design tokens via the theme; layout uses MUI sx. All
 * controls are keyboard-operable and labelled (ADR-019); focus trapping and
 * restoration are handled by the surrounding Dialog/Drawer.
 */

import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Collapse from '@mui/material/Collapse'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import InputBase from '@mui/material/InputBase'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import DescriptionRoundedIcon from '@mui/icons-material/DescriptionRounded'
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded'
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded'
import UploadFileIcon from '@mui/icons-material/UploadFile'
import type {
  Currency,
  NewTransactionInput,
  TxType,
} from '../../mock/types'
import { formatARS, fxSourceLabel } from '../../lib/format'
import { monoFontFamily } from '../../theme'
import {
  InvoicesApiError,
  parseInvoice,
} from '../../api/invoicesClient'
import { useMonotributoSnapshot } from '../monotributo/queries'
import { useAccounts } from '../accounts/queries'
import type { AddPrefill } from './addContext'
import { accountOptionLabel, categoryLabel } from './presentation'
import {
  EXPENSE_CATEGORIES,
  useAddEditFormState,
} from './useAddEditFormState'
import type { FxSource } from './useAddEditFormState'

/** Uppercase eyebrow heading shared by the form sections (token-driven). */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <Typography variant="overline" component="p" sx={{ mb: 1.25 }}>
      {children}
    </Typography>
  )
}

/** Gold-tinted selectable chip used for the category picker. */
function SelectChip({
  label,
  selected,
  onClick,
}: {
  label: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <Chip
      label={label}
      onClick={onClick}
      variant="outlined"
      aria-pressed={selected}
      sx={{
        borderRadius: 999,
        fontWeight: selected ? 600 : 500,
        fontSize: 13,
        color: selected ? 'text.primary' : 'text.secondary',
        borderColor: selected ? 'primary.main' : 'var(--mg-border-2)',
        bgcolor: selected
          ? 'color-mix(in srgb, var(--mg-gold) 14%, transparent)'
          : 'transparent',
        '&:hover': { bgcolor: 'action.hover' },
      }}
    />
  )
}

export interface AddEditFormProps {
  /** Prefill the form was opened with (add-shortcut intent or an Edit patch). */
  prefill: AddPrefill | null
  /** Save handler; receives the assembled input + the edit id when editing. */
  onSubmit: (input: NewTransactionInput, editId: string | undefined) => void
  /** Whether a save mutation is in flight (disables the form / shows progress). */
  isSaving: boolean
  /** Cancel / dismiss the form. */
  onCancel: () => void
  /** id of the form's heading, wired to the container's aria-labelledby. */
  titleId: string
}

/**
 * The form body. Rendered inside a Dialog or Drawer; it owns no surface chrome
 * beyond its own controls so it can drop into either presenter unchanged.
 */
export function AddEditForm({
  prefill,
  onSubmit,
  isSaving,
  onCancel,
  titleId,
}: AddEditFormProps) {
  const { t } = useTranslation('transactions')
  // The "Import statement" affordance reuses the shell namespace's existing label
  // (it mirrors the desktop sidebar button); the rest of the form is `transactions`.
  const { t: tShell } = useTranslation('shell')
  const navigate = useNavigate()
  const genericParseError = t('form.upload.parseError')
  const form = useAddEditFormState(prefill)
  const [moreOpen, setMoreOpen] = useState(false)

  // Mobile-reachable entry to the routed statement-import flow (ADR-017): the
  // sidebar button is desktop-only, so surface the SAME destination here in the
  // Add flow (present on every viewport). Navigate, then close this dialog/sheet.
  const handleImportStatement = () => {
    void navigate({ to: '/import-statement' })
    onCancel()
  }

  // Monotributo cuota shortcut (expense path only): load the user's monthly tax
  // as a plain ARS expense, autofilled from their configured category. The cuota
  // is the scale row matching the current category, taking the services or goods
  // fee per the configured activity type. We read the snapshot non-blockingly —
  // while it's pending or absent the button stays calmly disabled (no crash).
  const monotributoQuery = useMonotributoSnapshot()
  const standing = monotributoQuery.data?.current
  const cuotaRow = standing
    ? monotributoQuery.data?.scale.find((row) => row.letter === standing.category)
    : undefined
  const monotributoCuota = cuotaRow
    ? standing?.activityType === 'services'
      ? cuotaRow.cuotaServicios
      : cuotaRow.cuotaBienes
    : undefined

  // In-form ARCA invoice upload (ADR-072): a calm parsing flag + an inline,
  // non-blocking failure message. On success the parse autofills the fields; the
  // user reviews and decides whether to save. On failure they keep going
  // manually. The hidden picker is reset after each pick so re-picking the same
  // file fires `change` again.
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isParsing, setIsParsing] = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)

  const handlePickFile = () => {
    if (isParsing) return
    fileInputRef.current?.click()
  }

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    // Clear any prior calm error on a new pick.
    setParseError(null)
    setIsParsing(true)
    void parseInvoice(file)
      .then((parsed) => {
        if (parsed.status === 'unparseable') {
          // A valid-but-unreadable PDF: calm inline message, stay in the form.
          setParseError(genericParseError)
          return
        }
        // Carry the picked file's name so the attached-file row can show it.
        form.applyParsedInvoice(parsed, file.name)
      })
      .catch((error: unknown) => {
        // 415 / 413 / 422 (or any failure) → calm inline message; keep editing.
        setParseError(
          error instanceof InvoicesApiError ? error.message : genericParseError,
        )
      })
      .finally(() => setIsParsing(false))
  }

  // Unattach the uploaded invoice (issue #26): drop the stashed PDF + its name +
  // the duplicate advisory (the hook keeps the autofilled values), and clear the
  // inline parse error. The upload control reappears so a different file can be
  // picked, and saving now creates the row WITHOUT a document.
  const handleRemoveAttachment = () => {
    form.clearImportedDocument()
    setParseError(null)
  }

  // Reset all fields to the blank new-entry defaults + clear the attachment and
  // parse error (issue #26). Resets state in place — it does not close the form.
  const handleResetAll = () => {
    form.resetForm()
    setParseError(null)
    setMoreOpen(false)
  }

  // The user's accounts feed the account selector (ADR-122). Read
  // non-blockingly: while pending or absent the selector shows only the "no
  // account" option, so the form never waits on the accounts load.
  const accountsQuery = useAccounts()
  const accounts = accountsQuery.data ?? []
  // Only offer accounts whose currency matches the transaction's currency: an
  // account holds one currency (ADR-122/123), so a USD txn must not be linkable
  // to an ARS account, and vice-versa. The "no account" option is always shown.
  // A currency switch that strands the current selection is cleared in
  // `handleCurrencyChange` (effect-free), so the selected value always stays
  // within this filtered list.
  const accountOptions = accounts.filter(
    (account) => account.currency === form.currency,
  )

  const nameInputId = useId()
  const amountInputId = useId()
  const rateInputId = useId()
  const dateInputId = useId()
  const notesInputId = useId()
  const accountSelectId = useId()

  const isExpense = form.type === 'expense'
  const isUsd = form.currency === 'USD'
  const currencySymbol = isUsd ? 'USD' : 'ARS'

  const title =
    form.mode === 'edit'
      ? t('form.title.edit')
      : isExpense
        ? t('form.title.newExpense')
        : t('form.title.newInvoice')

  const handleTypeChange = (_: unknown, next: TxType | null) => {
    if (next) form.setType(next)
  }
  // Switching the form currency must keep the Account selection consistent: an
  // account holds exactly ONE currency (ADR-122/123), so a USD transaction can't
  // be attributed to an ARS account and vice-versa. When the new currency no
  // longer matches the currently-selected account's currency, clear the account
  // back to "none" (effect-free: done here in the change path, where both the
  // accounts list and the setters are in scope — not a useEffect that would
  // fight the controlled state, see useAddEditFormState's deliberate no-effect
  // seeding). On edit the seeded account already matches the row's currency
  // (ADR-136), so this never fires on the initial seed — only on a user switch.
  const handleCurrencyChange = (_: unknown, next: Currency | null) => {
    if (!next) return
    const selected = accounts.find((account) => account.id === form.accountId)
    if (selected && selected.currency !== next) form.setAccountId('')
    form.setCurrency(next)
  }

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.canSave || isSaving) return
    onSubmit(form.buildInput(), form.editId)
  }

  const handleFxSourceChange = (_: unknown, next: FxSource | null) => {
    if (next) form.setFxSource(next)
  }

  // Load the monthly Monotributo cuota into the expense fields (ARS, Taxes,
  // "Monotributo <category>"). Guarded by the disabled state below, but re-check
  // the figures so a late/absent snapshot never autofills garbage.
  const handleLoadMonotributoCuota = () => {
    if (
      typeof monotributoCuota !== 'number' ||
      monotributoCuota <= 0 ||
      !standing
    ) {
      return
    }
    form.applyMonotributoCuota(monotributoCuota, `Monotributo ${standing.category}`)
  }

  // FX context line: converted ARS value + rate source + rate value. The source
  // label (MEP / official / manual) is shown so the user always knows "which
  // dollar".
  const sourceLabel = fxSourceLabel(form.fxRateType)
  const fxConvertedLabel = form.usdRateMissing
    ? t('form.fx.convertedMissing')
    : Number.isFinite(form.amountArs)
      ? t('form.fx.converted', {
          amount: formatARS(form.amountArs),
          source: sourceLabel,
          rate: formatARS(form.rate),
        })
      : t('form.fx.convertedNoAmount', {
          source: sourceLabel,
          rate: formatARS(form.rate),
        })

  // Suggestion hint under the rate field (ADR-045): loading / suggested / failed.
  const isFetchingRate = form.rateSuggestionStatus === 'loading'
  const rateFetchFailed = form.rateSuggestionStatus === 'failed'
  const rateHelperText = form.usdRateMissing
    ? rateFetchFailed
      ? t('form.fx.helperFetchFailed')
      : t('form.fx.helperRequired')
    : form.fxSource === 'manual'
      ? t('form.fx.helperManual')
      : form.fxSource === 'official'
        ? t('form.fx.helperOfficial')
        : t('form.fx.helperMep')

  // Compact label for each non-manual source option, showing its suggested value
  // (e.g. "MEP 1.245"). The currently-selected source falls back to the live
  // rate when no suggestion was fetched (e.g. editing a stored MEP/official row),
  // so its option stays enabled and labelled. A source with neither a fetched
  // suggestion nor the active selection is disabled (greyed) with a dash.
  const optionValue = (source: 'MEP' | 'official'): number | null => {
    const suggested = form.suggestedRates[source]
    if (suggested !== null) return suggested
    if (form.fxSource === source && Number.isFinite(form.rate)) return form.rate
    return null
  }
  const mepValue = optionValue('MEP')
  const officialValue = optionValue('official')
  const mepOptionLabel =
    mepValue !== null
      ? t('form.fx.mepOption', { rate: formatARS(mepValue) })
      : t('form.fx.mepOptionEmpty')
  const officialOptionLabel =
    officialValue !== null
      ? t('form.fx.officialOption', { rate: formatARS(officialValue) })
      : t('form.fx.officialOptionEmpty')

  return (
    <Box component="form" onSubmit={handleSubmit} noValidate>
      {/* Header: title + close. */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          mb: 2.5,
        }}
      >
        <Typography
          id={titleId}
          variant="h6"
          component="h2"
          sx={{ fontSize: 18 }}
        >
          {title}
        </Typography>
        <IconButton
          onClick={onCancel}
          aria-label={t('form.close')}
          size="small"
          sx={{
            border: '1px solid var(--mg-border-2)',
            borderRadius: 2,
            color: 'text.secondary',
          }}
        >
          <CloseRoundedIcon fontSize="small" />
        </IconButton>
      </Box>

      {/* Calm, non-blocking duplicate warning for an imported invoice (ADR-072).
          The user can still review and save; the create path is not blocked. */}
      {form.duplicate ? (
        <Alert
          severity="warning"
          variant="outlined"
          sx={{
            mb: 2.5,
            borderColor: 'var(--mg-border-2)',
            '& .MuiAlert-message': { fontSize: 13 },
          }}
        >
          {t('form.duplicate')}
        </Alert>
      ) : null}

      {/* Expense / Invoice·income segmented tabs. */}
      <ToggleButtonGroup
        value={form.type}
        exclusive
        onChange={handleTypeChange}
        fullWidth
        aria-label={t('form.type.ariaLabel')}
        sx={{
          mb: 2.5,
          gap: 0.75,
          p: 0.5,
          bgcolor: 'var(--mg-paper)',
          border: '1px solid var(--mg-border-2)',
          borderRadius: 2.5,
          '& .MuiToggleButton-root': {
            border: 'none',
            borderRadius: 2,
            py: 1.1,
            fontWeight: 600,
            color: 'text.secondary',
            textTransform: 'none',
          },
          '& .MuiToggleButton-root.Mui-selected': {
            bgcolor: 'var(--mg-gold)',
            color: 'var(--mg-on-gold)',
            '&:hover': { bgcolor: 'var(--mg-gold-hover)' },
          },
        }}
      >
        <ToggleButton value="expense">{t('form.type.expense')}</ToggleButton>
        <ToggleButton value="income">{t('form.type.income')}</ToggleButton>
      </ToggleButtonGroup>

      {/* Mobile-reachable entry to the routed statement-import flow, Expense-only
          (ADR-017). The desktop sidebar's "Import statement" button is hidden on
          mobile; this low-key sibling sits right under the type switch. Shown only
          on the Expense tab — invoices use the upload-to-autofill control instead.
          Navigates + closes the dialog/sheet; reuses the shell label (ADR-019:
          native Button, keyboard-operable, descriptive accessible name). */}
      {isExpense ? (
        <Button
          type="button"
          variant="outlined"
          color="secondary"
          fullWidth
          onClick={handleImportStatement}
          startIcon={<UploadFileIcon fontSize="small" />}
          sx={{
            mb: 2.5,
            py: 1.1,
            fontWeight: 600,
            textTransform: 'none',
            color: 'text.secondary',
            borderColor: 'var(--mg-border-2)',
          }}
        >
          {tShell('actions.importStatement')}
        </Button>
      ) : null}

      {/* Upload-to-autofill, on the invoice/income input only (ADR-072). Picking
          an ARCA PDF parses it and autofills the fields below; the user reviews
          and decides whether to save (the parse is non-committal). A failed parse
          shows a calm inline message and the form stays usable. Expenses aren't
          invoices, so the control is hidden there. */}
      {!isExpense ? (
        <Box sx={{ mb: 2.5 }}>
          {/* When a PDF is attached, show a compact attached-file row (document
              icon + truncated name + remove) instead of the upload button, so the
              user sees which file they picked and can unattach it (issue #26).
              Otherwise show the upload-to-autofill control. */}
          {form.hasImportedDocument ? (
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                px: 1.5,
                py: 1,
                bgcolor: 'var(--mg-paper)',
                border: '1px solid var(--mg-border-2)',
                borderRadius: 2,
              }}
            >
              <DescriptionRoundedIcon
                fontSize="small"
                aria-hidden
                sx={{ color: 'var(--mg-gold)', flex: 'none' }}
              />
              <Typography
                title={form.attachedFileName ?? undefined}
                sx={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 13.5,
                  color: 'text.primary',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {form.attachedFileName ?? t('form.upload.attachedFallback')}
              </Typography>
              <IconButton
                type="button"
                onClick={handleRemoveAttachment}
                aria-label={t('form.upload.remove')}
                size="small"
                sx={{ flex: 'none', color: 'text.secondary' }}
              >
                <CloseRoundedIcon fontSize="small" />
              </IconButton>
            </Box>
          ) : (
            <Button
              type="button"
              variant="outlined"
              color="secondary"
              fullWidth
              onClick={handlePickFile}
              disabled={isParsing}
              startIcon={
                isParsing ? (
                  <CircularProgress size={15} thickness={5} color="inherit" />
                ) : (
                  <UploadFileIcon fontSize="small" />
                )
              }
              sx={{
                py: 1.1,
                fontWeight: 600,
                color: 'text.secondary',
                borderColor: 'var(--mg-border-2)',
                borderStyle: 'dashed',
                textTransform: 'none',
              }}
            >
              {isParsing
                ? t('form.upload.reading')
                : t('form.upload.cta')}
            </Button>
          )}

          {/* Hidden PDF picker for the upload control. The parse boundary
              re-validates the type; we accept PDFs to hint the OS dialog. */}
          <Box
            component="input"
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            onChange={handleFileChange}
            aria-hidden
            tabIndex={-1}
            sx={{ display: 'none' }}
          />

          {/* Calm, inline, non-blocking parse-failure message (ADR-072/037). */}
          {parseError ? (
            <Alert
              severity="warning"
              variant="outlined"
              sx={{
                mt: 1.25,
                borderColor: 'var(--mg-border-2)',
                '& .MuiAlert-message': { fontSize: 13 },
              }}
            >
              {parseError}
            </Alert>
          ) : null}
        </Box>
      ) : null}

      {/* Optional merchant/client name (ADR-088). When filled it becomes the
          transaction's `name` and the reconciliation match key (ADR-085); blank
          is valid and falls back to the category-derived label. A parsed invoice
          / the Monotributo cuota autofill populate it, still editable here. */}
      <TextField
        id={nameInputId}
        label={t('form.name.label')}
        value={form.name}
        onChange={(e) => form.setName(e.target.value)}
        placeholder={t('form.name.placeholder')}
        size="small"
        fullWidth
        sx={{ mb: 2.5 }}
      />

      {/* Amount. */}
      <SectionLabel>{t('form.amount.section')}</SectionLabel>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          borderBottom: '1px solid var(--mg-border-2)',
          pb: 0.5,
          mb: 1.5,
        }}
      >
        <Typography
          component="label"
          htmlFor={amountInputId}
          sx={{
            fontFamily: monoFontFamily,
            fontSize: 20,
            color: 'text.disabled',
          }}
        >
          {currencySymbol}
        </Typography>
        <InputBase
          id={amountInputId}
          value={form.amountText}
          onChange={(e) => form.setAmountText(e.target.value)}
          placeholder={t('form.amount.placeholder')}
          inputProps={{
            inputMode: 'decimal',
            'aria-label': t('form.amount.ariaLabel', { currency: currencySymbol }),
          }}
          sx={{
            flex: 1,
            fontFamily: monoFontFamily,
            fontSize: 30,
            fontWeight: 500,
            color: 'text.primary',
          }}
        />
      </Box>

      {/* Currency toggle. */}
      <ToggleButtonGroup
        value={form.currency}
        exclusive
        onChange={handleCurrencyChange}
        aria-label={t('form.currency.ariaLabel')}
        sx={{
          gap: 1,
          '& .MuiToggleButton-root': {
            fontFamily: monoFontFamily,
            fontSize: 13,
            px: 2.25,
            py: 1,
            borderRadius: '9px !important',
            border: '1px solid var(--mg-border-2)',
            color: 'text.secondary',
            textTransform: 'none',
          },
          '& .MuiToggleButton-root.Mui-selected': {
            color: 'text.primary',
            borderColor: 'primary.main',
            bgcolor: 'color-mix(in srgb, var(--mg-gold) 14%, transparent)',
            '&:hover': {
              bgcolor: 'color-mix(in srgb, var(--mg-gold) 20%, transparent)',
            },
          },
        }}
      >
        <ToggleButton value="ARS">ARS</ToggleButton>
        <ToggleButton value="USD">USD</ToggleButton>
      </ToggleButtonGroup>

      {/* FX block (USD only): explicit MEP / Official / Manual source selector
          with suggested values, the required rate field, a refresh affordance,
          and the live converted ARS (ADR-044/045). The source and converted ARS
          are always visible so the user knows "which dollar". */}
      {isUsd ? (
        <Box
          sx={{
            mt: 1.5,
            px: 1.5,
            py: 1.25,
            bgcolor: 'color-mix(in srgb, var(--mg-gold) 8%, transparent)',
            border: '1px solid var(--mg-border-2)',
            borderRadius: 2,
          }}
        >
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 1,
            }}
          >
            <Typography
              sx={{
                fontFamily: monoFontFamily,
                fontSize: 12.5,
                color: 'var(--mg-gold)',
              }}
            >
              {fxConvertedLabel}
            </Typography>
            <Button
              type="button"
              size="small"
              startIcon={
                isFetchingRate ? (
                  <CircularProgress size={13} thickness={5} color="inherit" />
                ) : (
                  <RefreshRoundedIcon sx={{ fontSize: 15 }} />
                )
              }
              onClick={form.refreshSuggestedRate}
              disabled={isFetchingRate}
              aria-label={t('form.fx.refreshAriaLabel')}
              sx={{
                fontSize: 12,
                color: 'text.secondary',
                minWidth: 0,
                px: 1,
              }}
            >
              {isFetchingRate ? t('form.fx.fetching') : t('form.fx.refresh')}
            </Button>
          </Box>

          {/* Rate-source selector: MEP / Official / Manual. Non-manual options
              show their suggested value and are disabled when that rate failed
              to load (greyed). Picking one pre-fills the rate field. */}
          <ToggleButtonGroup
            value={form.fxSource}
            exclusive
            onChange={handleFxSourceChange}
            aria-label={t('form.fx.sourceAriaLabel')}
            size="small"
            sx={{
              mt: 1.25,
              flexWrap: 'wrap',
              gap: 0.75,
              '& .MuiToggleButton-root': {
                fontFamily: monoFontFamily,
                fontSize: 12,
                px: 1.5,
                py: 0.6,
                borderRadius: '8px !important',
                border: '1px solid var(--mg-border-2)',
                color: 'text.secondary',
                textTransform: 'none',
              },
              '& .MuiToggleButton-root.Mui-selected': {
                color: 'text.primary',
                borderColor: 'primary.main',
                bgcolor: 'color-mix(in srgb, var(--mg-gold) 16%, transparent)',
                '&:hover': {
                  bgcolor: 'color-mix(in srgb, var(--mg-gold) 22%, transparent)',
                },
              },
              '& .MuiToggleButton-root.Mui-disabled': {
                color: 'text.disabled',
              },
            }}
          >
            <ToggleButton value="MEP" disabled={mepValue === null}>
              {mepOptionLabel}
            </ToggleButton>
            <ToggleButton value="official" disabled={officialValue === null}>
              {officialOptionLabel}
            </ToggleButton>
            <ToggleButton value="manual">{t('form.fx.manual')}</ToggleButton>
          </ToggleButtonGroup>

          <TextField
            id={rateInputId}
            label={t('form.fx.rateLabel')}
            value={form.rateText}
            onChange={(e) => form.setRateText(e.target.value)}
            size="small"
            fullWidth
            required
            error={form.usdRateMissing}
            helperText={rateHelperText}
            placeholder={
              isFetchingRate
                ? t('form.fx.ratePlaceholderFetching')
                : t('form.fx.ratePlaceholder')
            }
            slotProps={{
              htmlInput: {
                inputMode: 'decimal',
                'aria-label': t('form.fx.rateAriaLabel'),
              },
            }}
            sx={{
              mt: 1.25,
              '& .MuiInputBase-input': { fontFamily: monoFontFamily },
            }}
          />
        </Box>
      ) : null}

      {/* Category chips (single select; Income is implicit for income type). */}
      {isExpense ? (
        <Box sx={{ mt: 2.5 }}>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 1,
            }}
          >
            <SectionLabel>{t('form.category.section')}</SectionLabel>
            {/* Expense-only shortcut: load the user's monthly Monotributo cuota
                as an ARS Taxes expense, autofilled from their configured category
                (the income/invoice path has the upload control instead). Calmly
                disabled while the snapshot is pending or unavailable. */}
            <Button
              type="button"
              variant="text"
              size="small"
              onClick={handleLoadMonotributoCuota}
              disabled={
                monotributoQuery.isPending ||
                typeof monotributoCuota !== 'number' ||
                monotributoCuota <= 0
              }
              sx={{
                flex: 'none',
                px: 1,
                fontSize: 12.5,
                fontWeight: 600,
                color: 'text.secondary',
                textTransform: 'none',
              }}
            >
              {typeof monotributoCuota === 'number'
                ? t('form.category.loadCuotaAmount', {
                    amount: formatARS(monotributoCuota),
                  })
                : t('form.category.loadCuota')}
            </Button>
          </Box>
          <Stack
            direction="row"
            spacing={1}
            useFlexGap
            sx={{ flexWrap: 'wrap' }}
          >
            {EXPENSE_CATEGORIES.map((category) => (
              <SelectChip
                key={category}
                label={categoryLabel(category)}
                selected={form.category === category}
                onClick={() => form.setCategory(category)}
              />
            ))}
          </Stack>
        </Box>
      ) : null}

      {/* Account selector (ADR-122/133/134). The chosen account is the row's
          attribution (ADR-136 extension: the legacy bank picker is retired — a
          manual entry no longer carries a bank tag, its source is the account).
          A "no account" option leaves the row unlinked. The selector is always
          shown so a row can be attributed even before any FX/USD step. */}
      <Box sx={{ mt: 2.5 }}>
        <FormControl fullWidth size="small">
          <InputLabel id={`${accountSelectId}-label`}>
            {t('form.account.label')}
          </InputLabel>
          <Select
            id={accountSelectId}
            labelId={`${accountSelectId}-label`}
            label={t('form.account.label')}
            value={form.accountId}
            onChange={(event) => form.setAccountId(event.target.value)}
            sx={{ borderRadius: '10px', bgcolor: 'var(--mg-paper)' }}
          >
            <MenuItem value="">
              <em>{t('form.account.none')}</em>
            </MenuItem>
            {accountOptions.map((account) => (
              <MenuItem key={account.id} value={account.id}>
                {accountOptionLabel(account)}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Box>

      {/* Date — a native date picker. Defaults to today for a new transaction
          and prefills from the row's occurredOn on edit; `max` is today so no
          future-dated transactions are possible (ADR-041). Backdating is allowed. */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2,
          mt: 2.5,
        }}
      >
        <Typography
          component="label"
          htmlFor={dateInputId}
          sx={{ fontSize: 13.5, color: 'text.secondary' }}
        >
          {t('form.date.label')}
        </Typography>
        <TextField
          id={dateInputId}
          type="date"
          value={form.occurredOn}
          onChange={(e) => form.setOccurredOn(e.target.value)}
          size="small"
          slotProps={{
            htmlInput: {
              max: form.maxOccurredOn,
              'aria-label': t('form.date.ariaLabel'),
            },
          }}
          sx={{
            '& .MuiInputBase-input': {
              fontFamily: monoFontFamily,
              fontSize: 13,
              py: 0.9,
            },
            '& .MuiOutlinedInput-notchedOutline': {
              borderColor: 'var(--mg-border-2)',
            },
          }}
        />
      </Box>

      {/* Monotributo toggle (income only). */}
      {!isExpense ? (
        <Box
          sx={{
            mt: 2,
            px: 1.75,
            py: 1.5,
            bgcolor: 'var(--mg-paper)',
            border: '1px solid var(--mg-border-2)',
            borderRadius: 2.5,
          }}
        >
          <FormControlLabel
            sx={{ m: 0, width: '100%', justifyContent: 'space-between' }}
            labelPlacement="start"
            control={
              <Switch
                checked={form.countsTowardMonotributo}
                onChange={(e) =>
                  form.setCountsTowardMonotributo(e.target.checked)
                }
              />
            }
            label={
              <Box>
                <Typography sx={{ fontSize: 13.5, color: 'text.primary' }}>
                  {t('form.monotributo.label')}
                </Typography>
                <Typography sx={{ fontSize: 11.5, color: 'text.disabled' }}>
                  {t('form.monotributo.description')}
                </Typography>
              </Box>
            }
          />
        </Box>
      ) : null}

      {/* More details (lightweight). */}
      <Button
        type="button"
        onClick={() => setMoreOpen((v) => !v)}
        aria-expanded={moreOpen}
        endIcon={
          <ExpandMoreRoundedIcon
            sx={{
              transition: 'transform .15s',
              transform: moreOpen ? 'rotate(180deg)' : 'none',
            }}
          />
        }
        sx={{
          mt: 2,
          px: 0,
          color: 'text.secondary',
          fontSize: 13,
          fontWeight: 500,
          justifyContent: 'flex-start',
        }}
      >
        {t('form.more')}
      </Button>
      <Collapse in={moreOpen} unmountOnExit>
        <Stack spacing={1.5} sx={{ mt: 1 }}>
          <TextField
            id={notesInputId}
            label={t('form.notes.label')}
            value={form.notes}
            onChange={(e) => form.setNotes(e.target.value)}
            placeholder={t('form.notes.placeholder')}
            size="small"
            fullWidth
            multiline
            minRows={2}
          />
        </Stack>
      </Collapse>

      {/* Actions. */}
      <Box sx={{ display: 'flex', gap: 1.25, mt: 3 }}>
        <Button
          type="button"
          variant="outlined"
          color="secondary"
          onClick={onCancel}
          sx={{
            flex: 'none',
            px: 2.5,
            py: 1.25,
            color: 'text.secondary',
            borderColor: 'var(--mg-border-2)',
          }}
        >
          {t('form.actions.cancel')}
        </Button>
        {/* Reset all fields to blank new-entry defaults (issue #26). Clears the
            inputs + any attachment; it does NOT submit or close the form. */}
        <Button
          type="button"
          variant="text"
          color="secondary"
          onClick={handleResetAll}
          aria-label={t('form.actions.resetAriaLabel')}
          sx={{
            flex: 'none',
            px: 2,
            py: 1.25,
            color: 'text.secondary',
          }}
        >
          {t('form.actions.reset')}
        </Button>
        <Button
          type="submit"
          variant="contained"
          color="primary"
          disabled={!form.canSave || isSaving}
          sx={{ flex: 1, py: 1.25, fontWeight: 600 }}
        >
          {isSaving
            ? t('form.actions.saving')
            : form.mode === 'edit'
              ? t('form.actions.saveChanges')
              : t('form.actions.save')}
        </Button>
      </Box>
    </Box>
  )
}
