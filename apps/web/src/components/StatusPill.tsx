/**
 * <StatusPill> — Safe / Watch / Risk status conveyed by icon + text + color,
 * never color alone (ADR-019, Apple HIG).
 *
 * Colors come from the semantic design tokens (Safe / Watch / Risk), so the pill
 * stays correct in both light and dark modes. Each status pairs a distinct icon
 * and a text label, so the meaning survives for color-blind users and in
 * grayscale.
 */

import { useTranslation } from 'react-i18next'
import Chip from '@mui/material/Chip'
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import ErrorOutlinedIcon from '@mui/icons-material/ErrorOutlined'
import type { StatusLevel } from '../mock/types'

interface StatusPresentation {
  /** i18n key (common ns) for the default visible label. */
  labelKey: string
  /** Semantic design token for the status color. */
  color: string
  icon: React.ReactElement
  /** i18n key (common ns) for the spoken description. */
  srKey: string
}

const PRESENTATION: Record<StatusLevel, StatusPresentation> = {
  safe: {
    labelKey: 'status.safe',
    color: 'var(--mg-safe)',
    icon: <CheckCircleOutlinedIcon fontSize="small" />,
    srKey: 'statusDescription.safe',
  },
  watch: {
    labelKey: 'status.watch',
    color: 'var(--mg-watch)',
    icon: <WarningAmberRoundedIcon fontSize="small" />,
    srKey: 'statusDescription.watch',
  },
  close: {
    labelKey: 'status.close',
    color: 'var(--mg-watch)',
    icon: <WarningAmberRoundedIcon fontSize="small" />,
    srKey: 'statusDescription.close',
  },
  over: {
    labelKey: 'status.over',
    color: 'var(--mg-risk)',
    icon: <ErrorOutlinedIcon fontSize="small" />,
    srKey: 'statusDescription.over',
  },
  risk: {
    labelKey: 'status.risk',
    color: 'var(--mg-risk)',
    icon: <ErrorOutlinedIcon fontSize="small" />,
    srKey: 'statusDescription.risk',
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
  const { t } = useTranslation('common')
  const presentation = PRESENTATION[status]
  const visibleLabel = label ?? t(presentation.labelKey)

  return (
    <Chip
      className={className}
      icon={presentation.icon}
      label={visibleLabel}
      size={size}
      variant="outlined"
      role="status"
      aria-label={t(presentation.srKey)}
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
