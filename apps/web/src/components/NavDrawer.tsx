import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useRouterState } from '@tanstack/react-router'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Drawer from '@mui/material/Drawer'
import Typography from '@mui/material/Typography'
import AddIcon from '@mui/icons-material/Add'
import {
  IMPORT_NAV_ITEM,
  MONOTRIBUTO_NAV_ITEM,
  PRIMARY_NAV_ITEMS,
  TRANSFERS_NAV_ITEM,
  type NavItem,
} from './navItems'
import { SidebarNavLink } from './SidebarNavLink'
import { MargenMark } from './BrandMark'
import { useMonotributoEnabled } from '../features/settings/queries'

/** Fixed width for the temporary mobile nav drawer (roomier than the sidebar). */
const NAV_DRAWER_WIDTH = 288

/**
 * The mobile navigation drawer (ADR-172): a temporary, modal left `Drawer` that
 * carries the FULL navigation on `xs` where the slimmed floating pill only shows
 * Home / Transactions / Reports. Opened by the floating hamburger in the mobile
 * top bar; MUI handles backdrop dismiss, Esc, and focus trap/restore.
 *
 * Contents, top→bottom:
 * - Brand header (Margen mark + wordmark).
 * - The gold "Add transaction" CTA (same `openAdd()` seam as the sidebar/FAB),
 *   which closes the drawer after firing.
 * - The full nav list reusing {@link SidebarNavLink}: the primary peers, then a
 *   "Tools" group heading + Transfers / Import / Monotributo (Monotributo gated
 *   on {@link useMonotributoEnabled}, exactly like the desktop sidebar).
 *
 * Every nav tap navigates and closes the drawer; it also closes on route change,
 * backdrop, and Esc.
 */
export function NavDrawer({
  open,
  onClose,
  onAddTransaction,
  id,
}: {
  open: boolean
  onClose: () => void
  onAddTransaction: () => void
  /** DOM id so the trigger button can reference it via `aria-controls`. */
  id?: string
}) {
  const { t } = useTranslation('shell')
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  // Gate the Monotributo tool on the optional-module flag (ADR-126). Treated as
  // hidden until settings resolve, so the item never flashes then disappears.
  const { enabled: monotributoEnabled } = useMonotributoEnabled()

  // Close on route change: if the location changes while the drawer is open
  // (e.g. programmatic navigation), collapse it so it never lingers over content.
  useEffect(() => {
    if (open) onClose()
    // Intentionally keyed on pathname only: fire when the route changes, not when
    // `open`/`onClose` identities change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname])

  // Secondary "Tools" grouping (ADR-127): transfers + import always present;
  // Monotributo only when the module is enabled.
  const toolItems: NavItem[] = monotributoEnabled
    ? [TRANSFERS_NAV_ITEM, IMPORT_NAV_ITEM, MONOTRIBUTO_NAV_ITEM]
    : [TRANSFERS_NAV_ITEM, IMPORT_NAV_ITEM]

  const handleAdd = () => {
    onAddTransaction()
    onClose()
  }

  return (
    <Drawer
      id={id}
      anchor="left"
      open={open}
      onClose={onClose}
      // Mobile-only affordance; hidden from md+ where the sidebar owns nav.
      sx={{ display: { xs: 'block', md: 'none' } }}
      slotProps={{
        paper: {
          sx: {
            width: NAV_DRAWER_WIDTH,
            maxWidth: '85vw',
            px: 2,
            py: 2,
            // Respect the iOS safe areas so the header/CTA clear the notch/home bar.
            pt: 'calc(16px + env(safe-area-inset-top))',
            pb: 'calc(16px + env(safe-area-inset-bottom))',
            display: 'flex',
            flexDirection: 'column',
            gap: 0.5,
            bgcolor: 'background.paper',
          },
        },
      }}
    >
      {/* Brand header. */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.25,
          px: 1.5,
          pb: 1.75,
        }}
      >
        <MargenMark size={26} />
        <Typography
          component="span"
          color="text.primary"
          sx={{ fontWeight: 600, letterSpacing: '-0.01em', fontSize: 16 }}
        >
          Margen
        </Typography>
      </Box>

      <Button
        variant="contained"
        color="primary"
        startIcon={<AddIcon />}
        onClick={handleAdd}
        fullWidth
        sx={{ mb: 1.75, py: 1.25, fontWeight: 600 }}
      >
        {t('actions.addTransaction')}
      </Button>

      {/* The full nav list, reusing the sidebar link look. */}
      <Box
        component="nav"
        aria-label={t('nav.menu')}
        sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}
      >
        {PRIMARY_NAV_ITEMS.map((item) => (
          <SidebarNavLink
            key={item.to}
            item={item}
            active={pathname === item.to}
            onNavigate={onClose}
          />
        ))}

        {/* Tools group (ADR-127): transfers + import + the optional Monotributo
            module, demoted below the everyday PFM peers. */}
        <Typography
          component="h2"
          sx={{
            mt: 2,
            mb: 0.5,
            px: 1.5,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}
          color="text.secondary"
        >
          {t('nav.toolsGroup')}
        </Typography>
        {toolItems.map((item) => (
          <SidebarNavLink
            key={item.to}
            item={item}
            active={pathname === item.to}
            onNavigate={onClose}
          />
        ))}
      </Box>
    </Drawer>
  )
}

export default NavDrawer
