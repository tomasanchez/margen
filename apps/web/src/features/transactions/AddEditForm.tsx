/**
 * Shared Add/Edit transaction form (ADR-017, ADR-019).
 *
 * One form, rendered inside either a Dialog (desktop) or a bottom Drawer
 * (mobile) by {@link AddEditTransaction}. It ports the concept's Add modal
 * (Margen Home.dc.html) to MUI: segmented Expense / Invoice·income tabs, a large
 * IBM Plex Mono amount input with a currency-symbol prefix, an ARS/USD toggle
 * with an editable MEP FX context line, category + bank chips, a native date
 * picker (default today, max today; backdating allowed — ADR-041), an optional
 * "More details" section, and Cancel / Save.
 *
 * Color comes from the design tokens via the theme; layout uses MUI sx. All
 * controls are keyboard-operable and labelled (ADR-019); focus trapping and
 * restoration are handled by the surrounding Dialog/Drawer.
 */

import { useId, useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Collapse from '@mui/material/Collapse'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import InputBase from '@mui/material/InputBase'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import EditRoundedIcon from '@mui/icons-material/EditRounded'
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded'
import { BANKS } from '../../mock/seed'
import type {
  Bank,
  Currency,
  NewTransactionInput,
  TxType,
} from '../../mock/types'
import { formatARS } from '../../lib/format'
import { monoFontFamily } from '../../theme'
import type { AddPrefill } from './addContext'
import {
  EXPENSE_CATEGORIES,
  useAddEditFormState,
} from './useAddEditFormState'

/** Uppercase eyebrow heading shared by the form sections (token-driven). */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <Typography variant="overline" component="p" sx={{ mb: 1.25 }}>
      {children}
    </Typography>
  )
}

/** Gold-tinted selectable chip used for category and bank pickers. */
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
  const form = useAddEditFormState(prefill)
  const [moreOpen, setMoreOpen] = useState(false)
  const [rateEditing, setRateEditing] = useState(false)

  const amountInputId = useId()
  const rateInputId = useId()
  const dateInputId = useId()
  const notesInputId = useId()

  const isExpense = form.type === 'expense'
  const isUsd = form.currency === 'USD'
  const currencySymbol = isUsd ? 'USD' : 'ARS'

  const title =
    form.mode === 'edit'
      ? 'Edit transaction'
      : isExpense
        ? 'New expense'
        : 'New invoice · income'

  const handleTypeChange = (_: unknown, next: TxType | null) => {
    if (next) form.setType(next)
  }
  const handleCurrencyChange = (_: unknown, next: Currency | null) => {
    if (next) form.setCurrency(next)
  }

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.canSave || isSaving) return
    onSubmit(form.buildInput(), form.editId)
  }

  // FX context line: converted ARS value + rate type (MEP) + rate value.
  const fxConvertedLabel = form.usdRateMissing
    ? '≈ ARS — · enter a rate'
    : Number.isFinite(form.amountArs)
      ? `≈ ARS ${formatARS(form.amountArs)} at MEP ${formatARS(form.rate)}`
      : `Enter an amount · MEP ${formatARS(form.rate)}`

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
          aria-label="Close"
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

      {/* Expense / Invoice·income segmented tabs. */}
      <ToggleButtonGroup
        value={form.type}
        exclusive
        onChange={handleTypeChange}
        fullWidth
        aria-label="Transaction type"
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
        <ToggleButton value="expense">Expense</ToggleButton>
        <ToggleButton value="income">Invoice / income</ToggleButton>
      </ToggleButtonGroup>

      {/* Amount. */}
      <SectionLabel>Amount</SectionLabel>
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
          placeholder="0"
          inputProps={{
            inputMode: 'decimal',
            'aria-label': `Amount in ${currencySymbol}`,
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
        aria-label="Currency"
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

      {/* FX context line (USD only): converted ARS + MEP rate + edit affordance. */}
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
              startIcon={<EditRoundedIcon sx={{ fontSize: 15 }} />}
              onClick={() => setRateEditing((v) => !v)}
              aria-expanded={rateEditing}
              sx={{
                fontSize: 12,
                color: 'text.secondary',
                minWidth: 0,
                px: 1,
              }}
            >
              {rateEditing ? 'Done' : 'Edit rate'}
            </Button>
          </Box>
          <Collapse in={rateEditing} unmountOnExit>
            <TextField
              id={rateInputId}
              label="MEP rate (ARS per USD)"
              value={form.rateText}
              onChange={(e) => form.setRateText(e.target.value)}
              size="small"
              fullWidth
              error={form.usdRateMissing}
              helperText={
                form.usdRateMissing
                  ? 'Enter a rate to convert this USD amount.'
                  : undefined
              }
              slotProps={{ htmlInput: { inputMode: 'decimal' } }}
              sx={{
                mt: 1.25,
                '& .MuiInputBase-input': { fontFamily: monoFontFamily },
              }}
            />
          </Collapse>
        </Box>
      ) : null}

      {/* Category chips (single select; Income is implicit for income type). */}
      {isExpense ? (
        <Box sx={{ mt: 2.5 }}>
          <SectionLabel>Category</SectionLabel>
          <Stack
            direction="row"
            spacing={1}
            useFlexGap
            sx={{ flexWrap: 'wrap' }}
          >
            {EXPENSE_CATEGORIES.map((category) => (
              <SelectChip
                key={category}
                label={category}
                selected={form.category === category}
                onClick={() => form.setCategory(category)}
              />
            ))}
          </Stack>
        </Box>
      ) : null}

      {/* Bank / card chips (single select). */}
      <Box sx={{ mt: 2.5 }}>
        <SectionLabel>Bank / card</SectionLabel>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          {BANKS.map((bank: Bank) => (
            <SelectChip
              key={bank}
              label={bank}
              selected={form.bank === bank}
              onClick={() => form.setBank(bank)}
            />
          ))}
        </Stack>
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
          Date
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
              'aria-label': 'Transaction date',
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
                  Counts toward Monotributo
                </Typography>
                <Typography sx={{ fontSize: 11.5, color: 'text.disabled' }}>
                  Adds to your annual invoiced total
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
        More details
      </Button>
      <Collapse in={moreOpen} unmountOnExit>
        <Stack spacing={1.5} sx={{ mt: 1 }}>
          <TextField
            id={notesInputId}
            label="Notes"
            value={form.notes}
            onChange={(e) => form.setNotes(e.target.value)}
            placeholder="Optional"
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
          Cancel
        </Button>
        <Button
          type="submit"
          variant="contained"
          color="primary"
          disabled={!form.canSave || isSaving}
          sx={{ flex: 1, py: 1.25, fontWeight: 600 }}
        >
          {isSaving
            ? 'Saving…'
            : form.mode === 'edit'
              ? 'Save changes'
              : 'Save'}
        </Button>
      </Box>
    </Box>
  )
}
