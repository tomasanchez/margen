/**
 * "Who owes you this?" — pick an existing receivables person or name a new one
 * (ADR-204, ADR-220).
 *
 * Used by the item form when it is opened WITHOUT a person: the transactions
 * list's "Someone owes me this" entry point. A free-text autocomplete over the
 * owner's people ({@link useReceivablePeople}): picking a suggestion targets
 * that person; a typed name that matches nobody (case-insensitively) becomes a
 * NEW person on save, which the helper line says in words (ADR-019). The value
 * is a discriminated {@link PersonChoice} so callers can't confuse the two.
 *
 * MUI's Autocomplete popup is a non-modal Popper — no body scroll-lock involved,
 * so it is safe in the single-scroll shell.
 */

import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import Autocomplete from '@mui/material/Autocomplete'
import TextField from '@mui/material/TextField'
import type { Person } from '../../api/receivablesClient'
import type { PersonChoice, PersonPickerState } from './personChoice'
import { useReceivablePeople } from './queries'

export interface PersonPickerProps {
  value: PersonPickerState
  onChange: (next: PersonPickerState) => void
  /** The resolved choice (from {@link resolvePersonChoice}), for the helper line. */
  choice: PersonChoice | null
  disabled?: boolean
}

export function PersonPicker({
  value,
  onChange,
  choice,
  disabled = false,
}: PersonPickerProps) {
  const { t } = useTranslation('receivables')
  const peopleQuery = useReceivablePeople()
  const people = peopleQuery.data ?? []
  const inputId = useId()

  let helperText = t('personPicker.helper')
  if (choice?.kind === 'new') {
    helperText = t('personPicker.newPerson', { name: choice.name })
  } else if (choice?.kind === 'existing') {
    helperText = t('personPicker.existingPerson', { name: choice.name })
  }

  return (
    <Autocomplete<Person, false, false, true>
      freeSolo
      id={inputId}
      options={people}
      value={value.selected}
      inputValue={value.text}
      onInputChange={(_event, text, reason) => {
        // Typing keeps the picked person only while the text still names them.
        if (reason === 'input' || reason === 'clear') {
          onChange({
            text,
            selected:
              value.selected && value.selected.name === text ? value.selected : null,
          })
        }
      }}
      onChange={(_event, next) => {
        if (next === null) onChange({ text: '', selected: null })
        else if (typeof next === 'string') onChange({ text: next, selected: null })
        else onChange({ text: next.name, selected: next })
      }}
      getOptionLabel={(option) =>
        typeof option === 'string' ? option : option.name
      }
      getOptionKey={(option) => (typeof option === 'string' ? option : option.id)}
      isOptionEqualToValue={(option, selected) =>
        typeof selected !== 'string' && option.id === selected.id
      }
      loading={peopleQuery.isPending}
      disabled={disabled}
      size="small"
      fullWidth
      autoHighlight
      clearText={t('personPicker.clear')}
      openText={t('personPicker.open')}
      closeText={t('personPicker.close')}
      loadingText={t('personPicker.loading')}
      noOptionsText={t('personPicker.noOptions')}
      renderInput={(params) => (
        <TextField
          {...params}
          label={t('personPicker.label')}
          required
          helperText={helperText}
        />
      )}
    />
  )
}

export default PersonPicker
