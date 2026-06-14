/**
 * "Where it went" — the current-month category breakdown (Issue #12).
 *
 * One row per category: the name (with a Watch-toned "+N%" badge when it rose
 * vs. last month), the ARS amount (mono, via format), and a proportional CSS
 * bar. The badge pairs its color with the explicit percentage text, never color
 * alone (ADR-019). Bars scale against the largest category so the leader fills
 * the track. Long category names truncate with an ellipsis (ADR-020).
 *
 * Each row is a router link that drills into the Transactions screen pre-filtered
 * to that category (`/transactions?category=<name>`, ADR-062), so a category
 * total is directly explainable. The link carries an explicit accessible name
 * and a visible focus ring (HIG); hover lifts it gently.
 */

import Box from '@mui/material/Box'
import Skeleton from '@mui/material/Skeleton'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { Link } from '@tanstack/react-router'
import { monoFontFamily } from '../../theme'
import { formatCurrency } from '../../lib/format'
import { useDisplayMoney } from '../settings/displayCurrencyContext'
import type { CategorySpend } from '../../mock/types'
import { SectionCard } from '../../components/SectionCard'

/**
 * CSS class (defined in `index.css` with the shared --mg-* tokens) for the
 * clickable category row. The row is a BARE TanStack {@link Link} — not
 * `Box component={Link}` — so the typed `to` / `search` inference is preserved
 * and `search={{ category }}` is checked against the route's search schema
 * (ADR-062). The visual block/hover/focus styling lives in the class.
 */
const categoryRowLinkClass = 'mg-category-row-link'

export interface CategoryBreakdownProps {
  categories: CategorySpend[] | undefined
  loading?: boolean
}

/**
 * Reserved body height for the card so it keeps its populated footprint in every
 * state (loading skeleton, empty, populated) and never collapses or jumps as the
 * user navigates between months with and without data. Sized to the typical
 * 6–7 category rows: ~34px per row (label line + bar) plus ~15px row spacing.
 */
const BODY_MIN_HEIGHT = 280

function CategoryRow({
  row,
  maxPct,
  formatMoney,
}: {
  row: CategorySpend
  maxPct: number
  /** Currency-aware money formatter from the display-currency context (ADR-056). */
  formatMoney: (ars: number | null | undefined) => string
}) {
  const widthPct = maxPct > 0 ? Math.min((row.pct / maxPct) * 100, 100) : 0
  const rose = Boolean(row.up)
  // The accessible name spells out the action + the literal ARS amount so the
  // link reads clearly to screen readers regardless of the display currency.
  const linkLabel = `${row.category}, ${formatCurrency(
    row.amount,
    'ARS',
  )}${row.up ? `, up ${row.up}` : ''} — view transactions`
  return (
    <Link
      to="/transactions"
      search={{ category: row.category }}
      aria-label={linkLabel}
      className={categoryRowLinkClass}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1.5,
          mb: 0.875,
          minWidth: 0,
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            minWidth: 0,
          }}
        >
          <Typography
            component="span"
            sx={{
              fontSize: 13.5,
              color: 'var(--mg-text-mid)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            {row.category}
          </Typography>
          {rose ? (
            <Box
              component="span"
              sx={{
                flex: 'none',
                fontFamily: monoFontFamily,
                fontSize: 11,
                color: 'var(--mg-watch)',
                bgcolor:
                  'color-mix(in srgb, var(--mg-watch) 12%, transparent)',
                px: 0.875,
                py: '2px',
                borderRadius: '6px',
              }}
            >
              {row.up}
            </Box>
          ) : null}
        </Box>
        <Typography
          component="span"
          sx={{
            fontFamily: monoFontFamily,
            fontVariantNumeric: 'tabular-nums',
            fontSize: 13,
            color: 'text.secondary',
            whiteSpace: 'nowrap',
            flex: 'none',
          }}
        >
          {formatMoney(row.amount)}
        </Typography>
      </Box>
      <Box
        aria-hidden
        sx={{
          height: 8,
          bgcolor: 'var(--mg-raised)',
          borderRadius: '5px',
          overflow: 'hidden',
        }}
      >
        <Box
          sx={{
            height: '100%',
            width: `${widthPct}%`,
            borderRadius: '5px',
            bgcolor: rose ? 'var(--mg-gold-hover)' : 'var(--mg-gold)',
            transition: 'width 240ms ease',
          }}
        />
      </Box>
    </Link>
  )
}

export function CategoryBreakdown({
  categories,
  loading = false,
}: CategoryBreakdownProps) {
  const formatMoney = useDisplayMoney()

  if (loading || !categories) {
    return (
      <SectionCard
        title="Where it went"
        subtitle="June · share of spending"
        minHeight={BODY_MIN_HEIGHT}
      >
        <Stack spacing={1.875}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Box key={i}>
              <Skeleton variant="text" width="60%" />
              <Skeleton
                variant="rounded"
                height={8}
                sx={{ borderRadius: '5px' }}
              />
            </Box>
          ))}
        </Stack>
      </SectionCard>
    )
  }

  if (categories.length === 0) {
    return (
      <SectionCard
        title="Where it went"
        subtitle="June · share of spending"
        minHeight={BODY_MIN_HEIGHT}
      >
        <Box
          sx={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
          }}
        >
          <Typography sx={{ fontSize: 13.5 }} color="text.disabled">
            No spending recorded for this month yet.
          </Typography>
        </Box>
      </SectionCard>
    )
  }

  const maxPct = categories.reduce((max, c) => Math.max(max, c.pct), 0)

  return (
    <SectionCard
      title="Where it went"
      subtitle="June · share of spending"
      minHeight={BODY_MIN_HEIGHT}
    >
      <Stack spacing={1.875}>
        {categories.map((row) => (
          <CategoryRow
            key={row.category}
            row={row}
            maxPct={maxPct}
            formatMoney={formatMoney}
          />
        ))}
      </Stack>
    </SectionCard>
  )
}

export default CategoryBreakdown
