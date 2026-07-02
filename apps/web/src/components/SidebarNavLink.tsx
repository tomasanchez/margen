import { useTranslation } from 'react-i18next'
import { Link } from '@tanstack/react-router'
import Box from '@mui/material/Box'
import type { NavItem } from './navItems'

/**
 * A single nav link styled for the sidebar / drawer list (as opposed to the
 * icon-only pill). Reused by both the desktop sidebar and the mobile nav drawer
 * so the two surfaces stay visually identical. Active is conveyed beyond hue
 * (ADR-019): gold color + filled icon + bolder label + selected background.
 *
 * `onNavigate` lets a caller (the drawer) close itself when a link is tapped;
 * the sidebar omits it.
 */
export function SidebarNavLink({
  item,
  active,
  onNavigate,
}: {
  item: NavItem
  active: boolean
  onNavigate?: () => void
}) {
  const { t } = useTranslation('shell')
  return (
    <Box
      component={Link}
      to={item.to}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.25,
        px: 1.5,
        py: 1.25,
        borderRadius: 1.5,
        fontSize: 14,
        width: '100%',
        textAlign: 'left',
        textDecoration: 'none',
        // Active conveyed beyond hue (ADR-019): gold color + filled icon +
        // bolder label + selected background; inactive stays muted/outlined.
        color: active ? 'primary.main' : 'text.secondary',
        fontWeight: active ? 600 : 500,
        bgcolor: active ? 'action.selected' : 'transparent',
        '& .MuiSvgIcon-root': { flex: 'none' },
        '&:hover': { bgcolor: 'action.hover' },
        '&:focus-visible': {
          outline: '2px solid',
          outlineColor: 'primary.main',
          outlineOffset: 2,
        },
      }}
    >
      {active ? item.activeIcon : item.icon}
      {t(item.labelKey)}
    </Box>
  )
}

export default SidebarNavLink
