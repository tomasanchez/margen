/**
 * <SectionCard> — the bordered surface every Home section sits on (Issue #12).
 *
 * Mirrors the concept's section panels (1px border, rounded, paper-2 fill) using
 * MUI Paper + theme tokens rather than inline hex, with an optional header row:
 * a title (rendered as a real heading for the section landmark) + subtitle on
 * the left and an optional `action` slot (e.g. a mono total or a "View all"
 * link) on the right.
 */

import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'

export interface SectionCardProps {
  /** Section title; rendered as the section's heading. */
  title?: React.ReactNode
  /** Optional supporting line under the title. */
  subtitle?: React.ReactNode
  /** Heading level for the title (defaults to h2). */
  titleComponent?: 'h2' | 'h3'
  /** Right-aligned header slot (total, link, status pill, …). */
  action?: React.ReactNode
  /** Tinted "highlight" treatment used by the Monotributo card. */
  highlight?: boolean
  /** Inner padding override (theme spacing units). */
  padding?: number
  children?: React.ReactNode
}

/** A padded, bordered panel with an optional title/subtitle/action header. */
export function SectionCard({
  title,
  subtitle,
  titleComponent = 'h2',
  action,
  highlight = false,
  padding = 2.75,
  children,
}: SectionCardProps) {
  const hasHeader = title != null || action != null
  return (
    <Paper
      component="section"
      variant="outlined"
      sx={{
        p: padding,
        borderRadius: '16px',
        bgcolor: 'var(--mg-paper)',
        borderColor: highlight ? 'var(--mg-border-2)' : 'var(--mg-border)',
        ...(highlight
          ? {
              backgroundImage:
                'linear-gradient(180deg, color-mix(in srgb, var(--mg-gold) 5%, transparent), transparent 60%)',
            }
          : {}),
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
      }}
    >
      {hasHeader ? (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 1.5,
            mb: subtitle ? 2 : 1.75,
          }}
        >
          <Box sx={{ minWidth: 0 }}>
            {title != null ? (
              <Typography
                component={titleComponent}
                sx={{ fontSize: 15, fontWeight: 600 }}
                color="text.primary"
              >
                {title}
              </Typography>
            ) : null}
            {subtitle != null ? (
              <Typography
                component="p"
                sx={{ fontSize: 12.5, mt: 0.375 }}
                color="text.disabled"
              >
                {subtitle}
              </Typography>
            ) : null}
          </Box>
          {action != null ? (
            <Box sx={{ flex: 'none' }}>{action}</Box>
          ) : null}
        </Box>
      ) : null}
      {children}
    </Paper>
  )
}

export default SectionCard
