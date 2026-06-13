/**
 * Recent activity — the latest few transactions previewed on Home (Issue #12).
 *
 * Each row shows the (mono) date, the name with optional recurring / FX badges,
 * the category, and the <Amount> (with an FX subline for USD rows). Money and
 * dates go through the shared <Amount> / format helpers — no inline number
 * styling. A "View all →" router link opens the full Transactions screen.
 *
 * Empty transactions render a graceful note instead of an empty card (ADR-020).
 * Rows are read-only previews here (edit/delete live on the Transactions page),
 * so the list is a clean, non-interactive summary.
 */

import Box from '@mui/material/Box'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { Link } from '@tanstack/react-router'
import { Amount } from '../../components/Amount'
import { monoFontFamily } from '../../theme'
import { formatDispDate } from '../../lib/format'
import type { Transaction } from '../../mock/types'
import { SectionCard } from '../../components/SectionCard'

/** Small bordered badge (recurring / FX), token-colored. */
function RowBadge({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode
  tone?: 'neutral' | 'gold'
}) {
  return (
    <Box
      component="span"
      sx={{
        flex: 'none',
        fontSize: 10,
        lineHeight: 1.6,
        px: 0.75,
        borderRadius: '5px',
        border: '1px solid',
        borderColor: tone === 'gold' ? 'primary.main' : 'var(--mg-border-2)',
        color: tone === 'gold' ? 'primary.main' : 'text.secondary',
        bgcolor:
          tone === 'gold'
            ? 'color-mix(in srgb, var(--mg-gold) 12%, transparent)'
            : 'var(--mg-raised)',
        fontFamily: tone === 'gold' ? monoFontFamily : undefined,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </Box>
  )
}

function ActivityRow({ transaction: t }: { transaction: Transaction }) {
  const isUsd = t.currency === 'USD'
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        py: 1.75,
        borderBottom: 1,
        borderColor: 'var(--mg-border)',
      }}
    >
      <Typography
        component="span"
        sx={{
          fontFamily: monoFontFamily,
          fontSize: 12.5,
          color: 'text.disabled',
          width: 54,
          flex: 'none',
          display: { xs: 'none', sm: 'block' },
        }}
      >
        {formatDispDate(t.dispDate)}
      </Typography>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
          <Typography
            component="span"
            color="text.primary"
            sx={{
              fontSize: 14,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            {t.name}
          </Typography>
          {t.recurring ? <RowBadge>recurring</RowBadge> : null}
          {isUsd ? <RowBadge tone="gold">FX</RowBadge> : null}
        </Box>
        <Typography
          component="span"
          sx={{
            display: 'block',
            fontSize: 12,
            mt: 0.375,
            color: 'text.disabled',
          }}
        >
          {t.category}
        </Typography>
      </Box>
      <Box sx={{ flex: 'none', textAlign: 'right' }}>
        <Amount
          value={t.amountNum}
          type={t.type}
          currency="ARS"
          size="md"
          fxUsd={isUsd ? t.usd : undefined}
          fxRate={isUsd ? t.rate : undefined}
        />
      </Box>
    </Box>
  )
}

export interface RecentActivityProps {
  transactions: Transaction[] | undefined
  loading?: boolean
}

function ViewAllLink() {
  return (
    <Box
      component={Link}
      to="/transactions"
      sx={{
        fontSize: 13,
        color: 'primary.main',
        textDecoration: 'none',
        borderRadius: 1,
        '&:hover': { textDecoration: 'underline', textUnderlineOffset: 2 },
        '&:focus-visible': {
          outline: '2px solid',
          outlineColor: 'primary.main',
          outlineOffset: 2,
        },
      }}
    >
      View all →
    </Box>
  )
}

export function RecentActivity({
  transactions,
  loading = false,
}: RecentActivityProps) {
  if (loading || !transactions) {
    return (
      <SectionCard title="Recent activity" action={<ViewAllLink />}>
        <Box>
          {Array.from({ length: 5 }).map((_, i) => (
            <Box
              key={i}
              sx={{
                py: 1.75,
                borderBottom: 1,
                borderColor: 'var(--mg-border)',
              }}
            >
              <Skeleton variant="text" width="45%" />
              <Skeleton variant="text" width="25%" />
            </Box>
          ))}
        </Box>
      </SectionCard>
    )
  }

  return (
    <SectionCard title="Recent activity" action={<ViewAllLink />}>
      {transactions.length === 0 ? (
        <Typography sx={{ fontSize: 13.5, py: 1 }} color="text.disabled">
          No activity yet. Add your first transaction to see it here.
        </Typography>
      ) : (
        <Box>
          {transactions.map((t) => (
            <ActivityRow key={t.id} transaction={t} />
          ))}
        </Box>
      )}
    </SectionCard>
  )
}

export default RecentActivity
