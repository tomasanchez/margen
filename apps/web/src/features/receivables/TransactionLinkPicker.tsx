/**
 * "Link transaction" picker for a receivable item (ADR-217, ADR-220).
 *
 * An optional, clearable autocomplete over the owner's own EXPENSES
 * ({@link useExpenseCandidates} → `GET /expense-candidates`, newest first). The
 * typed text is debounced and filtered SERVER-side (MUI's client filter is off);
 * opening the picker with nothing typed lists the most recent expenses. Each
 * option reads name, date, amount (plus the original USD for a USD expense) and
 * — for a card purchase in cuotas — its "Cuota N/M" (ADR-174), so the owner can
 * pick the right charge. Already-linked expenses stay pickable: one expense may
 * back several people's items (ADR-218).
 *
 * The link is REFERENCE-ONLY (ADR-219): picking one never moves a balance,
 * budget or category spend. MUI's Autocomplete popup is a non-modal Popper (no
 * body scroll-lock to disable — only Modal-based overlays take
 * `disableScrollLock`), so it is safe in the single-scroll shell.
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Autocomplete from '@mui/material/Autocomplete'
import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { describeExpense, type LinkedExpense } from './linking'
import { useExpenseCandidates } from './queries'
import { useDebouncedValue } from './useDebouncedValue'

/** How many candidates one search asks for (the API default; max 50). */
const CANDIDATE_LIMIT = 20

export interface TransactionLinkPickerProps {
  /** The linked expense, or null for none. */
  value: LinkedExpense | null
  /** Pick (or clear, with null) the linked expense. */
  onChange: (expense: LinkedExpense | null) => void
  disabled?: boolean
}

export function TransactionLinkPicker({
  value,
  onChange,
  disabled = false,
}: TransactionLinkPickerProps) {
  const { t } = useTranslation('receivables')
  const describe = (expense: LinkedExpense) => describeExpense(expense, t)
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const q = useDebouncedValue(typed.trim())

  // Only search while the picker is open: a closed picker costs no request.
  const candidates = useExpenseCandidates(
    open ? { ...(q ? { q } : {}), limit: CANDIDATE_LIMIT } : null,
  )

  // Keep the current value among the options (it may be an older expense the
  // current search doesn't return), so MUI can match + render it.
  const options = useMemo<LinkedExpense[]>(() => {
    const list: LinkedExpense[] = candidates.data ?? []
    if (value && !list.some((option) => option.id === value.id)) {
      return [value, ...list]
    }
    return list
  }, [candidates.data, value])

  return (
    <Autocomplete<LinkedExpense, false, false, false>
      value={value}
      onChange={(_event, next) => onChange(next)}
      onInputChange={(_event, text, reason) => {
        // Only TYPING drives the server search; selecting / clearing / blurring
        // resets it so reopening the picker lists the most recent expenses.
        setTyped(reason === 'input' ? text : '')
      }}
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      options={options}
      filterOptions={(all) => all}
      getOptionLabel={(option) => option.name}
      getOptionKey={(option) => option.id}
      isOptionEqualToValue={(option, selected) => option.id === selected.id}
      loading={candidates.isFetching}
      disabled={disabled}
      size="small"
      fullWidth
      autoHighlight
      clearText={t('link.clear')}
      openText={t('link.open')}
      closeText={t('link.close')}
      loadingText={t('link.loading')}
      noOptionsText={candidates.isError ? t('link.error') : t('link.noOptions')}
      renderOption={(props, option) => {
        const { key, ...optionProps } = props
        return (
          <Box component="li" key={key} {...optionProps}>
            <Box sx={{ minWidth: 0 }}>
              <Typography
                sx={{ fontSize: 13.5, fontWeight: 600, color: 'text.primary' }}
                noWrap
              >
                {option.name}
              </Typography>
              <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
                {describe(option)}
              </Typography>
            </Box>
          </Box>
        )
      }}
      renderInput={(params) => (
        <TextField
          {...params}
          label={t('link.label')}
          helperText={value ? describe(value) : t('link.helper')}
          slotProps={{
            ...params.slotProps,
            input: {
              ...params.slotProps.input,
              endAdornment: (
                <>
                  {candidates.isFetching ? (
                    <CircularProgress size={16} color="inherit" aria-hidden />
                  ) : null}
                  {params.slotProps.input.endAdornment}
                </>
              ),
            },
          }}
        />
      )}
    />
  )
}

export default TransactionLinkPicker
