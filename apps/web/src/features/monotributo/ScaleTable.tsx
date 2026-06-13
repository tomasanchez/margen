/**
 * Full official scale table — "Monotributo 2026 — full scale" (ADR-019, ADR-023).
 *
 * The complete A–K AFIP/ARCA scale: category, annual gross-income ceiling, and
 * the servicios / bienes cuotas. The current and projected rows are marked with
 * a text tag ("Current" / "Projected") AND a leading dot glyph (filled vs. open)
 * — distinguished beyond color alone. An external ARCA link (the source of
 * truth) opens in a new tab with rel="noopener noreferrer". Desktop is a 5-column
 * grid; mobile is a compact category/ceiling/cuota list.
 */

import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { monoFontFamily } from '../../theme'
import { formatARS } from '../../lib/format'
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
      {isButton ? 'ARCA · tabla oficial' : 'Ver categorías en arca.gob.ar'}
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
  arcaUrl: string
}

export function ScaleTable({
  scale,
  current,
  projected,
  arcaUrl,
}: ScaleTableProps) {
  return (
    <SectionCard
      title="Monotributo 2026 — full scale"
      subtitle="Escala oficial vigente desde el 1 de febrero de 2026 · próxima revisión jul / ago 2026"
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
        <Box>Cat.</Box>
        <Box>Ingresos brutos anuales</Box>
        <Box sx={{ textAlign: 'right' }}>Cuota · servicios</Box>
        <Box sx={{ textAlign: 'right' }}>Cuota · bienes</Box>
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
        {scale.map((row) => {
          const isCurrent = row.letter === current
          const isProjected = row.letter === projected
          const tag = isCurrent ? 'Current' : isProjected ? 'Projected' : ''
          const tagShort = isCurrent ? 'NOW' : isProjected ? 'PROJ' : ''
          const letterColor = isCurrent
            ? 'var(--mg-text)'
            : isProjected
              ? 'var(--mg-watch)'
              : 'var(--mg-text-2)'
          const rowTint = isCurrent
            ? 'color-mix(in srgb, var(--mg-gold) 10%, transparent)'
            : isProjected
              ? 'color-mix(in srgb, var(--mg-watch) 5%, transparent)'
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
                            : 'var(--mg-border-2)',
                    }}
                  >
                    {isCurrent ? '●' : isProjected ? '○' : '·'}
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
                        color: isCurrent ? 'var(--mg-gold)' : 'var(--mg-watch)',
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
          La cuota incluye componente impositivo, aporte al SIPA y obra social.
          Valores redondeados; montos con centavos en el sitio de ARCA. Desde 2026
          la escala llega hasta la categoría K tanto para servicios como para
          bienes.
        </Typography>
        <ArcaLink href={arcaUrl} variant="text" />
      </Box>
    </SectionCard>
  )
}

export default ScaleTable
