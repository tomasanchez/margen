import { useTranslation } from 'react-i18next'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined'
import ErrorOutlinedIcon from '@mui/icons-material/ErrorOutlined'
import { useReadiness } from '../api/useReadiness'
import {
  deriveConnectionState,
  type ConnectionState,
} from './connectionState'

interface StatePresentation {
  /** i18n key (common ns) for the visible label. */
  labelKey: string
  color: 'default' | 'success' | 'error'
  icon: React.ReactElement
  /** i18n key (common ns) for the screen-reader description. */
  srKey: string
}

const PRESENTATION: Record<ConnectionState, StatePresentation> = {
  connecting: {
    labelKey: 'connection.connecting',
    color: 'default',
    icon: <CircularProgress size={14} thickness={5} color="inherit" />,
    srKey: 'connection.srConnecting',
  },
  connected: {
    labelKey: 'connection.connected',
    color: 'success',
    icon: <CheckCircleOutlinedIcon fontSize="small" />,
    srKey: 'connection.srConnected',
  },
  error: {
    labelKey: 'connection.unreachable',
    color: 'error',
    icon: <ErrorOutlinedIcon fontSize="small" />,
    srKey: 'connection.srUnreachable',
  },
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
  const { t } = useTranslation('common')
  const query = useReadiness()
  const state = deriveConnectionState(query)
  const { labelKey, color, icon, srKey } = PRESENTATION[state]

  return (
    <Chip
      icon={icon}
      label={t(labelKey)}
      color={color}
      variant="outlined"
      size="small"
      role="status"
      aria-live="polite"
      aria-label={t(srKey)}
      sx={{ fontWeight: 600 }}
    />
  )
}

export default ConnectionStatus
