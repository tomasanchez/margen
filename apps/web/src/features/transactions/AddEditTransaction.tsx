/**
 * Responsive presenter for the shared Add/Edit form (ADR-017).
 *
 * Reads the Add-flow seam (addContext) and renders the SAME {@link AddEditForm}
 * inside the shared {@link ResponsiveModal} — a centered Dialog on desktop (md+)
 * or a bottom-anchored Drawer (sheet) on mobile (xs–sm). The form owns its own
 * header (title + close), so this passes `titleId` (not `title`) to let the
 * surface label itself by the form's heading. Both surfaces trap focus and
 * restore it to the trigger on close, and Escape closes them — satisfying
 * ADR-019.
 *
 * On save it picks the add vs update mutation from the prefill id, then closes
 * the flow. The form is remounted per open via a `key`, so its seeded state
 * always reflects the current prefill.
 */

import Alert from '@mui/material/Alert'
import Snackbar from '@mui/material/Snackbar'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { ResponsiveModal } from '../../components/ResponsiveModal'
import type { NewTransactionInput } from '../../mock/types'
import { useAddTransaction as useAddTransactionFlow } from './addContext'
import {
  useAddTransaction as useAddTransactionMutation,
  useUpdateTransaction,
} from './queries'
import { AddEditForm } from './AddEditForm'

export function AddEditTransaction() {
  const { t } = useTranslation('transactions')
  const { isOpen, prefill, closeAdd } = useAddTransactionFlow()
  const titleId = useId()

  const addMutation = useAddTransactionMutation()
  const updateMutation = useUpdateTransaction()
  const isSaving = addMutation.isPending || updateMutation.isPending

  const handleSubmit = (
    input: NewTransactionInput,
    editId: string | undefined,
  ) => {
    if (typeof editId === 'string') {
      updateMutation.mutate(
        { id: editId, patch: input },
        { onSuccess: () => closeAdd() },
      )
    } else {
      addMutation.mutate(input, { onSuccess: () => closeAdd() })
    }
  }

  // Remount the form whenever a new flow opens so its seeded state is fresh.
  const formKey = isOpen
    ? `${prefill?.id ?? 'new'}-${prefill?.type ?? 'expense'}`
    : 'closed'

  const formNode = (
    <AddEditForm
      key={formKey}
      prefill={prefill}
      onSubmit={handleSubmit}
      isSaving={isSaving}
      onCancel={closeAdd}
      titleId={titleId}
    />
  )

  // Surface a save failure without losing the form (ADR-036/037): the form only
  // closes on success, so it stays open with the user's input intact while this
  // calm snackbar explains the failure and lets them retry by saving again.
  const saveError = updateMutation.isError || addMutation.isError
  const saveErrorSnackbar = (
    <Snackbar
      open={saveError && isOpen}
      autoHideDuration={null}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      onClose={(_, reason) => {
        if (reason === 'clickaway') return
        addMutation.reset()
        updateMutation.reset()
      }}
    >
      <Alert
        severity="error"
        variant="filled"
        onClose={() => {
          addMutation.reset()
          updateMutation.reset()
        }}
        sx={{ width: '100%' }}
      >
        {t('form.saveError')}
      </Alert>
    </Snackbar>
  )

  return (
    <>
      <ResponsiveModal
        open={isOpen}
        onClose={closeAdd}
        titleId={titleId}
        maxWidth={460}
      >
        {formNode}
      </ResponsiveModal>
      {saveErrorSnackbar}
    </>
  )
}
