/**
 * Add / edit an institution in a dialog (ADR-134, ADR-017/019/037).
 *
 * Captures the two institution fields: name and type (bank / card / cash /
 * wallet — `wallet` covers Deel, Payoneer, Mercado Pago, ADR-134). On save it
 * picks the create vs update mutation from the `institution` prop (edit when
 * present) and closes on success; a failure keeps the dialog open with the
 * user's input intact and surfaces a calm inline message (ADR-037).
 *
 * Keyboard + focus: the MUI Dialog traps focus, restores it to the trigger on
 * close, and Escape closes (ADR-019). Every control has an associated label.
 */

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControl from '@mui/material/FormControl'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import type {
  AccountType,
  Institution,
  InstitutionWriteBody,
} from '../../mock/types'
import { ACCOUNT_TYPES, accountTypeLabel } from './presentation'

export interface InstitutionFormProps {
  /** Whether the dialog is open. */
  open: boolean
  /** The institution being edited, or `null` to add a new one. */
  institution: Institution | null
  /** Whether a save mutation is in flight (disables the form / shows progress). */
  isSaving: boolean
  /** True when the last save failed — surfaces the calm inline error (ADR-037). */
  saveError: boolean
  /** Save handler; receives the assembled write body. */
  onSubmit: (input: InstitutionWriteBody) => void
  /** Cancel / dismiss the dialog. */
  onClose: () => void
}

export function InstitutionForm({
  open,
  institution,
  isSaving,
  saveError,
  onSubmit,
  onClose,
}: InstitutionFormProps) {
  const { t } = useTranslation('accounts')
  const mode = institution ? 'edit' : 'add'

  const nameId = useId()
  const typeId = useId()
  const errorId = useId()
  const titleId = useId()

  const [name, setName] = useState<string>(institution?.name ?? '')
  const [type, setType] = useState<AccountType>(institution?.type ?? 'bank')

  const nameValid = name.trim().length > 0
  const canSave = nameValid && !isSaving

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSave) return
    onSubmit({ name: name.trim(), type })
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth={false}
      aria-labelledby={titleId}
      slotProps={{
        paper: {
          sx: {
            width: '100%',
            maxWidth: '440px',
            bgcolor: 'var(--mg-paper-2)',
            border: '1px solid var(--mg-border-2)',
            borderRadius: '20px',
          },
        },
      }}
    >
      <Box component="form" onSubmit={handleSubmit}>
        <DialogTitle id={titleId} sx={{ fontSize: 18, fontWeight: 600 }}>
          {mode === 'edit'
            ? t('institutionForm.editTitle')
            : t('institutionForm.addTitle')}
        </DialogTitle>

        <DialogContent
          sx={{ display: 'flex', flexDirection: 'column', gap: 2.25 }}
        >
          {saveError ? (
            <Typography
              id={errorId}
              role="alert"
              sx={{ fontSize: 13 }}
              color="error.main"
            >
              {t('institutionForm.saveError')}
            </Typography>
          ) : null}

          <TextField
            id={nameId}
            label={t('institutionForm.name.label')}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            fullWidth
            size="small"
            disabled={isSaving}
            slotProps={{
              htmlInput: {
                'aria-describedby': saveError ? errorId : undefined,
              },
            }}
          />

          <FormControl fullWidth size="small" disabled={isSaving}>
            <InputLabel id={`${typeId}-label`}>
              {t('institutionForm.type.label')}
            </InputLabel>
            <Select
              id={typeId}
              labelId={`${typeId}-label`}
              label={t('institutionForm.type.label')}
              value={type}
              onChange={(event) => setType(event.target.value as AccountType)}
            >
              {ACCOUNT_TYPES.map((value) => (
                <MenuItem key={value} value={value}>
                  {accountTypeLabel(value)}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </DialogContent>

        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button
            type="button"
            onClick={onClose}
            color="secondary"
            sx={{ textTransform: 'none' }}
          >
            {t('institutionForm.cancel')}
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={!canSave}
            sx={{ textTransform: 'none', fontWeight: 600 }}
          >
            {t('institutionForm.save')}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  )
}

export default InstitutionForm
