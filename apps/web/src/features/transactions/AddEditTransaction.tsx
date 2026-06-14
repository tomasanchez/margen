/**
 * Responsive presenter for the shared Add/Edit form (ADR-017).
 *
 * Reads the Add-flow seam (addContext) and renders the SAME {@link AddEditForm}
 * inside a centered MUI Dialog on desktop (md+) or a bottom-anchored Drawer
 * (sheet) on mobile (xs–sm). Both surfaces trap focus and restore it to the
 * trigger on close, and Escape closes them (MUI built-ins) — satisfying ADR-019.
 *
 * On save it picks the add vs update mutation from the prefill id, then closes
 * the flow. The form is remounted per open via a `key`, so its seeded state
 * always reflects the current prefill.
 */

import Dialog from '@mui/material/Dialog'
import Drawer from '@mui/material/Drawer'
import Box from '@mui/material/Box'
import Alert from '@mui/material/Alert'
import Snackbar from '@mui/material/Snackbar'
import { useMediaQuery, useTheme } from '@mui/material'
import { useId } from 'react'
import type { NewTransactionInput } from '../../mock/types'
import { useAddTransaction as useAddTransactionFlow } from './addContext'
import {
  useAddTransaction as useAddTransactionMutation,
  useUpdateTransaction,
} from './queries'
import { AddEditForm } from './AddEditForm'

/** Inner padding shared by both surfaces (concept used 24px). */
const CONTENT_SX = { px: 3, py: 3 } as const

export function AddEditTransaction() {
  const { isOpen, prefill, closeAdd } = useAddTransactionFlow()
  const theme = useTheme()
  const isMobile = useMediaQuery(theme.breakpoints.down('md'))
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
        We couldn't save your transaction. Please try again.
      </Alert>
    </Snackbar>
  )

  const surface = isMobile ? (
    (
      <Drawer
        anchor="bottom"
        open={isOpen}
        onClose={closeAdd}
        aria-labelledby={titleId}
        slotProps={{
          paper: {
            sx: {
              borderTopLeftRadius: 24,
              borderTopRightRadius: 24,
              bgcolor: 'var(--mg-paper-2)',
              border: '1px solid',
              borderColor: 'var(--mg-border-2)',
              maxHeight: '92vh',
              px: 2.5,
              pt: 1.5,
              pb: 'calc(env(safe-area-inset-bottom) + 24px)',
            },
          },
        }}
      >
        {/* Grab handle (decorative). */}
        <Box
          aria-hidden
          sx={{
            width: 38,
            height: 4,
            borderRadius: 3,
            bgcolor: 'var(--mg-border-2)',
            mx: 'auto',
            mb: 2,
          }}
        />
        {formNode}
      </Drawer>
    )
  ) : (
    <Dialog
      open={isOpen}
      onClose={closeAdd}
      maxWidth={false}
      aria-labelledby={titleId}
      slotProps={{
        paper: {
          sx: {
            width: '100%',
            maxWidth: 460,
            bgcolor: 'var(--mg-paper-2)',
            border: '1px solid var(--mg-border-2)',
            borderRadius: 5,
            ...CONTENT_SX,
          },
        },
      }}
    >
      {formNode}
    </Dialog>
  )

  return (
    <>
      {surface}
      {saveErrorSnackbar}
    </>
  )
}
