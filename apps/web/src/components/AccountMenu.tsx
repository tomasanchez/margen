import { useId, useState, type ElementType, type MouseEvent } from 'react'
import Avatar from '@mui/material/Avatar'
import Box from '@mui/material/Box'
import Divider from '@mui/material/Divider'
import Drawer from '@mui/material/Drawer'
import IconButton from '@mui/material/IconButton'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Switch from '@mui/material/Switch'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { useMediaQuery, useTheme } from '@mui/material'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined'
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined'
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined'
import LogoutOutlinedIcon from '@mui/icons-material/LogoutOutlined'
import { useColorMode } from '../theme/colorModeContext'
import { MOCK_USER } from '../mock/user'

/**
 * Identity header (name + email). Shared by the desktop Menu and the mobile
 * Drawer so the two account surfaces never drift.
 */
function AccountIdentity() {
  return (
    <Box>
      <Typography
        variant="body2"
        sx={{ fontWeight: 600, lineHeight: 1.3 }}
        color="text.primary"
      >
        {MOCK_USER.name}
      </Typography>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', lineHeight: 1.3 }}
      >
        {MOCK_USER.email}
      </Typography>
    </Box>
  )
}

/**
 * The interactive account rows (theme switch + inert Settings/Sign out
 * placeholders). The row element is parameterized via `Row` so the desktop
 * surface uses `MenuItem` (proper Menu keyboard semantics) while the mobile
 * Drawer uses `ListItemButton` — `MenuItem` requires a `MenuList` parent and
 * throws "MenuListContext is missing" if rendered in the Drawer. State is
 * conveyed by icon + Switch, never by color alone (ADR-019); Settings and Sign
 * out are inert because settings and auth are non-goals for the prototype
 * (ADR-012).
 */
function AccountActions({
  isDark,
  onToggleTheme,
  Row,
}: {
  isDark: boolean
  onToggleTheme: () => void
  Row: ElementType
}) {
  return (
    <>
      <Row
        onClick={onToggleTheme}
        sx={{ py: { xs: 1.75, md: 1 } }}
        aria-label={`Dark mode ${isDark ? 'on' : 'off'}`}
      >
        <ListItemIcon>
          {isDark ? (
            <DarkModeOutlinedIcon fontSize="small" />
          ) : (
            <LightModeOutlinedIcon fontSize="small" />
          )}
        </ListItemIcon>
        <ListItemText primary="Dark mode" />
        <Switch
          edge="end"
          size="small"
          checked={isDark}
          onClick={(event) => event.stopPropagation()}
          onChange={onToggleTheme}
          slotProps={{ input: { 'aria-label': 'Toggle dark mode' } }}
        />
      </Row>

      <Divider />

      {/* Inert placeholder — settings are a non-goal for the prototype (ADR-012). */}
      <Row disabled title="Settings — coming soon" sx={{ py: { xs: 1.75, md: 1 } }}>
        <ListItemIcon>
          <SettingsOutlinedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText primary="Settings" />
      </Row>

      {/* Inert placeholder — auth (sign out) is a non-goal (ADR-012). */}
      <Row
        disabled
        title="Sign out — coming soon"
        sx={{
          py: { xs: 1.75, md: 1 },
          '&.Mui-disabled': { color: 'error.main', opacity: 0.5 },
        }}
      >
        <ListItemIcon sx={{ color: 'inherit' }}>
          <LogoutOutlinedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText primary="Sign out" />
      </Row>
    </>
  )
}

/**
 * Top-bar account menu (ADR-012, ADR-017, ADR-019).
 *
 * The avatar is a real button that opens the account surface, which branches on
 * breakpoint:
 *
 * - Desktop (md+): an MUI Menu anchored to the avatar (unchanged). MUI handles
 *   the focus trap + restoration; the trigger carries `aria-haspopup="menu"`.
 * - Mobile (xs–sm): a full-screen right Drawer (iOS-style) with a titled header
 *   + close button, the identity block, then the same actions. The Drawer traps
 *   focus, restores it to the avatar on close, and closes on Escape (MUI
 *   built-ins) — satisfying ADR-019. The trigger reports `aria-haspopup="dialog"`.
 *
 * Both surfaces reuse {@link AccountIdentity} and {@link AccountActions} so the
 * content never drifts between them. The theme switch is wired to
 * {@link useColorMode} (state conveyed by icon + Switch, never color alone).
 */
export function AccountMenu() {
  const { mode, toggle } = useColorMode()
  const theme = useTheme()
  const isMobile = useMediaQuery(theme.breakpoints.down('md'))

  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const open = isMobile ? drawerOpen : Boolean(anchorEl)
  const surfaceId = useId()

  const handleOpen = (event: MouseEvent<HTMLElement>) => {
    if (isMobile) {
      setDrawerOpen(true)
    } else {
      setAnchorEl(event.currentTarget)
    }
  }
  const handleClose = () => {
    setAnchorEl(null)
    setDrawerOpen(false)
  }

  const isDark = mode === 'dark'

  return (
    <>
      <Tooltip title="Account menu">
        <IconButton
          onClick={handleOpen}
          aria-label="Account menu"
          aria-haspopup={isMobile ? 'dialog' : 'menu'}
          aria-controls={open ? surfaceId : undefined}
          aria-expanded={open ? 'true' : undefined}
          size="small"
          sx={{
            p: 0.25,
            '&:focus-visible': {
              outline: '2px solid',
              outlineColor: 'primary.main',
              outlineOffset: 2,
            },
          }}
        >
          <Avatar
            sx={{
              width: 34,
              height: 34,
              bgcolor: 'action.selected',
              color: 'primary.main',
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {MOCK_USER.initials}
          </Avatar>
        </IconButton>
      </Tooltip>

      {/* Desktop (md+): anchored dropdown menu — unchanged behavior. */}
      <Menu
        id={surfaceId}
        anchorEl={anchorEl}
        open={!isMobile && Boolean(anchorEl)}
        onClose={handleClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{
          paper: {
            elevation: 0,
            sx: {
              mt: 1,
              minWidth: 260,
              borderRadius: 2,
              border: 1,
              borderColor: 'divider',
              bgcolor: 'background.paper',
              boxShadow: '0 12px 32px -12px rgba(0,0,0,0.45)',
              overflow: 'visible',
            },
          },
          list: { sx: { py: 0.5 } },
        }}
      >
        <Box sx={{ px: 2, py: 1.25 }}>
          <AccountIdentity />
        </Box>

        <Divider />

        <AccountActions isDark={isDark} onToggleTheme={toggle} Row={MenuItem} />
      </Menu>

      {/* Mobile (xs–sm): full-screen right drawer (iOS-style). */}
      <Drawer
        id={surfaceId}
        anchor="right"
        open={isMobile && drawerOpen}
        onClose={handleClose}
        aria-labelledby={`${surfaceId}-title`}
        slotProps={{
          paper: {
            sx: {
              width: '100%',
              height: '100dvh',
              bgcolor: 'background.paper',
              borderRadius: 0,
              border: 'none',
            },
          },
        }}
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          {/* Titled header with a close affordance (iOS sheet pattern). */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              px: 2.5,
              py: 2,
              borderBottom: 1,
              borderColor: 'divider',
              pt: 'calc(16px + env(safe-area-inset-top))',
            }}
          >
            <Typography
              id={`${surfaceId}-title`}
              component="h2"
              sx={{ fontWeight: 600, fontSize: 18, letterSpacing: '-0.01em' }}
              color="text.primary"
            >
              Account
            </Typography>
            <IconButton
              onClick={handleClose}
              aria-label="Close account"
              sx={{
                '&:focus-visible': {
                  outline: '2px solid',
                  outlineColor: 'primary.main',
                  outlineOffset: 2,
                },
              }}
            >
              <CloseRoundedIcon />
            </IconButton>
          </Box>

          {/* Identity block. */}
          <Box sx={{ px: 2.5, py: 2.5 }}>
            <AccountIdentity />
          </Box>

          <Divider />

          {/* Same actions as desktop, with roomier mobile tap targets. */}
          <List
            component="div"
            sx={{
              flex: 1,
              overflowY: 'auto',
              pt: 0.5,
              pb: 'calc(16px + env(safe-area-inset-bottom))',
            }}
          >
            <AccountActions
              isDark={isDark}
              onToggleTheme={toggle}
              Row={ListItemButton}
            />
          </List>
        </Box>
      </Drawer>
    </>
  )
}

export default AccountMenu
