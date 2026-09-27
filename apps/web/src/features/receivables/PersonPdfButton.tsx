/**
 * Per-person "Export PDF" action (ADR-209, ADR-211, ADR-212, ADR-092, ADR-037).
 *
 * Downloads the person's receivables PDF — a hand-to-the-debtor "Estado de cuenta"
 * (ADR-211) — through {@link receivablesClient.downloadPersonPdf}, which fetches
 * the bytes with the Supabase bearer token (ADR-092, a bare `<a href>` GET would
 * 401) and triggers a browser save.
 *
 * Two content modes (ADR-212):
 *  - PRIMARY, one tap: OUTSTANDING-ONLY — only debts still owed, at their
 *    remaining amount. This is the default and sends NO `full` param.
 *  - Opt-in, behind a small caret menu: FULL HISTORY — the complete running-balance
 *    ledger + paid-history section (the ADR-211 rendering), requested with
 *    `full=true`.
 *
 * The trigger is a calm split control: a primary button (outstanding) joined to a
 * caret button that opens a two-item menu (Outstanding / Full history), mirroring
 * the app's menu affordances (FilterBar / TransactionRow). Both actions share ONE
 * pending/disabled state and ONE dismissible inline error (ADR-037) — it never
 * throws into render. A mounted guard avoids a state update after the detail panel
 * collapses mid-fetch.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown'
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
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const menuOpen = Boolean(anchorEl)
  const menuId = useId()
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

  const runExport = useCallback(
    (full: boolean) => {
      setFailed(false)
      setPending(true)
      void (async () => {
        try {
          // Outstanding-only is the default and sends NO `full` param (clean URL,
          // ADR-212); the full-history opt-in requests `full=true`.
          if (full) {
            await receivablesClient.downloadPersonPdf(
              personId,
              personName,
              lang,
              true,
            )
          } else {
            await receivablesClient.downloadPersonPdf(personId, personName, lang)
          }
        } catch {
          // Never throw into render — surface a calm, dismissible message (ADR-037).
          if (mountedRef.current) setFailed(true)
        } finally {
          if (mountedRef.current) setPending(false)
        }
      })()
    },
    [personId, personName, lang],
  )

  const openMenu = (event: MouseEvent<HTMLElement>) =>
    setAnchorEl(event.currentTarget)
  const closeMenu = () => setAnchorEl(null)
  /** Close the menu first (so focus returns to the trigger), then export. */
  const chooseAndClose = (full: boolean) => () => {
    closeMenu()
    runExport(full)
  }

  return (
    <Box sx={{ mt: 1 }}>
      <Box sx={{ display: 'inline-flex' }}>
        {/* PRIMARY: one-tap OUTSTANDING export (the default mode — no `full`). */}
        <Button
          type="button"
          onClick={() => runExport(false)}
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
            borderTopRightRadius: 0,
            borderBottomRightRadius: 0,
          }}
        >
          {pending ? t('pdf.exporting') : t('pdf.export')}
        </Button>

        {/* Caret: opens a calm two-item menu (Outstanding / Full history). */}
        <Button
          type="button"
          onClick={openMenu}
          disabled={pending}
          size="small"
          variant="outlined"
          color="secondary"
          aria-label={t('pdf.menuAria', { name: personName })}
          aria-haspopup="menu"
          aria-controls={menuOpen ? menuId : undefined}
          aria-expanded={menuOpen}
          sx={{
            minWidth: 0,
            px: 0.5,
            borderColor: 'var(--mg-border-2)',
            color: 'text.primary',
            borderTopLeftRadius: 0,
            borderBottomLeftRadius: 0,
            // Share the primary button's right border as the single seam.
            borderLeft: 'none',
          }}
        >
          <ArrowDropDownIcon fontSize="small" />
        </Button>
      </Box>

      <Menu
        id={menuId}
        anchorEl={anchorEl}
        open={menuOpen}
        onClose={closeMenu}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{
          paper: {
            elevation: 0,
            sx: {
              mt: 0.5,
              minWidth: 208,
              borderRadius: 2,
              border: 1,
              borderColor: 'divider',
              bgcolor: 'background.paper',
              boxShadow: '0 12px 32px -12px rgba(0,0,0,0.45)',
            },
          },
          list: {
            sx: { py: 0.5 },
            'aria-label': t('pdf.menuAria', { name: personName }),
          },
        }}
      >
        {/* Outstanding is the default — `selected` marks the current mode so it
            reads without relying on color alone (ADR-019). */}
        <MenuItem selected onClick={chooseAndClose(false)} sx={{ py: 1.25 }}>
          {t('pdf.outstanding')}
        </MenuItem>
        <MenuItem onClick={chooseAndClose(true)} sx={{ py: 1.25 }}>
          {t('pdf.fullHistory')}
        </MenuItem>
      </Menu>

      {failed ? (
        <Alert severity="error" onClose={() => setFailed(false)} sx={{ mt: 1 }}>
          {t('pdf.error')}
        </Alert>
      ) : null}
    </Box>
  )
}

export default PersonPdfButton
