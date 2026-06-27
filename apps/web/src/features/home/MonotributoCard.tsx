/**
 * Monotributo card — a confidence-building status panel (ADR-017, ADR-019).
 *
 * Header: "Monotributo · Category C" + a StatusPill carrying the standing.
 * Body: the used / annual-limit figures, a themed determinate LinearProgress
 * meter (its track + bar tokenized), the "60% used" / margin-left line, a
 * divider, then the projected category at the current pace with a short
 * reassuring note. A "See the N invoices behind this →" router link drills into
 * the invoices on the Transactions screen.
 *
 * When no Monotributo category is configured (ADR-020 edge case) the card shows
 * a neutral "set up your category" state instead of crashing.
 */

import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Divider from '@mui/material/Divider'
import LinearProgress, {
  linearProgressClasses,
} from '@mui/material/LinearProgress'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { Link } from '@tanstack/react-router'
import { StatusPill } from '../../components/StatusPill'
import { monoFontFamily } from '../../theme'
import { formatCurrency, formatPercent } from '../../lib/format'
import type { MonotributoState } from '../../mock/types'
import { SectionCard } from '../../components/SectionCard'

/**
 * Class for the invoice drill-in link's styling + a11y focus ring (defined in
 * index.css). The link is a bare TanStack `Link` (not `Box component={Link}`)
 * so the typed object `search` prop keeps its route inference — wrapping in
 * `Box`/`styled` degrades it to `AnyRouter` and the typed search stops checking.
 * This mirrors CategoryBreakdown's category drilldown link (ADR-062).
 */
const drillInLinkClass = 'mg-monotributo-drillin'

export interface MonotributoCardProps {
  monotributo: MonotributoState | undefined
  /** How many invoices feed the annual total (for the drill-in link). */
  invoiceCount: number
  loading?: boolean
}

/** Neutral fallback when the user has not configured a category yet. */
function MonotributoEmpty() {
  const { t } = useTranslation('home')
  return (
    <SectionCard title={t('monotributo.title')} highlight>
      <Typography sx={{ fontSize: 13.5, lineHeight: 1.5 }} color="text.secondary">
        {t('monotributo.emptyBody')}
      </Typography>
      <Button
        variant="outlined"
        sx={{
          mt: 2,
          alignSelf: 'flex-start',
          textTransform: 'none',
          borderRadius: '10px',
          borderColor: 'var(--mg-border-2)',
          color: 'text.primary',
        }}
      >
        {t('monotributo.setUp')}
      </Button>
    </SectionCard>
  )
}

export function MonotributoCard({
  monotributo,
  invoiceCount,
  loading = false,
}: MonotributoCardProps) {
  const { t } = useTranslation('home')
  if (loading) {
    return (
      <SectionCard title={t('monotributo.title')} highlight>
        <Skeleton variant="text" width="50%" height={32} />
        <Skeleton variant="text" width="70%" sx={{ mb: 2 }} />
        <Skeleton variant="rounded" height={14} sx={{ borderRadius: '9px' }} />
        <Skeleton variant="text" width="60%" sx={{ mt: 2 }} />
      </SectionCard>
    )
  }

  if (!monotributo) {
    return <MonotributoEmpty />
  }

  const pct = Math.min(Math.max(monotributo.usedRatio, 0), 1) * 100

  return (
    <SectionCard
      title={t('monotributo.titleWithCategory', {
        category: monotributo.category,
      })}
      highlight
      action={<StatusPill status={monotributo.status} />}
    >
      <Box sx={{ mb: 0.5 }}>
        <Typography
          component="span"
          sx={{
            fontFamily: monoFontFamily,
            fontVariantNumeric: 'tabular-nums',
            fontSize: '1.4375rem',
            fontWeight: 500,
            color: 'text.primary',
          }}
        >
          {formatCurrency(monotributo.used, 'ARS')}
        </Typography>
      </Box>
      <Typography
        component="p"
        sx={{
          fontFamily: monoFontFamily,
          fontSize: 12.5,
          mb: 2,
          color: 'text.disabled',
        }}
      >
        {t('monotributo.usedOfLimit', {
          limit: formatCurrency(monotributo.annualLimit, 'ARS'),
        })}
      </Typography>

      <LinearProgress
        variant="determinate"
        value={pct}
        aria-label={t('monotributo.limitAriaLabel', {
          percent: formatPercent(monotributo.usedRatio),
        })}
        sx={{
          height: 14,
          borderRadius: '9px',
          bgcolor: 'var(--mg-raised)',
          [`& .${linearProgressClasses.bar}`]: {
            borderRadius: '9px',
            backgroundImage:
              'linear-gradient(90deg, var(--mg-gold), var(--mg-gold-hover))',
          },
        }}
      />
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1,
          mt: 1.375,
        }}
      >
        <Typography
          component="span"
          sx={{
            fontFamily: monoFontFamily,
            fontSize: 13,
            color: 'var(--mg-text-mid)',
          }}
        >
          {t('monotributo.percentUsed', {
            percent: formatPercent(monotributo.usedRatio),
          })}
        </Typography>
        <Typography component="span" sx={{ fontSize: 12.5 }} color="text.secondary">
          {t('monotributo.margin', {
            amount: formatCurrency(monotributo.margin, 'ARS'),
          })}
        </Typography>
      </Box>

      <Divider sx={{ my: 2.25, borderColor: 'var(--mg-border-2)' }} />

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1.5,
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontSize: 13 }} color="text.secondary">
            {t('monotributo.projectedCategory')}
          </Typography>
          <Typography
            sx={{
              fontFamily: monoFontFamily,
              fontSize: 12,
              mt: 0.375,
              color: 'text.disabled',
            }}
          >
            {monotributo.projectedPaceLabel}
          </Typography>
        </Box>
        <Typography
          component="span"
          sx={{
            fontFamily: monoFontFamily,
            fontSize: '1.375rem',
            fontWeight: 600,
            color: 'var(--mg-watch)',
            flex: 'none',
          }}
        >
          {monotributo.projectedCategory}
        </Typography>
      </Box>
      <Typography
        sx={{ fontSize: 12, mt: 1.5, lineHeight: 1.5, textWrap: 'pretty' }}
        color="text.disabled"
      >
        {t('monotributo.projectionNote')}
      </Typography>

      <Link
        to="/transactions"
        search={{ type: 'invoice' as const, month: 'last12' as const }}
        className={drillInLinkClass}
      >
        {t('monotributo.drillIn', { count: invoiceCount })}
      </Link>
    </SectionCard>
  )
}

export default MonotributoCard
