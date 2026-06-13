import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined'
import ErrorOutlinedIcon from '@mui/icons-material/ErrorOutlined'
import { useReadiness } from '../api/useReadiness'

type ConnectionState = 'connecting' | 'connected' | 'error'

interface StatePresentation {
  label: string
  color: 'default' | 'success' | 'error'
  icon: React.ReactElement
  /** Description appended to the accessible label for screen readers. */
  srDescription: string
}

const PRESENTATION: Record<ConnectionState, StatePresentation> = {
  connecting: {
    label: 'Connecting…',
    color: 'default',
    icon: <CircularProgress size={14} thickness={5} color="inherit" />,
    srDescription: 'Checking backend connection',
  },
  connected: {
    label: 'Backend connected',
    color: 'success',
    icon: <CheckCircleOutlinedIcon fontSize="small" />,
    srDescription: 'Backend connected',
  },
  error: {
    label: 'Backend unreachable',
    color: 'error',
    icon: <ErrorOutlinedIcon fontSize="small" />,
    srDescription: 'Backend unreachable',
  },
}

/**
 * Derive the discrete connection state from the readiness query flags.
 *
 * Exported so tests can exercise the mapping directly, and to keep the
 * component a thin presentation layer over {@link useReadiness}.
 */
export function deriveConnectionState(query: {
  isSuccess: boolean
  isError: boolean
}): ConnectionState {
  if (query.isSuccess) return 'connected'
  if (query.isError) return 'error'
  return 'connecting'
}

/**
 * Live backend connection indicator (ADR-006).
 *
 * Renders one of three restrained states — connecting, connected, error —
 * driven by the polling readiness query. State is conveyed by icon + text, not
 * color alone (Apple HIG / accessibility), and the chip exposes a status role
 * so assistive tech announces changes.
 */
export function ConnectionStatus() {
  const query = useReadiness()
  const state = deriveConnectionState(query)
  const { label, color, icon, srDescription } = PRESENTATION[state]

  return (
    <Chip
      icon={icon}
      label={label}
      color={color}
      variant="outlined"
      size="small"
      role="status"
      aria-live="polite"
      aria-label={srDescription}
      sx={{ fontWeight: 600 }}
    />
  )
}

export default ConnectionStatus
