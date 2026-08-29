/**
 * Per-person "Export PDF" action (ADR-209, ADR-092, ADR-037).
 *
 * Downloads the person's receivables PDF — an English, hand-to-the-debtor document
 * of their name, total outstanding, and itemized entries (ADR-209). The endpoint
 * sits behind the Supabase bearer guard (ADR-092), so a bare `<a href>` GET would
 * 401; {@link receivablesClient.downloadPersonPdf} fetches the bytes through the
 * authed fetcher and triggers a browser save. This button just drives that call
 * with a calm pending/disabled state and a calm, dismissible inline error (ADR-037)
 * — it never throws into render. A mounted guard avoids a state update after the
 * detail panel collapses mid-fetch.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded'
import { receivablesClient } from '../../api/receivablesClient'

export interface PersonPdfButtonProps {
  /** The person whose receivables PDF to download. */
  personId: string
  /** The person's display name (used to build the saved filename + label). */
  personName: string
}

export function PersonPdfButton({ personId, personName }: PersonPdfButtonProps) {
  const { t, i18n } = useTranslation('receivables')
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  // The fetch can outlive the expanded panel; guard against a post-unmount update.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // The PDF follows the app locale: send the active UI language ('en' / 'es') so
  // the document renders in the language the user is viewing. `resolvedLanguage`
  // collapses region variants (es-AR → es) to a supported base (ADR-101).
  const lang = i18n.resolvedLanguage ?? i18n.language

  const onExport = useCallback(() => {
    setFailed(false)
    setPending(true)
    void (async () => {
      try {
        await receivablesClient.downloadPersonPdf(personId, personName, lang)
      } catch {
        // Never throw into render — surface a calm, dismissible message (ADR-037).
        if (mountedRef.current) setFailed(true)
      } finally {
        if (mountedRef.current) setPending(false)
      }
    })()
  }, [personId, personName, lang])

  return (
    <Box sx={{ mt: 1 }}>
      <Button
        type="button"
        onClick={onExport}
        disabled={pending}
        size="small"
        variant="outlined"
        color="secondary"
        startIcon={<DownloadRoundedIcon />}
        aria-label={t('pdf.aria', { name: personName })}
        sx={{
          textTransform: 'none',
          fontWeight: 600,
          borderColor: 'var(--mg-border-2)',
          color: 'text.primary',
        }}
      >
        {pending ? t('pdf.exporting') : t('pdf.export')}
      </Button>

      {failed ? (
        <Alert severity="error" onClose={() => setFailed(false)} sx={{ mt: 1 }}>
          {t('pdf.error')}
        </Alert>
      ) : null}
    </Box>
  )
}

export default PersonPdfButton
