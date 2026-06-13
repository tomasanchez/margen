import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'
import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined'
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined'
import { useColorMode } from '../theme/colorModeContext'

/**
 * Dark/light color-mode toggle (ADR-013, ADR-019).
 *
 * Renders the icon for the mode the user would switch *to* and exposes an
 * explicit accessible label — state is conveyed by icon + label, never by color
 * alone. The shell places this in the top bar later; exported standalone here.
 */
export function ColorModeToggle() {
  const { mode, toggle } = useColorMode()
  const next = mode === 'dark' ? 'light' : 'dark'
  const label = `Switch to ${next} mode`

  return (
    <Tooltip title={label}>
      <IconButton onClick={toggle} aria-label={label} color="inherit" size="small">
        {mode === 'dark' ? (
          <LightModeOutlinedIcon fontSize="small" />
        ) : (
          <DarkModeOutlinedIcon fontSize="small" />
        )}
      </IconButton>
    </Tooltip>
  )
}

export default ColorModeToggle
