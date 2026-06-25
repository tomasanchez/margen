import {
  useId,
  useState,
  type ElementType,
  type MouseEvent,
  type SyntheticEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
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
import Select, { type SelectChangeEvent } from '@mui/material/Select'
import Switch from '@mui/material/Switch'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { useMediaQuery, useTheme } from '@mui/material'
import { useNavigate } from '@tanstack/react-router'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined'
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined'
import TranslateOutlinedIcon from '@mui/icons-material/TranslateOutlined'
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined'
import LogoutOutlinedIcon from '@mui/icons-material/LogoutOutlined'
import type { User } from '@supabase/supabase-js'
import { useColorMode } from '../theme/colorModeContext'
import { useLanguage } from '../i18n/languageContext'
import type { Language } from '../i18n/resources'
import { useAuth } from '../auth/useAuth'

/**
 * Derive the display identity from the live Supabase user (ADR-096).
 *
 * Name comes from `user_metadata.full_name`/`name` (set by OAuth providers like
 * Google), falling back to the email local-part and finally a neutral label.
 * Initials are computed from the resolved name; the avatar image, if any, comes
 * from `user_metadata.avatar_url`/`picture`. Email falls back to an empty
 * string so the caption simply collapses rather than showing a placeholder.
 */
interface DisplayIdentity {
  name: string
  email: string
  initials: string
  avatarUrl: string | null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function computeInitials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function deriveIdentity(user: User | null): DisplayIdentity {
  const meta = (user?.user_metadata ?? {}) as Record<string, unknown>
  const email = user?.email ?? ''
  const name =
    asString(meta.full_name) ??
    asString(meta.name) ??
    (email ? email.split('@')[0] : undefined) ??
    'Your account'
  const avatarUrl =
    asString(meta.avatar_url) ?? asString(meta.picture) ?? null
  return { name, email, initials: computeInitials(name), avatarUrl }
}

/**
 * Identity header (name + email). Shared by the desktop Menu and the mobile
 * Drawer so the two account surfaces never drift.
 */
function AccountIdentity({ identity }: { identity: DisplayIdentity }) {
  return (
    <Box>
      <Typography
        variant="body2"
        sx={{ fontWeight: 600, lineHeight: 1.3 }}
        color="text.primary"
      >
        {identity.name}
      </Typography>
      {identity.email ? (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', lineHeight: 1.3 }}
        >
          {identity.email}
        </Typography>
      ) : null}
    </Box>
  )
}

/**
 * The interactive account rows (theme switch + Settings navigation + inert Sign
 * out placeholder). The row element is parameterized via `Row` so the desktop
 * surface uses `MenuItem` (proper Menu keyboard semantics) while the mobile
 * Drawer uses `ListItemButton` — `MenuItem` requires a `MenuList` parent and
 * throws "MenuListContext is missing" if rendered in the Drawer. State is
 * conveyed by icon + Switch, never by color alone (ADR-019); Settings now
 * navigates to the `/settings` route (ADR-057), and Sign out now ends the real
 * Supabase session and returns to `/login` (ADR-096).
 */
function AccountActions({
  isDark,
  onToggleTheme,
  language,
  onChangeLanguage,
  onOpenSettings,
  onSignOut,
  Row,
}: {
  isDark: boolean
  onToggleTheme: () => void
  language: Language
  onChangeLanguage: (next: Language) => void
  onOpenSettings: () => void
  onSignOut: () => void
  Row: ElementType
}) {
  // All account labels resolve through the `account` namespace.
  const { t } = useTranslation('account')

  return (
    <>
      <Row
        onClick={onToggleTheme}
        sx={{ py: { xs: 1.75, md: 1 } }}
        aria-label={isDark ? t('darkModeOn') : t('darkModeOff')}
      >
        <ListItemIcon>
          {isDark ? (
            <DarkModeOutlinedIcon fontSize="small" />
          ) : (
            <LightModeOutlinedIcon fontSize="small" />
          )}
        </ListItemIcon>
        <ListItemText primary={t('darkMode')} />
        <Switch
          edge="end"
          size="small"
          checked={isDark}
          onClick={(event) => event.stopPropagation()}
          onChange={onToggleTheme}
          slotProps={{ input: { 'aria-label': t('toggleDarkMode') } }}
        />
      </Row>

      {/*
        Language selector — sits beside dark mode in both surfaces (ADR-104).
        Reflects the active locale and switches it live via the i18n context
        (which persists to localStorage). A compact Select presents the two
        languages by their own endonyms; the chosen value reads back as visible
        text (non-color cue, ADR-019) and the control carries an explicit
        `aria-label`. The row itself is inert — `component="div"` so the Drawer's
        ListItemButton variant doesn't add a button role around a control, and
        clicks/keys are stopped from bubbling to the Row's handler.
      */}
      <Row
        component="div"
        disableRipple
        sx={{
          py: { xs: 1.75, md: 1 },
          cursor: 'default',
          '&:hover': { backgroundColor: 'transparent' },
        }}
      >
        <ListItemIcon>
          <TranslateOutlinedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText primary={t('language')} />
        <Select
          size="small"
          variant="standard"
          disableUnderline
          value={language}
          onChange={(event: SelectChangeEvent) =>
            onChangeLanguage(event.target.value as Language)
          }
          onClick={(event: SyntheticEvent) => event.stopPropagation()}
          inputProps={{ 'aria-label': t('language') }}
          sx={{ '& .MuiSelect-select': { py: 0.25, pr: 3, fontSize: 14 } }}
        >
          <MenuItem value="en">{t('english')}</MenuItem>
          <MenuItem value="es">{t('spanish')}</MenuItem>
        </Select>
      </Row>

      <Divider />

      {/* Navigates to the /settings route (ADR-057). */}
      <Row onClick={onOpenSettings} sx={{ py: { xs: 1.75, md: 1 } }}>
        <ListItemIcon>
          <SettingsOutlinedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText primary={t('settings')} />
      </Row>

      {/* Ends the real Supabase session, then returns to /login (ADR-096). */}
      <Row
        onClick={onSignOut}
        sx={{
          py: { xs: 1.75, md: 1 },
          color: 'error.main',
          '& .MuiListItemText-primary': { fontWeight: 600 },
        }}
      >
        <ListItemIcon sx={{ color: 'inherit' }}>
          <LogoutOutlinedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText primary={t('signOut')} />
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
  const { t } = useTranslation('account')
  const { mode, toggle } = useColorMode()
  const { language, setLanguage } = useLanguage()
  const { user, signOut } = useAuth()
  const theme = useTheme()
  const navigate = useNavigate()
  const isMobile = useMediaQuery(theme.breakpoints.down('md'))

  const identity = deriveIdentity(user)

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
  // Close the account surface first, then navigate to the Settings route.
  const handleOpenSettings = () => {
    handleClose()
    void navigate({ to: '/settings' })
  }
  // Close the surface, end the Supabase session, then return to /login. The
  // SIGNED_OUT event also invalidates the router guards (ADR-096), so the
  // navigate is the explicit, immediate path back to the public route.
  const handleSignOut = () => {
    handleClose()
    void (async () => {
      await signOut()
      await navigate({ to: '/login' })
    })()
  }

  const isDark = mode === 'dark'

  return (
    <>
      <Tooltip title={t('menuLabel')}>
        <IconButton
          onClick={handleOpen}
          aria-label={t('menuLabel')}
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
            {...(identity.avatarUrl
              ? { src: identity.avatarUrl, alt: identity.name }
              : {})}
            sx={{
              width: 34,
              height: 34,
              bgcolor: 'action.selected',
              color: 'primary.main',
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {identity.initials}
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
          <AccountIdentity identity={identity} />
        </Box>

        <Divider />

        <AccountActions
          isDark={isDark}
          onToggleTheme={toggle}
          language={language}
          onChangeLanguage={setLanguage}
          onOpenSettings={handleOpenSettings}
          onSignOut={handleSignOut}
          Row={MenuItem}
        />
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
              {t('title')}
            </Typography>
            <IconButton
              onClick={handleClose}
              aria-label={t('closeLabel')}
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
            <AccountIdentity identity={identity} />
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
              language={language}
              onChangeLanguage={setLanguage}
              onOpenSettings={handleOpenSettings}
              onSignOut={handleSignOut}
              Row={ListItemButton}
            />
          </List>
        </Box>
      </Drawer>
    </>
  )
}

export default AccountMenu
