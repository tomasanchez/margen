import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router'
import AppBar from '@mui/material/AppBar'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Fab from '@mui/material/Fab'
import IconButton from '@mui/material/IconButton'
import Snackbar from '@mui/material/Snackbar'
import Toolbar from '@mui/material/Toolbar'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import AddIcon from '@mui/icons-material/Add'
import MenuIcon from '@mui/icons-material/Menu'
import { AccountMenu } from './AccountMenu'
import { BrandMark } from './BrandMark'
import { NavDrawer } from './NavDrawer'
import { SidebarNavLink } from './SidebarNavLink'
import {
  PRIMARY_NAV_ITEMS,
  IMPORT_NAV_ITEM,
  MONOTRIBUTO_NAV_ITEM,
  TRANSFERS_NAV_ITEM,
  type NavItem,
} from './navItems'
import { MonthSwitcher } from './MonthSwitcher'
import { MonthProvider } from './MonthProvider'
import { useViewingMonth } from './monthContext'
import { useAddTransaction } from '../features/transactions/addContext'
import { useMonotributoEnabled } from '../features/settings/queries'

const SIDEBAR_WIDTH = 212
/** Caps the routed content width so wide monitors get balanced side margins (ADR-017). */
const CONTENT_MAX_WIDTH = 1240

/**
 * Mobile bottom clearance for the routed content (ADR-017). The pill + FAB now
 * FLOAT (fixed, out of flow), so `<main>` reserves room below its content for
 * the FAB stacked above the pill plus the bottom margin and the iOS safe area,
 * letting content scroll fully clear of both overlays.
 */
const MOBILE_SCROLL_CLEARANCE =
  'calc(124px + env(safe-area-inset-bottom))'

function Sidebar({ onAddTransaction }: { onAddTransaction: () => void }) {
  const { t } = useTranslation('shell')
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  // Gate the Monotributo tool on the optional-module flag (ADR-126). Treated as
  // hidden until settings resolve, so the item never flashes then disappears.
  const { enabled: monotributoEnabled } = useMonotributoEnabled()

  // Secondary "Tools" grouping (ADR-127): import is always present; Monotributo
  // only when the module is enabled.
  const toolItems: NavItem[] = monotributoEnabled
    ? [TRANSFERS_NAV_ITEM, IMPORT_NAV_ITEM, MONOTRIBUTO_NAV_ITEM]
    : [TRANSFERS_NAV_ITEM, IMPORT_NAV_ITEM]

  return (
    <Box
      component="nav"
      aria-label={t('nav.primary')}
      sx={{
        width: SIDEBAR_WIDTH,
        flexShrink: 0,
        overflowY: 'auto',
        borderRight: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        px: 2,
        py: 2.75,
        display: { xs: 'none', md: 'flex' },
        flexDirection: 'column',
        gap: 0.5,
      }}
    >
      <Button
        variant="contained"
        color="primary"
        startIcon={<AddIcon />}
        onClick={onAddTransaction}
        fullWidth
        sx={{ mb: 1.75, py: 1.25, fontWeight: 600 }}
      >
        {t('actions.addTransaction')}
      </Button>

      {PRIMARY_NAV_ITEMS.map((item) => (
        <SidebarNavLink
          key={item.to}
          item={item}
          active={pathname === item.to}
        />
      ))}

      {/* Tools group (ADR-127): a labeled secondary section that demotes import
          + the optional Monotributo module below the everyday PFM peers. */}
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
        />
      ))}
    </Box>
  )
}

/** Shared touch-target sizing for the floating pill's icon items (iOS feel). */
const PILL_ITEM_SX = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 44,
  height: 44,
  borderRadius: 999,
  textDecoration: 'none',
  flex: 'none',
} as const

/**
 * The slim set of pill destinations (ADR-172): just the three most-used peers.
 * The rest of navigation (Accounts, Budgets, Transfers, Import, and the optional
 * Monotributo module) moves into the mobile {@link NavDrawer} so the pill stays
 * uncrowded — a comfortable three ~44px touch targets.
 */
const PILL_NAV_ITEMS: NavItem[] = PRIMARY_NAV_ITEMS.filter((item) =>
  item.to === '/' || item.to === '/transactions' || item.to === '/reports',
)

/**
 * Floating, icon-only navigation pill (mobile only; ADR-017, ADR-019, ADR-172).
 *
 * Detached from every screen edge and centered near the bottom, it hugs its
 * content (capsule, soft shadow, subtle blur) rather than spanning the width.
 * It carries only the three most-used peers (Home / Transactions / Reports);
 * the full navigation lives in the {@link NavDrawer} opened from the top-left
 * hamburger. Each destination is a ~44px touch target with an `aria-label` (no
 * text label) and `aria-current="page"` when active. The active item is conveyed
 * beyond hue (ADR-019): a gold-tinted rounded highlight behind the icon PLUS the
 * gold icon color PLUS the route's filled icon variant; inactive items stay
 * muted/outlined with no background.
 */
function FloatingNavPill() {
  const { t } = useTranslation('shell')
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  const pillItems = PILL_NAV_ITEMS

  return (
    <Box
      component="nav"
      aria-label={t('nav.primary')}
      sx={{
        display: { xs: 'flex', md: 'none' },
        position: 'fixed',
        left: 0,
        right: 0,
        mx: 'auto',
        width: 'fit-content',
        bottom: 'calc(16px + env(safe-area-inset-bottom))',
        zIndex: (t) => t.zIndex.appBar,
        alignItems: 'center',
        gap: 0.75,
        p: 0.75,
        borderRadius: 999,
        bgcolor: 'background.paper',
        border: 1,
        borderColor: 'divider',
        boxShadow: '0 18px 40px -16px rgba(0,0,0,0.55)',
        backdropFilter: 'blur(12px)',
      }}
    >
      {pillItems.map((item) => {
        const active = pathname === item.to
        return (
          <Box
            key={item.to}
            component={Link}
            to={item.to}
            aria-label={t(item.labelKey)}
            aria-current={active ? 'page' : undefined}
            sx={{
              ...PILL_ITEM_SX,
              // Active conveyed beyond hue (ADR-019): gold-tinted highlight +
              // gold icon + filled icon variant; inactive stays muted/outlined.
              color: active ? 'primary.main' : 'text.secondary',
              bgcolor: active ? 'action.selected' : 'transparent',
              '&:hover': { bgcolor: active ? 'action.selected' : 'action.hover' },
              '&:focus-visible': {
                outline: '2px solid',
                outlineColor: 'primary.main',
                outlineOffset: 2,
              },
            }}
          >
            {active ? item.activeIcon : item.icon}
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * Separate floating gold add button (mobile only; ADR-017, ADR-019).
 *
 * A round gold FAB pinned bottom-RIGHT and stacked ABOVE the nav pill (its
 * bottom offset clears the pill height + gap + safe area). It calls the same
 * `openAdd()` seam as the desktop sidebar CTA and is fully keyboard-operable.
 */
function AddFab({ onAddTransaction }: { onAddTransaction: () => void }) {
  const { t } = useTranslation('shell')
  return (
    <Tooltip title={t('actions.addTransaction')}>
      <Fab
        color="primary"
        onClick={onAddTransaction}
        aria-label={t('actions.addTransaction')}
        sx={{
          display: { xs: 'inline-flex', md: 'none' },
          position: 'fixed',
          right: 16,
          // Sit above the pill: pill bottom (16) + pill height (~58) + gap (12).
          bottom: 'calc(86px + env(safe-area-inset-bottom))',
          zIndex: (t) => t.zIndex.appBar + 1,
          color: 'primary.contrastText',
          boxShadow: '0 14px 28px -8px rgba(199,162,83,0.6)',
          '&:focus-visible': {
            outline: '2px solid',
            outlineColor: 'primary.contrastText',
            outlineOffset: -4,
          },
        }}
      >
        <AddIcon />
      </Fab>
    </Tooltip>
  )
}

/**
 * Responsive Margen app shell body (ADR-014, ADR-017, ADR-019, ADR-040).
 *
 * Rendered inside {@link MonthProvider} so both the top-bar MonthSwitcher
 * (writer) and the routed Outlet / Home (reader) share one selected month. Both
 * switcher presentations are controlled from the single context value, keeping
 * the desktop stepper and the mobile picker in sync.
 *
 * Desktop (md+): top bar (brand + centered MonthSwitcher + the avatar account
 * menu, which now also owns the theme toggle), a 212px left sidebar with the gold
 * "Add transaction" CTA and nav, and the routed content in <Outlet/>, capped at
 * CONTENT_MAX_WIDTH and centered for balanced side margins on wide screens
 * (ADR-017). Mobile (xs–sm): the sidebar is hidden and a
 * 78px bottom navigation carries Home / Activity / center gold FAB / Mono.
 *
 * Layout is a fixed-viewport flex column: the root owns exactly `100dvh` and
 * `overflow: hidden`, so the window never scrolls. The header and (mobile)
 * bottom nav are non-scrolling rows (`flexShrink: 0`); the middle row holds the
 * sidebar and the single scroll container (`main`, `overflowY: auto`). The
 * bottom nav, being the last row, stays pinned at the viewport bottom over the
 * scrolling content with no fixed-position or padding hack.
 *
 * Mobile (xs–sm): the sidebar is hidden; navigation is a floating, icon-only
 * capsule pill ({@link FloatingNavPill}) detached and centered near the bottom,
 * with a separate gold add FAB ({@link AddFab}) stacked above it at the
 * bottom-right. Both float via fixed positioning over the scroll area, so they
 * are out of flow — `<main>` adds bottom padding on mobile so content scrolls
 * clear of them while the window itself still never scrolls.
 *
 * Active route is driven by the router location and marked with the route's
 * filled icon, gold color, and (sidebar) a bolder label / (pill) a gold-tinted
 * highlight, plus `aria-current="page"` (a non-color cue per ADR-019). The
 * sidebar CTA and the mobile FAB both call `openAdd()` from the Add-transaction
 * seam (addContext); the actual form is a later task.
 */
function AppShellBody() {
  const { t } = useTranslation('shell')
  const { openAdd } = useAddTransaction()
  const onAddTransaction = () => openAdd()

  const { viewingMonth, setViewingMonth } = useViewingMonth()

  // The global month switcher drives the Home dashboard only (ADR-040: the
  // Transactions ledger owns its OWN per-screen month picker). Gate both
  // switcher presentations to the Home route so they never appear elsewhere.
  const isHome = useRouterState({
    select: (s) => s.location.pathname === '/',
  })

  const navigate = useNavigate()
  const [olderHintOpen, setOlderHintOpen] = useState(false)
  // Mobile nav drawer (ADR-172): opened by the top-left hamburger. Desktop keeps
  // the always-visible sidebar, so this only drives the xs surface.
  const [navDrawerOpen, setNavDrawerOpen] = useState(false)

  // Going older than the 6-months-ago floor lands the user in Transactions,
  // where older dates are searchable (ADR-041). A brief, calm Snackbar explains
  // the jump; it auto-dismisses but is non-blocking and dismissible.
  const handleNavigateOlder = useCallback(() => {
    setOlderHintOpen(true)
    void navigate({ to: '/transactions' })
  }, [navigate])

  return (
    <Box
      sx={{
        height: '100dvh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.default',
      }}
    >
      <AppBar
        position="static"
        color="inherit"
        elevation={0}
        sx={{
          flexShrink: 0,
          // Desktop (md+): solid paper bar, in-flow, with a clean bottom border in
          // the SAME token as cards/everything else (var(--mg-border)). AppBar is a
          // Paper, so the global MuiPaper full border is neutralized first.
          // Mobile (xs–sm): a TRANSPARENT fixed overlay — content scrolls beneath
          // it (truly see-through, iOS feel), not an opaque row that hides content.
          position: { xs: 'fixed', md: 'static' },
          top: 0,
          left: 0,
          right: 0,
          zIndex: (t) => t.zIndex.appBar,
          bgcolor: { xs: 'transparent', md: 'background.paper' },
          border: 'none',
          borderBottom: { xs: 'none', md: '1px solid var(--mg-border)' },
        }}
      >
        <Toolbar sx={{ gap: 1.5 }}>
          {/* Left slot. Desktop (md+): the brand (mark + wordmark). Mobile (xs):
              a floating hamburger that opens the full nav drawer (ADR-172),
              reading as a floating control against the transparent bar (matching
              the other mobile floating controls). */}
          <Box sx={{ flex: 1, display: 'flex', alignItems: 'center' }}>
            <Box sx={{ display: { xs: 'flex', md: 'none' } }}>
              <Tooltip title={t('nav.openMenu')}>
                <IconButton
                  onClick={() => setNavDrawerOpen(true)}
                  aria-label={t('nav.openMenu')}
                  aria-haspopup="dialog"
                  aria-expanded={navDrawerOpen}
                  aria-controls="mobile-nav-drawer"
                  sx={{
                    // Floating control against the transparent bar: paper bg +
                    // border + subtle shadow/blur, matching the compact month
                    // picker and the nav pill.
                    color: 'text.secondary',
                    borderRadius: 2,
                    bgcolor: 'background.paper',
                    border: 1,
                    borderColor: 'divider',
                    backdropFilter: 'blur(12px)',
                    boxShadow: '0 8px 22px -14px rgba(0,0,0,0.6)',
                    '&:hover': { bgcolor: 'action.hover' },
                    '&:focus-visible': {
                      outline: '2px solid',
                      outlineColor: 'primary.main',
                      outlineOffset: 2,
                    },
                  }}
                >
                  <MenuIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
            <Box sx={{ display: { xs: 'none', md: 'flex' }, alignItems: 'center' }}>
              <BrandMark />
            </Box>
          </Box>

          {/* Desktop (md+): centered inline month stepper — Home only (ADR-040). */}
          {isHome ? (
            <Box
              sx={{ display: { xs: 'none', md: 'flex' }, justifyContent: 'center' }}
            >
              <MonthSwitcher
                variant="stepper"
                value={viewingMonth}
                onChange={setViewingMonth}
                onNavigateOlder={handleNavigateOlder}
              />
            </Box>
          ) : null}

          {/* Right cluster. Desktop: just the avatar. Mobile (xs–sm): a floating
              circular calendar button (compact month picker) + the avatar, both
              reading as floating against the transparent bar. */}
          <Box
            sx={{
              flex: 1,
              display: 'flex',
              justifyContent: 'flex-end',
              alignItems: 'center',
              gap: 1,
            }}
          >
            {/* Mobile compact month picker — Home only (ADR-040). */}
            {isHome ? (
              <Box sx={{ display: { xs: 'flex', md: 'none' } }}>
                <MonthSwitcher
                  variant="compact"
                  value={viewingMonth}
                  onChange={setViewingMonth}
                  onNavigateOlder={handleNavigateOlder}
                />
              </Box>
            ) : null}
            <AccountMenu />
          </Box>
        </Toolbar>
      </AppBar>

      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'stretch',
        }}
      >
        <Sidebar onAddTransaction={onAddTransaction} />

        {/* The single scroll container: only this region scrolls; the window never
            does. It stays full width (scrollbar at the viewport edge); the inner
            wrapper caps + centers the content so wide screens get side margins. */}
        <Box
          component="main"
          sx={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            overflowY: 'auto',
          }}
        >
          <Box
            sx={{
              maxWidth: CONTENT_MAX_WIDTH,
              mx: 'auto',
              width: '100%',
              px: { xs: 2.5, md: 4 },
              // Mobile: the top bar is a fixed overlay, so reserve top clearance
              // so content starts below the floating controls (then scrolls
              // beneath them as you scroll up). The pill + FAB float at the
              // bottom, so reserve bottom clearance too. Desktop is symmetric.
              pt: { xs: 'calc(64px + env(safe-area-inset-top))', md: 3.75 },
              pb: { xs: MOBILE_SCROLL_CLEARANCE, md: 3.75 },
            }}
          >
            <Outlet />
          </Box>
        </Box>
      </Box>

      {/* Mobile-only floating overlays (out of flow; ADR-017, ADR-019, ADR-172). */}
      <FloatingNavPill />
      <AddFab onAddTransaction={onAddTransaction} />
      <NavDrawer
        id="mobile-nav-drawer"
        open={navDrawerOpen}
        onClose={() => setNavDrawerOpen(false)}
        onAddTransaction={onAddTransaction}
      />

      {/* Calm hint shown when the navigator hits its 6-month floor and we route
          to Transactions for older dates (ADR-041). Non-blocking, dismissible. */}
      <Snackbar
        open={olderHintOpen}
        onClose={() => setOlderHintOpen(false)}
        autoHideDuration={5000}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        message={t('olderHint')}
      />
    </Box>
  )
}

/**
 * Responsive Margen app shell (ADR-014, ADR-017, ADR-019, ADR-040).
 *
 * Wraps the shell body in {@link MonthProvider} so the top-bar month navigator
 * and the routed Home dashboard share a single "viewing month" (defaulting to
 * the current real calendar month). See {@link AppShellBody} for the layout and
 * navigation details.
 */
export function AppShell() {
  return (
    <MonthProvider>
      <AppShellBody />
    </MonthProvider>
  )
}

export default AppShell
