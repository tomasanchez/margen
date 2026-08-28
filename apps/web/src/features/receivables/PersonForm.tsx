/**
 * Add / rename a receivables person in a dialog (ADR-204/208, ADR-017/019/037).
 *
 * A person is a debtor the owner tracks money against (ADR-204). This form owns
 * the single "name" field for both create (no `person`) and rename (an existing
 * `person`), routing to {@link useCreatePerson} / {@link useRenamePerson}
 * accordingly. Both mutations invalidate the people list + that person's detail
 * (task 7), so the UI reads fresh data — this form never depends on a mutation's
 * return shape. On success it closes; on failure it stays open with the typed
 * name intact and surfaces a calm inline error (ADR-037).
 *
 * Keyboard + focus come from the shared {@link ResponsiveModal} (focus trap,
 * Escape closes, focus restored to the trigger); the field carries a real label.
 */

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { ResponsiveModal } from '../../components/ResponsiveModal'
import type { Person } from '../../api/receivablesClient'
import { useCreatePerson, useRenamePerson } from './queries'

export interface PersonFormProps {
  /** Whether the dialog is open. */
  open: boolean
  /** The person being renamed, or `null` to add a new one. */
  person: Person | null
  /** Dismiss / cancel the dialog. */
  onClose: () => void
}

export function PersonForm({ open, person, onClose }: PersonFormProps) {
  const { t } = useTranslation('receivables')
  const mode = person ? 'edit' : 'add'

  const nameId = useId()
  const errorId = useId()

  const [name, setName] = useState<string>(person?.name ?? '')

  const createPerson = useCreatePerson()
  const renamePerson = useRenamePerson()
  const isSaving = createPerson.isPending || renamePerson.isPending
  const saveError = createPerson.isError || renamePerson.isError

  const nameValid = name.trim().length > 0
  const canSave = nameValid && !isSaving

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSave) return
    const trimmed = name.trim()
    if (person) {
      renamePerson.mutate(
        { id: person.id, name: trimmed },
        { onSuccess: onClose },
      )
    } else {
      createPerson.mutate(trimmed, { onSuccess: onClose })
    }
  }

  const title =
    mode === 'edit' ? t('personForm.editTitle') : t('personForm.addTitle')

  return (
    <ResponsiveModal open={open} onClose={onClose} title={title} maxWidth={420}>
      <Box component="form" onSubmit={handleSubmit}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.25 }}>
          {saveError ? (
            <Typography
              id={errorId}
              role="alert"
              // MUI v9 Typography's `color` prop ignores dotted palette paths
              // ("error.main") and inherits primary text; route it through `sx`.
              sx={{ fontSize: 13, color: 'error.main' }}
            >
              {t('personForm.saveError')}
            </Typography>
          ) : null}

          <TextField
            id={nameId}
            label={t('personForm.name.label')}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            fullWidth
            autoFocus
            size="small"
            disabled={isSaving}
            slotProps={{
              htmlInput: {
                'aria-describedby': saveError ? errorId : undefined,
              },
            }}
          />
        </Box>

        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 3 }}>
          <Button
            type="button"
            onClick={onClose}
            color="secondary"
            sx={{ textTransform: 'none' }}
          >
            {t('personForm.cancel')}
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={!canSave}
            sx={{ textTransform: 'none', fontWeight: 600 }}
          >
            {t('personForm.save')}
          </Button>
        </Box>
      </Box>
    </ResponsiveModal>
  )
}

export default PersonForm
