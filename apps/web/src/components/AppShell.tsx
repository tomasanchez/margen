import { useCallback, useState, type ReactNode } from 'react'
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
import Snackbar from '@mui/material/Snackbar'
import Toolbar from '@mui/material/Toolbar'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import AddIcon from '@mui/icons-material/Add'
import UploadFileIcon from '@mui/icons-material/UploadFile'
import HomeIcon from '@mui/icons-material/Home'
import HomeOutlinedIcon from '@mui/icons-material/HomeOutlined'
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong'
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined'
import AccountBalanceIcon from '@mui/icons-material/AccountBalance'
import AccountBalanceOutlinedIcon from '@mui/icons-material/AccountBalanceOutlined'
import { AccountMenu } from './AccountMenu'
import { MonthSwitcher } from './MonthSwitcher'
import { MonthProvider } from './MonthProvider'
import { useViewingMonth } from './monthContext'
import { useAddTransaction } from '../features/transactions/addContext'

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

/** A navigable destination wired to a router route. */
interface NavRoute {
  kind: 'route'
  to: '/' | '/transactions' | '/monotributo'
  /** i18n key (shell ns) for the sidebar label. */
  labelKey: string
  /** i18n key (shell ns) for the shorter mobile bottom-nav label. */
  shortLabelKey: string
  /** Outlined icon shown when the route is inactive. */
  icon: ReactNode
  /** Filled icon variant shown when the route is active (non-color cue, ADR-019). */
  activeIcon: ReactNode
}

type NavItem = NavRoute

const NAV_ITEMS: NavItem[] = [
  {
    kind: 'route',
    to: '/',
    labelKey: 'nav.home',
    shortLabelKey: 'nav.homeShort',
    icon: <HomeOutlinedIcon fontSize="small" />,
    activeIcon: <HomeIcon fontSize="small" />,
  },
  {
    kind: 'route',
    to: '/transactions',
    labelKey: 'nav.transactions',
    shortLabelKey: 'nav.transactionsShort',
    icon: <ReceiptLongOutlinedIcon fontSize="small" />,
    activeIcon: <ReceiptLongIcon fontSize="small" />,
  },
  {
    kind: 'route',
    to: '/monotributo',
    labelKey: 'nav.monotributo',
    shortLabelKey: 'nav.monotributoShort',
    icon: <AccountBalanceOutlinedIcon fontSize="small" />,
    activeIcon: <AccountBalanceIcon fontSize="small" />,
  },
]

/**
 * The margen brand mark — the new favicon icon (ADR-013): the sage "margin"
 * uprights + gold notch on a dark rounded tile. Rendered from the shipped raster
 * asset (`public/android-chrome-192x192.png`) at its 192px source so it stays
 * crisp on retina at this size. Decorative: `aria-hidden` + empty `alt`, with
 * the accessible name carried by the "Margen" wordmark / the surrounding
 * labelled brand link.
 */
function MargenMark({ size = 26 }: { size?: number }) {
  return (
    <Box
      component="img"
      src="/android-chrome-192x192.png"
      alt=""
      aria-hidden
      width={size}
      height={size}
      sx={{ width: size, height: size, display: 'block', flex: 'none', borderRadius: '7px' }}
    />
  )
}

/**
 * Brand mark: the margen glyph (sage margin uprights + gold notch; ADR-013). The
 * "Margen" wordmark is desktop-only on the mobile transparent bar so the left
 * slot reads as a single floating icon (ADR-017); pass `wordmark={false}` to
 * force it off.
 */
function BrandMark({ wordmark = true }: { wordmark?: boolean }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
      <MargenMark size={26} />
      {wordmark ? (
        <Typography
          component="span"
          sx={{
            // Hidden on the mobile transparent bar; shown from md+ (ADR-017).
            display: { xs: 'none', md: 'block' },
            fontWeight: 600,
            letterSpacing: '-0.01em',
            fontSize: 16,
          }}
          color="text.primary"
        >
          Margen
        </Typography>
      ) : null}
    </Box>
  )
}

function Sidebar({ onAddTransaction }: { onAddTransaction: () => void }) {
  const { t } = useTranslation('shell')
  const pathname = useRouterState({ select: (s) => s.location.pathname })

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
        sx={{ mb: 1, py: 1.25, fontWeight: 600 }}
      >
        {t('actions.addTransaction')}
      </Button>

      {/* Import statement: a sibling to the add CTA that opens the multi-row
          statement-import flow (ADR-080). Routed (not the Add dialog) because the
          review table needs the full page width. */}
      <Button
        component={Link}
        to="/import-statement"
        variant="outlined"
        color="secondary"
        startIcon={<UploadFileIcon fontSize="small" />}
        fullWidth
        sx={{
          mb: 1.75,
          py: 1.1,
          fontWeight: 600,
          textTransform: 'none',
          color: 'text.secondary',
          borderColor: 'var(--mg-border-2)',
        }}
      >
        {t('actions.importStatement')}
      </Button>

      {NAV_ITEMS.map((item) => {
        const common = {
          display: 'flex',
          alignItems: 'center',
          gap: 1.25,
          px: 1.5,
          py: 1.25,
          borderRadius: 1.5,
          fontSize: 14,
          width: '100%',
          textAlign: 'left' as const,
          textDecoration: 'none',
        }

        const active = pathname === item.to
        return (
          <Box
            key={item.to}
            component={Link}
            to={item.to}
            aria-current={active ? 'page' : undefined}
            sx={{
              ...common,
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
      })}
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
 * Floating, icon-only navigation pill (mobile only; ADR-017, ADR-019).
 *
 * Detached from every screen edge and centered near the bottom, it hugs its
 * content (capsule, soft shadow, subtle blur) rather than spanning the width.
 * Each destination is a ~44px touch target with an `aria-label` (no text label)
 * and `aria-current="page"` when active. The active item is conveyed beyond hue
 * (ADR-019): a gold-tinted rounded highlight behind the icon PLUS the gold icon
 * color PLUS the route's filled icon variant; inactive items stay muted/outlined
 * with no background.
 */
function FloatingNavPill() {
  const { t } = useTranslation('shell')
  const pathname = useRouterState({ select: (s) => s.location.pathname })

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
      {NAV_ITEMS.map((item) => {
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
          {/* Left: brand. The wordmark is desktop-only (BrandMark hides it on xs). */}
          <Box sx={{ flex: 1, display: 'flex', alignItems: 'center' }}>
            <BrandMark />
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

      {/* Mobile-only floating overlays (out of flow; ADR-017, ADR-019). */}
      <FloatingNavPill />
      <AddFab onAddTransaction={onAddTransaction} />

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
