/**
 * Category ladder — "Where you land on the scale" (ADR-019, ADR-023).
 *
 * A horizontal A–K strip of cells showing each category's compact ceiling. The
 * current category is highlighted gold and the projected one dashed amber, but
 * both are ALSO marked with a text tag above the cell ("Now" / "Proj.") so the
 * distinction never depends on color alone. Each cell carries an accessible
 * label describing the category, its role, and its ceiling.
 */

import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { monoFontFamily } from '../../theme'
import { formatMillionsCompact } from '../../lib/format'
import type { MonotributoScaleRow } from '../../mock/types'
import { SectionCard } from '../../components/SectionCard'

export interface CategoryLadderProps {
  scale: MonotributoScaleRow[]
  /** Current category letter. */
  current: string
  /** Projected category letter. */
  projected: string
}

export function CategoryLadder({
  scale,
  current,
  projected,
}: CategoryLadderProps) {
  return (
    <SectionCard
      title="Where you land on the scale"
      subtitle="Annual gross-income ceiling per category"
    >
      <Box
        component="ol"
        sx={{
          display: 'flex',
          gap: 0.625,
          listStyle: 'none',
          m: 0,
          p: 0,
        }}
      >
        {scale.map((row) => {
          const isCurrent = row.letter === current
          const isProjected = row.letter === projected
          const tag = isCurrent ? 'Now' : isProjected ? 'Proj.' : ''
          const ceilingLabel = formatMillionsCompact(row.annualCeiling)
          const role = isCurrent
            ? 'current category'
            : isProjected
              ? 'projected category'
              : 'category'

          return (
            <Box
              component="li"
              key={row.letter}
              aria-label={`Category ${row.letter}, ${role}, ceiling ${ceilingLabel}`}
              sx={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                minWidth: 0,
              }}
            >
              <Typography
                aria-hidden
                component="span"
                sx={{
                  height: 16,
                  fontSize: 9,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  fontWeight: 700,
                  color: isCurrent
                    ? 'var(--mg-gold)'
                    : isProjected
                      ? 'var(--mg-watch)'
                      : 'transparent',
                }}
              >
                {tag}
              </Typography>
              <Box
                aria-hidden
                sx={{
                  width: '100%',
                  height: 46,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '10px',
                  fontFamily: monoFontFamily,
                  fontWeight: isCurrent || isProjected ? 700 : 600,
                  fontSize: isCurrent || isProjected ? 18 : 16,
                  ...(isCurrent
                    ? {
                        color: 'var(--mg-on-gold)',
                        backgroundImage:
                          'linear-gradient(180deg, var(--mg-gold-hover), var(--mg-gold))',
                      }
                    : isProjected
                      ? {
                          color: 'var(--mg-watch)',
                          bgcolor:
                            'color-mix(in srgb, var(--mg-watch) 8%, transparent)',
                          border: '1px dashed var(--mg-watch)',
                        }
                      : {
                          color: 'var(--mg-text-2)',
                          bgcolor: 'var(--mg-raised)',
                          border: '1px solid var(--mg-border-2)',
                        }),
                }}
              >
                {row.letter}
              </Box>
              <Typography
                aria-hidden
                component="span"
                sx={{
                  fontFamily: monoFontFamily,
                  fontSize: 10.5,
                  mt: 0.875,
                }}
                color="text.disabled"
              >
                {ceilingLabel}
              </Typography>
            </Box>
          )
        })}
      </Box>
    </SectionCard>
  )
}

export default CategoryLadder
