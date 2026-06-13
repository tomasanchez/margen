/**
 * <StatusPill> — Safe / Watch / Risk status conveyed by icon + text + color,
 * never color alone (ADR-019, Apple HIG).
 *
 * Colors come from the semantic design tokens (Safe / Watch / Risk), so the pill
 * stays correct in both light and dark modes. Each status pairs a distinct icon
 * and a text label, so the meaning survives for color-blind users and in
 * grayscale.
 */

import Chip from '@mui/material/Chip'
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import ErrorOutlinedIcon from '@mui/icons-material/ErrorOutlined'
import type { StatusLevel } from '../mock/types'

interface StatusPresentation {
  /** Default visible label for the status. */
  label: string
  /** Semantic design token for the status color. */
  color: string
  icon: React.ReactElement
  /** Spoken description for assistive tech. */
  srDescription: string
}

const PRESENTATION: Record<StatusLevel, StatusPresentation> = {
  safe: {
    label: 'Safe',
    color: 'var(--mg-safe)',
    icon: <CheckCircleOutlinedIcon fontSize="small" />,
    srDescription: 'Status: safe',
  },
  watch: {
    label: 'Watch',
    color: 'var(--mg-watch)',
    icon: <WarningAmberRoundedIcon fontSize="small" />,
    srDescription: 'Status: watch',
  },
  risk: {
    label: 'Risk',
    color: 'var(--mg-risk)',
    icon: <ErrorOutlinedIcon fontSize="small" />,
    srDescription: 'Status: at risk',
  },
}

export interface StatusPillProps {
  /** Which standing to render. */
  status: StatusLevel
  /** Override the visible label (e.g. "On track") while keeping the icon/color. */
  label?: string
  size?: 'small' | 'medium'
  className?: string
}

/**
 * Compact status indicator. Renders the status icon, a text label, and a tinted
 * background derived from the matching semantic token — three independent cues
 * for the same meaning.
 */
export function StatusPill({
  status,
  label,
  size = 'small',
  className,
}: StatusPillProps) {
  const presentation = PRESENTATION[status]
  const visibleLabel = label ?? presentation.label

  return (
    <Chip
      className={className}
      icon={presentation.icon}
      label={visibleLabel}
      size={size}
      variant="outlined"
      role="status"
      aria-label={presentation.srDescription}
      sx={{
        fontWeight: 600,
        color: presentation.color,
        borderColor: presentation.color,
        // Subtle tint of the status color; layered over the surface via
        // color-mix so it adapts to light/dark without a second token.
        backgroundColor: `color-mix(in srgb, ${presentation.color} 14%, transparent)`,
        '& .MuiChip-icon': {
          color: presentation.color,
        },
      }}
    />
  )
}

export default StatusPill
