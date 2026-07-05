/**
 * <SectionCard> — the bordered surface every feature section sits on
 * (Issue #12, promoted to a shared component for cross-feature reuse: Home and
 * Monotributo both compose it, ADR-023).
 *
 * Mirrors the concept's section panels (1px border, rounded, paper fill) using
 * MUI Paper + theme tokens rather than inline hex, with an optional header row:
 * a title (rendered as a real heading for the section landmark) + subtitle on
 * the left and an optional `action` slot (e.g. a mono total or a "View all"
 * link) on the right.
 *
 * OPT-IN COLLAPSIBILITY (ADR-019): passing `collapsible` turns the header title
 * into a real disclosure button (`aria-expanded` / `aria-controls`, keyboard
 * operable) with a chevron that rotates, and wraps the body in a MUI
 * {@link Collapse}. It is fully opt-in — omit `collapsible` and the card renders
 * exactly as before, so the many non-collapsible usages across the app are
 * unaffected. The higher-level {@link CollapsibleSection} wires the persisted
 * state + aria copy on top of this.
 */

import { useId } from 'react'
import Box from '@mui/material/Box'
import Collapse from '@mui/material/Collapse'
import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'

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
  /**
   * Reserve a minimum height for the card body (the area below the header),
   * so a section keeps its populated footprint even when its data is empty
   * and the card never collapses or jumps between states (any CSS length).
   */
  minHeight?: number | string
  /**
   * Opt into a collapsible body (ADR-019). When set, the header title becomes a
   * disclosure button with a rotating chevron and the body is wrapped in a MUI
   * Collapse. Omit for the default (non-collapsible) card. The parent OWNS the
   * open/closed state so it can persist it; this component is controlled.
   */
  collapsible?: boolean
  /** Controlled collapsed state (only read when `collapsible`). */
  collapsed?: boolean
  /** Toggle handler invoked when the disclosure button is activated. */
  onToggleCollapsed?: () => void
  /**
   * Accessible label for the disclosure button, reflecting the next action
   * (e.g. "Collapse Debts" / "Expand Debts"). Non-color status cue (ADR-019).
   */
  toggleAriaLabel?: string
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
  minHeight,
  collapsible = false,
  collapsed = false,
  onToggleCollapsed,
  toggleAriaLabel,
  children,
}: SectionCardProps) {
  const hasHeader = title != null || action != null
  // A stable id linking the disclosure button to the region it controls.
  const bodyId = useId()
  const expanded = !collapsed
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
            {title != null && collapsible ? (
              // The title IS the disclosure toggle (ADR-019): a real button with
              // aria-expanded reflecting state, aria-controls pointing at the
              // body region, and a decorative (aria-hidden) chevron that rotates.
              // Keyboard-operable for free (native button); focus stays on it.
              <Box
                component="button"
                type="button"
                onClick={onToggleCollapsed}
                aria-expanded={expanded}
                aria-controls={bodyId}
                aria-label={toggleAriaLabel}
                sx={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 0.5,
                  m: 0,
                  p: 0,
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer',
                  color: 'inherit',
                  font: 'inherit',
                  textAlign: 'left',
                  minWidth: 0,
                  borderRadius: '6px',
                  '&:focus-visible': {
                    outline: '2px solid',
                    outlineColor: 'primary.main',
                    outlineOffset: 2,
                  },
                }}
              >
                <ExpandMoreIcon
                  aria-hidden
                  sx={{
                    fontSize: 20,
                    color: 'text.secondary',
                    transition: 'transform 150ms',
                    transform: expanded ? 'none' : 'rotate(-90deg)',
                    '@media (prefers-reduced-motion: reduce)': {
                      transition: 'none',
                    },
                  }}
                />
                <Typography
                  component={titleComponent}
                  sx={{ fontSize: 15, fontWeight: 600, m: 0 }}
                  color="text.primary"
                >
                  {title}
                </Typography>
              </Box>
            ) : title != null ? (
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
      {collapsible ? (
        <Collapse in={expanded} unmountOnExit>
          <Box
            id={bodyId}
            sx={
              minHeight != null
                ? {
                    minWidth: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    minHeight,
                  }
                : { minWidth: 0 }
            }
          >
            {children}
          </Box>
        </Collapse>
      ) : minHeight != null ? (
        <Box
          sx={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            minHeight,
          }}
        >
          {children}
        </Box>
      ) : (
        children
      )}
    </Paper>
  )
}

export default SectionCard
