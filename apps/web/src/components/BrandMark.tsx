import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'

/**
 * The margen brand mark — the new favicon icon (ADR-013): the sage "margin"
 * uprights + gold notch on a dark rounded tile. Rendered from the shipped raster
 * asset (`public/android-chrome-192x192.png`) at its 192px source so it stays
 * crisp on retina at this size. Decorative: `aria-hidden` + empty `alt`, with
 * the accessible name carried by the "Margen" wordmark / the surrounding
 * labelled brand link.
 */
export function MargenMark({ size = 26 }: { size?: number }) {
  return (
    <Box
      component="img"
      src="/android-chrome-192x192.png"
      alt=""
      aria-hidden
      width={size}
      height={size}
      sx={{
        width: size,
        height: size,
        display: 'block',
        flex: 'none',
        borderRadius: '7px',
      }}
    />
  )
}

/**
 * Brand mark: the margen glyph (sage margin uprights + gold notch; ADR-013). The
 * "Margen" wordmark is desktop-only on the mobile transparent bar so the left
 * slot reads as a single floating icon (ADR-017); pass `wordmark={false}` to
 * force it off.
 */
export function BrandMark({ wordmark = true }: { wordmark?: boolean }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
      <MargenMark size={26} />
      {wordmark ? (
        <Typography
          component="span"
          sx={{
            // Hidden on the mobile transparent bar; shown from md+ (ADR-017).
            display: { xs: 'none', md: 'block' },
            fontWeight: 600,
            letterSpacing: '-0.01em',
            fontSize: 16,
          }}
          color="text.primary"
        >
          Margen
        </Typography>
      ) : null}
    </Box>
  )
}
