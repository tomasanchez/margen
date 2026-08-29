/**
 * Receivables ("money owed to me") page — a dedicated top-level destination
 * (ADR-208 amendment).
 *
 * Originally a collapsible section on the Accounts page, receivables was promoted
 * at the owner's request to a first-class bottom-nav tab ("Owed" / "Deudores")
 * with its own route. This page is a thin host: an <h1> landmark + subtitle
 * (consistent with the other top-level pages like Accounts/Reports), then the
 * self-contained {@link ReceivablesSection}, which owns the full CRUD, per-person
 * outstanding, income-match review, payments, and PDF export. All the domain
 * behavior stays in the section; the page only supplies the route-level chrome.
 */

import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { ReceivablesSection } from './ReceivablesSection'

export function ReceivablesPage() {
  const { t } = useTranslation('receivables')
  return (
    <Box>
      <Box sx={{ mb: 2.5 }}>
        <Typography
          component="h1"
          sx={{ fontSize: { xs: '1.25rem', md: '1.375rem' }, fontWeight: 600 }}
          color="text.primary"
        >
          {t('title')}
        </Typography>
        <Typography sx={{ fontSize: 13.5, mt: 0.25 }} color="text.secondary">
          {t('subtitle')}
        </Typography>
      </Box>

      <ReceivablesSection />
    </Box>
  )
}

export default ReceivablesPage
