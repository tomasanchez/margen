/**
 * Full official scale table — "Monotributo 2026 — full scale" (ADR-019, ADR-023).
 *
 * The complete A–K AFIP/ARCA scale: category, annual gross-income ceiling, and
 * the services / goods fees. The current and projected rows are marked with
 * a text tag ("Current" / "Projected") AND a leading dot glyph (filled vs. open)
 * — distinguished beyond color alone. An external ARCA link (the source of
 * truth) opens in a new tab with rel="noopener noreferrer". Desktop is a 5-column
 * grid; mobile is a compact category/ceiling/fee list.
 */

import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { monoFontFamily } from '../../theme'
import { formatARS } from '../../lib/format'
import { localizedIsoDate } from '../../i18n/locale'
import type { MonotributoScaleRow } from '../../mock/types'
import { SectionCard } from '../../components/SectionCard'

const GRID_COLUMNS = '64px minmax(0, 1fr) 150px 150px 120px'

/** External ARCA link (new tab, secured). */
function ArcaLink({
  href,
  variant,
}: {
  href: string
  variant: 'button' | 'text'
}) {
  const { t } = useTranslation('monotributo')
  const isButton = variant === 'button'
  return (
    <Box
      component="a"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: isButton ? 1 : 0.5,
        textDecoration: 'none',
        whiteSpace: 'nowrap',
        fontSize: 13,
        borderRadius: 1,
        ...(isButton
          ? {
              px: 1.75,
              py: 1.125,
              border: '1px solid var(--mg-border-2)',
              bgcolor: 'var(--mg-raised)',
              color: 'text.primary',
            }
          : { color: 'primary.main' }),
        '&:hover': isButton
          ? { borderColor: 'var(--mg-gold)' }
          : { textDecoration: 'underline', textUnderlineOffset: 2 },
        '&:focus-visible': {
          outline: '2px solid',
          outlineColor: 'primary.main',
          outlineOffset: 2,
        },
      }}
    >
      {isButton ? (
        <Box
          aria-hidden
          sx={{ width: 7, height: 7, borderRadius: '2px', bgcolor: 'var(--mg-gold)' }}
        />
      ) : null}
      {isButton ? t('scale.arcaButton') : t('scale.arcaText')}
      <Box component="span" aria-hidden sx={{ color: 'text.disabled' }}>
        ↗
      </Box>
    </Box>
  )
}

export interface ScaleTableProps {
  scale: MonotributoScaleRow[]
  current: string
  projected: string
  /** The recommended best-fit category letter (ADR-200), or undefined. */
  recommended?: string
  /** ISO date (`YYYY-MM-DD`) the in-effect scale vintage started. */
  effectiveFrom: string
  /** ISO date (`YYYY-MM-DD`) of the next scheduled scale review. */
  nextReview: string
  arcaUrl: string
}

export function ScaleTable({
  scale,
  current,
  projected,
  recommended,
  effectiveFrom,
  nextReview,
  arcaUrl,
}: ScaleTableProps) {
  const { t } = useTranslation('monotributo')
  return (
    <SectionCard
      title={t('scale.title')}
      subtitle={t('scale.subtitle', {
        // Data-driven vintage dates, formatted at the render edge (ADR-102) so
        // the subtitle tracks the effective vintage (Feb 2026 today, auto-flips
        // to Aug 2026 on Aug 1) and the active UI language.
        effectiveFrom: localizedIsoDate(effectiveFrom),
        nextReview: localizedIsoDate(nextReview),
      })}
      action={<ArcaLink href={arcaUrl} variant="button" />}
    >
      {/* Desktop table header. */}
      <Box
        aria-hidden
        sx={{
          display: { xs: 'none', md: 'grid' },
          gridTemplateColumns: GRID_COLUMNS,
          gap: 1.5,
          px: 0.75,
          pt: 1.75,
          pb: 1.25,
          fontSize: 10.5,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          fontWeight: 600,
          color: 'var(--mg-text-3)',
          borderBottom: '1px solid var(--mg-border)',
        }}
      >
        <Box>{t('scale.header.cat')}</Box>
        <Box>{t('scale.header.income')}</Box>
        <Box sx={{ textAlign: 'right' }}>{t('scale.header.feeServices')}</Box>
        <Box sx={{ textAlign: 'right' }}>{t('scale.header.feeGoods')}</Box>
        <Box />
      </Box>

      {/* Mobile compact list wrapper (bordered card of rows). */}
      <Box
        component="ul"
        sx={{
          listStyle: 'none',
          m: 0,
          p: 0,
          border: { xs: '1px solid var(--mg-border)', md: 'none' },
          borderRadius: { xs: '13px', md: 0 },
          overflow: 'hidden',
        }}
      >
        {/* Mobile column header (the desktop grid has its own header above). */}
        <Box
          component="li"
          aria-hidden
          sx={{
            display: { xs: 'flex', md: 'none' },
            alignItems: 'center',
            gap: 1.25,
            py: 1,
            px: 1.5,
            borderBottom: '1px solid var(--mg-border)',
            fontSize: 9.5,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            fontWeight: 600,
            color: 'var(--mg-text-3)',
          }}
        >
          <Box component="span" sx={{ width: 22, flex: 'none' }}>
            {t('scale.mobileHeader.cat')}
          </Box>
          <Box component="span" sx={{ flex: 1 }}>
            {t('scale.mobileHeader.income')}
          </Box>
          <Box component="span">{t('scale.mobileHeader.feeServices')}</Box>
          <Box sx={{ width: 42, flex: 'none' }} />
        </Box>

        {scale.map((row) => {
          const isCurrent = row.letter === current
          const isProjected = row.letter === projected
          // Best-fit only tags a row that isn't already current/projected, so
          // the existing tag is never clobbered (ADR-200).
          const isBest =
            recommended != null &&
            row.letter === recommended &&
            !isCurrent &&
            !isProjected
          const tag = isCurrent
            ? t('scale.tagCurrent')
            : isProjected
              ? t('scale.tagProjected')
              : isBest
                ? t('scale.tagBest')
                : ''
          const tagShort = isCurrent
            ? t('scale.tagShortCurrent')
            : isProjected
              ? t('scale.tagShortProjected')
              : isBest
                ? t('scale.tagShortBest')
                : ''
          const letterColor = isCurrent
            ? 'var(--mg-text)'
            : isProjected
              ? 'var(--mg-watch)'
              : isBest
                ? 'var(--mg-text)'
                : 'var(--mg-text-2)'
          const rowTint = isCurrent
            ? 'color-mix(in srgb, var(--mg-gold) 10%, transparent)'
            : isProjected
              ? 'color-mix(in srgb, var(--mg-watch) 5%, transparent)'
              : isBest
                ? 'color-mix(in srgb, var(--mg-gold) 5%, transparent)'
                : 'transparent'

          return (
            <Box component="li" key={row.letter}>
              {/* Desktop row. */}
              <Box
                sx={{
                  display: { xs: 'none', md: 'grid' },
                  gridTemplateColumns: GRID_COLUMNS,
                  gap: 1.5,
                  alignItems: 'center',
                  py: 1.375,
                  px: 0.75,
                  borderBottom: '1px solid var(--mg-border)',
                  bgcolor: rowTint,
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.125 }}>
                  <Box
                    component="span"
                    aria-hidden
                    sx={{
                      fontSize: 9,
                      color:
                        isCurrent
                          ? 'var(--mg-gold)'
                          : isProjected
                            ? 'var(--mg-watch)'
                            : isBest
                              ? 'var(--mg-gold)'
                              : 'var(--mg-border-2)',
                    }}
                  >
                    {isCurrent ? '●' : isProjected ? '○' : isBest ? '◆' : '·'}
                  </Box>
                  <Box
                    component="span"
                    sx={{
                      fontFamily: monoFontFamily,
                      fontSize: 14,
                      fontWeight: 600,
                      color: letterColor,
                    }}
                  >
                    {row.letter}
                  </Box>
                </Box>
                <Box
                  component="span"
                  sx={{
                    fontFamily: monoFontFamily,
                    fontVariantNumeric: 'tabular-nums',
                    fontSize: 13.5,
                    color: isCurrent ? 'var(--mg-text)' : 'var(--mg-text-mid)',
                  }}
                >
                  ARS {formatARS(row.annualCeiling)}
                </Box>
                <Box
                  component="span"
                  sx={{
                    fontFamily: monoFontFamily,
                    fontVariantNumeric: 'tabular-nums',
                    fontSize: 13,
                    textAlign: 'right',
                  }}
                  color="text.secondary"
                >
                  ARS {formatARS(row.cuotaServicios)}
                </Box>
                <Box
                  component="span"
                  sx={{
                    fontFamily: monoFontFamily,
                    fontVariantNumeric: 'tabular-nums',
                    fontSize: 13,
                    textAlign: 'right',
                  }}
                  color="text.disabled"
                >
                  ARS {formatARS(row.cuotaBienes)}
                </Box>
                <Box sx={{ textAlign: 'right' }}>
                  {tag ? (
                    <Box
                      component="span"
                      sx={{
                        display: 'inline-block',
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: '0.04em',
                        textTransform: 'uppercase',
                        px: 1.125,
                        py: 0.375,
                        borderRadius: 999,
                        ...(isCurrent
                          ? {
                              color: 'var(--mg-on-gold)',
                              bgcolor: 'var(--mg-gold)',
                            }
                          : isBest
                            ? {
                                color: 'var(--mg-gold)',
                                border: '1px solid var(--mg-gold)',
                                bgcolor:
                                  'color-mix(in srgb, var(--mg-gold) 10%, transparent)',
                              }
                            : {
                                color: 'var(--mg-watch)',
                                border: '1px solid var(--mg-watch)',
                                bgcolor:
                                  'color-mix(in srgb, var(--mg-watch) 10%, transparent)',
                              }),
                      }}
                    >
                      {tag}
                    </Box>
                  ) : null}
                </Box>
              </Box>

              {/* Mobile row. */}
              <Box
                sx={{
                  display: { xs: 'flex', md: 'none' },
                  alignItems: 'center',
                  gap: 1.25,
                  py: 1.375,
                  px: 1.5,
                  borderBottom: '1px solid var(--mg-border)',
                  bgcolor: rowTint,
                  '&:last-of-type': { borderBottom: 'none' },
                }}
              >
                <Box
                  component="span"
                  sx={{
                    fontFamily: monoFontFamily,
                    fontSize: 13,
                    fontWeight: 600,
                    width: 22,
                    flex: 'none',
                    color: letterColor,
                  }}
                >
                  {row.letter}
                </Box>
                <Box
                  component="span"
                  sx={{
                    flex: 1,
                    fontFamily: monoFontFamily,
                    fontSize: 12,
                    color: isCurrent ? 'var(--mg-text)' : 'var(--mg-text-mid)',
                  }}
                >
                  ARS {formatARS(row.annualCeiling)}
                </Box>
                <Box
                  component="span"
                  sx={{ fontFamily: monoFontFamily, fontSize: 11.5 }}
                  color="text.secondary"
                >
                  {formatARS(row.cuotaServicios)}
                </Box>
                <Box
                  sx={{ width: 42, textAlign: 'right', flex: 'none' }}
                >
                  {tagShort ? (
                    <Box
                      component="span"
                      sx={{
                        fontSize: 9,
                        fontWeight: 700,
                        color: isProjected ? 'var(--mg-watch)' : 'var(--mg-gold)',
                      }}
                    >
                      {tagShort}
                    </Box>
                  ) : null}
                </Box>
              </Box>
            </Box>
          )
        })}
      </Box>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1.25,
          mt: 2,
          flexWrap: 'wrap',
        }}
      >
        <Typography
          sx={{ fontSize: 11.5, lineHeight: 1.5, maxWidth: 560, textWrap: 'pretty' }}
          color="text.disabled"
        >
          {t('scale.footnote')}
        </Typography>
        <ArcaLink href={arcaUrl} variant="text" />
      </Box>
    </SectionCard>
  )
}

export default ScaleTable
