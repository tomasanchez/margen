/**
 * Status hero — the ONE primary status message on Home (ADR-017, ADR-019).
 *
 * Renders a single Safe/Watch/Risk standing (StatusPill, never color alone), a
 * large headline, and a supporting line, with two quick-action buttons that open
 * the Add/Edit seam pre-typed as an expense or an invoice (income). Status, copy
 * and the supporting figures are derived from the live month metrics + the
 * Monotributo snapshot so the message stays truthful as data changes.
 */

import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Skeleton from '@mui/material/Skeleton'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import RemoveRoundedIcon from '@mui/icons-material/RemoveRounded'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import { StatusPill } from '../../components/StatusPill'
import { formatPercent } from '../../lib/format'
import type { MonotributoState, StatusLevel } from '../../mock/types'
import { useAddTransaction } from '../transactions/addContext'

export interface StatusHeroProps {
  /** Monotributo snapshot, drives the limit % in the supporting line. */
  monotributo: MonotributoState | undefined
  /** Estimated savings for the month (income − expenses). */
  savings: number | undefined
  /** Month-over-month expense delta (%), e.g. 12 for "+12% vs. May". */
  expenseDeltaPct: number
  /** Month label, e.g. "June 2026". */
  monthLabel: string
  /** Whether the underlying queries are still resolving. */
  loading?: boolean
}

/**
 * Build the supporting sentence from the live figures, degrading gracefully when
 * a Monotributo category is not configured (ADR-020 edge case).
 */
function buildSupportingLine(
  monotributo: MonotributoState | undefined,
  savings: number | undefined,
  expenseDeltaPct: number,
  t: TFunction<'home'>,
): string {
  // The localized clauses (including their leading comma/space) compose into the
  // single supporting sentence by interpolation, not concatenation (ADR-061).
  const lead =
    savings != null && savings >= 0
      ? t('hero.supporting.ahead')
      : t('hero.supporting.behind')

  const limit = monotributo
    ? t('hero.supporting.limit', {
        percent: formatPercent(monotributo.usedRatio),
      })
    : ''

  const watch =
    expenseDeltaPct > 0
      ? t('hero.supporting.watch', { percent: Math.round(expenseDeltaPct) })
      : ''

  return t('hero.supporting.sentence', { lead, limit, watch })
}

export function StatusHero({
  monotributo,
  savings,
  expenseDeltaPct,
  monthLabel,
  loading = false,
}: StatusHeroProps) {
  const { t } = useTranslation('home')
  const { openAdd } = useAddTransaction()
  const status: StatusLevel = monotributo?.status ?? 'safe'

  if (loading) {
    return (
      <Box sx={{ mb: { xs: 3, md: 3.75 } }}>
        <Skeleton variant="rounded" width={150} height={28} sx={{ mb: 1.5 }} />
        <Skeleton variant="text" width="70%" height={42} />
        <Skeleton variant="text" width="90%" />
        <Skeleton variant="text" width="55%" />
      </Box>
    )
  }

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: { xs: 'column', md: 'row' },
        alignItems: { xs: 'stretch', md: 'flex-start' },
        justifyContent: 'space-between',
        gap: { xs: 2, md: 3.75 },
        mb: { xs: 3, md: 3.75 },
      }}
    >
      <Box sx={{ maxWidth: 660, minWidth: 0 }}>
        <Box sx={{ mb: 1.5 }}>
          <StatusPill
            status={status}
            label={`${t(`hero.statusLabel.${status}`)} · ${monthLabel}`}
          />
        </Box>
        <Typography
          component="p"
          color="text.primary"
          sx={{
            fontSize: { xs: '1.5rem', md: '1.875rem' },
            fontWeight: 600,
            letterSpacing: '-0.02em',
            lineHeight: 1.2,
            textWrap: 'pretty',
          }}
        >
          {t(`hero.headline.${status}`)}
        </Typography>
        <Typography
          component="p"
          color="text.secondary"
          sx={{
            fontSize: { xs: '0.875rem', md: '0.9375rem' },
            mt: 1.5,
            lineHeight: 1.55,
            maxWidth: 600,
            textWrap: 'pretty',
          }}
        >
          {buildSupportingLine(monotributo, savings, expenseDeltaPct, t)}
        </Typography>
      </Box>

      <Stack
        direction={{ xs: 'row', md: 'column' }}
        spacing={1.25}
        sx={{ flex: 'none' }}
      >
        <Button
          variant="outlined"
          startIcon={
            <RemoveRoundedIcon sx={{ color: 'var(--mg-risk)' }} fontSize="small" />
          }
          onClick={() => openAdd({ type: 'expense', kind: 'expense' })}
          sx={{
            justifyContent: 'flex-start',
            textTransform: 'none',
            fontSize: 13.5,
            fontWeight: 500,
            color: 'text.primary',
            borderColor: 'var(--mg-border-2)',
            bgcolor: 'var(--mg-paper)',
            borderRadius: '10px',
            minWidth: { xs: 0, md: 132 },
            flex: { xs: 1, md: 'none' },
          }}
        >
          {t('hero.addExpense')}
        </Button>
        <Button
          variant="outlined"
          startIcon={
            <AddRoundedIcon sx={{ color: 'var(--mg-safe)' }} fontSize="small" />
          }
          onClick={() => openAdd({ type: 'income', kind: 'invoice' })}
          sx={{
            justifyContent: 'flex-start',
            textTransform: 'none',
            fontSize: 13.5,
            fontWeight: 500,
            color: 'text.primary',
            borderColor: 'var(--mg-border-2)',
            bgcolor: 'var(--mg-paper)',
            borderRadius: '10px',
            minWidth: { xs: 0, md: 132 },
            flex: { xs: 1, md: 'none' },
          }}
        >
          {t('hero.addInvoice')}
        </Button>
      </Stack>
    </Box>
  )
}

export default StatusHero
