import { useState, type ReactNode } from 'react'
import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import AppBar from '@mui/material/AppBar'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Fab from '@mui/material/Fab'
import Toolbar from '@mui/material/Toolbar'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import AddIcon from '@mui/icons-material/Add'
import HomeIcon from '@mui/icons-material/Home'
import HomeOutlinedIcon from '@mui/icons-material/HomeOutlined'
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong'
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined'
import AccountBalanceOutlinedIcon from '@mui/icons-material/AccountBalanceOutlined'
import { AccountMenu } from './AccountMenu'
import { MonthSwitcher } from './MonthSwitcher'
import { MONTHS } from './months'
import { monoFontFamily } from '../theme'
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
  to: '/' | '/transactions'
  /** Sidebar label. */
  label: string
  /** Shorter label for the mobile bottom nav (concept uses "Activity"). */
  shortLabel: string
  /** Outlined icon shown when the route is inactive. */
  icon: ReactNode
  /** Filled icon variant shown when the route is active (non-color cue, ADR-019). */
  activeIcon: ReactNode
}

/** A placeholder destination that is visibly present but inert (ADR-017). */
interface NavPlaceholder {
  kind: 'placeholder'
  label: string
  shortLabel: string
  icon: ReactNode
}

type NavItem = NavRoute | NavPlaceholder

const NAV_ITEMS: NavItem[] = [
  {
    kind: 'route',
    to: '/',
    label: 'Home',
    shortLabel: 'Home',
    icon: <HomeOutlinedIcon fontSize="small" />,
    activeIcon: <HomeIcon fontSize="small" />,
  },
  {
    kind: 'route',
    to: '/transactions',
    label: 'Transactions',
    shortLabel: 'Activity',
    icon: <ReceiptLongOutlinedIcon fontSize="small" />,
    activeIcon: <ReceiptLongIcon fontSize="small" />,
  },
  {
    kind: 'placeholder',
    label: 'Monotributo',
    shortLabel: 'Mono',
    icon: <AccountBalanceOutlinedIcon fontSize="small" />,
  },
]

/**
 * Brand mark: gold tile with a mono "m" (concept identity). The "Margen"
 * wordmark is desktop-only on the mobile transparent bar so the left slot reads
 * as a single floating icon (ADR-017); pass `wordmark={false}` to force it off.
 */
function BrandMark({ wordmark = true }: { wordmark?: boolean }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
      <Box
        aria-hidden
        sx={{
          width: 26,
          height: 26,
          borderRadius: '7px',
          bgcolor: 'primary.main',
          color: 'primary.contrastText',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: monoFontFamily,
          fontWeight: 700,
          fontSize: 15,
        }}
      >
        m
      </Box>
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
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  return (
    <Box
      component="nav"
      aria-label="Primary"
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
        Add transaction
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

        if (item.kind === 'placeholder') {
          return (
            <Box
              key={item.label}
              aria-disabled
              title={`${item.label} — coming soon`}
              sx={{
                ...common,
                color: 'text.disabled',
                cursor: 'default',
                opacity: 0.65,
                '& .MuiSvgIcon-root': { flex: 'none' },
              }}
            >
              {item.icon}
              {item.label}
            </Box>
          )
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
            {item.label}
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
 * with no background. The Monotributo item is present but inert/dimmed.
 */
function FloatingNavPill() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  return (
    <Box
      component="nav"
      aria-label="Primary"
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
        if (item.kind === 'placeholder') {
          return (
            <Box
              key={item.label}
              role="img"
              aria-label={`${item.label} (coming soon)`}
              title={`${item.label} — coming soon`}
              sx={{
                ...PILL_ITEM_SX,
                color: 'text.disabled',
                opacity: 0.5,
                cursor: 'default',
              }}
            >
              {item.icon}
            </Box>
          )
        }

        const active = pathname === item.to
        return (
          <Box
            key={item.to}
            component={Link}
            to={item.to}
            aria-label={item.label}
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
  return (
    <Tooltip title="Add transaction">
      <Fab
        color="primary"
        onClick={onAddTransaction}
        aria-label="Add transaction"
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
 * Responsive Margen app shell (ADR-014, ADR-017, ADR-019).
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
export function AppShell() {
  const { openAdd } = useAddTransaction()
  const onAddTransaction = () => openAdd()

  // Shared selected-month state so the desktop stepper and the mobile compact
  // picker stay in sync (cosmetic for now; screens consume it later). Both
  // MonthSwitcher presentations are controlled from here.
  const [month, setMonth] = useState<string>(MONTHS[0])

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

          {/* Desktop (md+): centered inline month stepper. */}
          <Box sx={{ display: { xs: 'none', md: 'flex' }, justifyContent: 'center' }}>
            <MonthSwitcher variant="stepper" value={month} onChange={setMonth} />
          </Box>

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
            <Box sx={{ display: { xs: 'flex', md: 'none' } }}>
              <MonthSwitcher variant="compact" value={month} onChange={setMonth} />
            </Box>
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
    </Box>
  )
}

export default AppShell
