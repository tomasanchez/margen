/**
 * Category ladder — "Where you land on the scale" (ADR-019, ADR-023).
 *
 * A horizontal A–K strip of cells showing each category's compact ceiling. The
 * current category is highlighted gold and the projected one dashed amber, but
 * both are ALSO marked with a text tag above the cell ("Now" / "Proj.") so the
 * distinction never depends on color alone. Each cell carries an accessible
 * label describing the category, its role, and its ceiling.
 *
 * Responsive (ADR-017): the full A–K strip is too cramped to read on phones, so
 * on `xs` we render only the *anchor* cells — the lowest (A) and highest (K)
 * categories plus the current and projected ones (deduped, kept in A→K scale
 * order). Where those anchors are non-contiguous a subtle "…" gap glyph hints at
 * the omitted categories. `md`+ keeps the complete ladder unchanged. Both strips
 * live in the DOM and are toggled with the `display: { xs, md }` breakpoint
 * pattern; tests pick a strip via its `data-variant` hook since jsdom does not
 * evaluate media queries.
 */

import { useTranslation } from 'react-i18next'
import { visuallyHidden } from '@mui/utils'
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
  /** Recommended best-fit category letter (ADR-200), or undefined. */
  recommended?: string
}

/**
 * Pick the condensed mobile anchors: the lowest (first) and highest (last) scale
 * entries plus the current and projected categories. Deduped and kept in the
 * original scale order by filtering the scale array (never re-sorted). Empty
 * scale yields an empty set.
 */
function selectAnchors(
  scale: MonotributoScaleRow[],
  current: string,
  projected: string,
  recommended: string | undefined,
): MonotributoScaleRow[] {
  if (scale.length === 0) return []
  const lowest = scale[0].letter
  const highest = scale[scale.length - 1].letter
  const keep = new Set([lowest, highest, current, projected])
  // Keep the best-fit anchor so it survives the condensed mobile strip (ADR-200).
  if (recommended != null) keep.add(recommended)
  return scale.filter((row) => keep.has(row.letter))
}

interface LadderCellProps {
  row: MonotributoScaleRow
  isCurrent: boolean
  isProjected: boolean
  isBest: boolean
}

/** One ladder cell (tag · letter chip · ceiling). Shared by both strips. */
function LadderCell({ row, isCurrent, isProjected, isBest }: LadderCellProps) {
  const { t } = useTranslation('monotributo')
  const tag = isCurrent
    ? t('ladder.tagNow')
    : isProjected
      ? t('ladder.tagProjected')
      : isBest
        ? t('ladder.tagBest')
        : ''
  const ceilingLabel = formatMillionsCompact(row.annualCeiling)
  const role = isCurrent
    ? t('ladder.roleCurrent')
    : isProjected
      ? t('ladder.roleProjected')
      : isBest
        ? t('ladder.roleBest')
        : t('ladder.roleCategory')

  return (
    <Box
      component="li"
      aria-label={t('ladder.cellAriaLabel', {
        letter: row.letter,
        role,
        ceiling: ceilingLabel,
      })}
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
              : isBest
                ? 'var(--mg-gold)'
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
          fontWeight: isCurrent || isProjected || isBest ? 700 : 600,
          fontSize: isCurrent || isProjected || isBest ? 18 : 16,
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
              : isBest
                ? {
                    color: 'var(--mg-gold)',
                    bgcolor:
                      'color-mix(in srgb, var(--mg-gold) 8%, transparent)',
                    border: '1px solid var(--mg-gold)',
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
}

interface LadderStripProps {
  rows: MonotributoScaleRow[]
  current: string
  projected: string
  recommended: string | undefined
  /** Test/identification hook + whether gaps between anchors are flagged. */
  variant: 'full' | 'condensed'
  display: { xs: string; md: string }
}

/** A horizontal strip of ladder cells (full A–K or the condensed anchor set). */
function LadderStrip({
  rows,
  current,
  projected,
  recommended,
  variant,
  display,
}: LadderStripProps) {
  const { t } = useTranslation('monotributo')
  // For the condensed strip, detect non-contiguous anchors against the full
  // scale order so we can drop a subtle "…" hint between the gaps.
  return (
    <Box
      component="ol"
      data-variant={variant}
      sx={{
        display,
        alignItems: 'stretch',
        gap: 0.625,
        listStyle: 'none',
        m: 0,
        p: 0,
      }}
    >
      {rows.map((row, index) => {
        const isCurrent = row.letter === current
        const isProjected = row.letter === projected
        // Best-fit never clobbers the current/projected marker (ADR-200).
        const isBest =
          recommended != null &&
          row.letter === recommended &&
          !isCurrent &&
          !isProjected
        // A gap exists when consecutive condensed anchors skip alphabet letters.
        const prev = index > 0 ? rows[index - 1] : null
        const hasGapBefore =
          variant === 'condensed' &&
          prev != null &&
          row.letter.charCodeAt(0) - prev.letter.charCodeAt(0) > 1

        return [
          hasGapBefore ? (
            <Box
              component="li"
              key={`gap-${row.letter}`}
              sx={{
                flex: '0 0 auto',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                alignSelf: 'center',
                color: 'text.disabled',
                fontWeight: 700,
              }}
            >
              <Box component="span" aria-hidden>
                …
              </Box>
              <Box component="span" sx={visuallyHidden}>
                {t('ladder.gapNote')}
              </Box>
            </Box>
          ) : null,
          <LadderCell
            key={row.letter}
            row={row}
            isCurrent={isCurrent}
            isProjected={isProjected}
            isBest={isBest}
          />,
        ]
      })}
    </Box>
  )
}

export function CategoryLadder({
  scale,
  current,
  projected,
  recommended,
}: CategoryLadderProps) {
  const { t } = useTranslation('monotributo')
  const anchors = selectAnchors(scale, current, projected, recommended)

  return (
    <SectionCard
      title={t('ladder.title')}
      subtitle={t('ladder.subtitle')}
    >
      {/* Mobile: condensed anchor set only (lowest · max · current · projected). */}
      <LadderStrip
        rows={anchors}
        current={current}
        projected={projected}
        recommended={recommended}
        variant="condensed"
        display={{ xs: 'flex', md: 'none' }}
      />
      {/* Desktop: the full A–K ladder, unchanged. */}
      <LadderStrip
        rows={scale}
        current={current}
        projected={projected}
        recommended={recommended}
        variant="full"
        display={{ xs: 'none', md: 'flex' }}
      />
    </SectionCard>
  )
}

export default CategoryLadder
