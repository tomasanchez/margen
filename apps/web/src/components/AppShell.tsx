import { type ReactNode } from 'react'
import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import AppBar from '@mui/material/AppBar'
import Avatar from '@mui/material/Avatar'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Toolbar from '@mui/material/Toolbar'
import Typography from '@mui/material/Typography'
import AddIcon from '@mui/icons-material/Add'
import HomeOutlinedIcon from '@mui/icons-material/HomeOutlined'
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined'
import AccountBalanceOutlinedIcon from '@mui/icons-material/AccountBalanceOutlined'
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined'
import { ColorModeToggle } from './ColorModeToggle'
import { MonthSwitcher } from './MonthSwitcher'
import { monoFontFamily } from '../theme'
import { useAddTransaction } from '../features/transactions/addContext'

const SIDEBAR_WIDTH = 212
const BOTTOM_NAV_HEIGHT = 78

/** A navigable destination wired to a router route. */
interface NavRoute {
  kind: 'route'
  to: '/' | '/transactions'
  /** Sidebar label. */
  label: string
  /** Shorter label for the mobile bottom nav (concept uses "Activity"). */
  shortLabel: string
  icon: ReactNode
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
  },
  {
    kind: 'route',
    to: '/transactions',
    label: 'Transactions',
    shortLabel: 'Activity',
    icon: <ReceiptLongOutlinedIcon fontSize="small" />,
  },
  {
    kind: 'placeholder',
    label: 'Monotributo',
    shortLabel: 'Mono',
    icon: <AccountBalanceOutlinedIcon fontSize="small" />,
  },
  {
    kind: 'placeholder',
    label: 'Settings',
    shortLabel: 'Settings',
    icon: <SettingsOutlinedIcon fontSize="small" />,
  },
]

/** Brand mark: gold tile with a mono "m" (concept identity). */
function BrandMark() {
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
      <Typography
        component="span"
        sx={{ fontWeight: 600, letterSpacing: '-0.01em', fontSize: 16 }}
        color="text.primary"
      >
        Margen
      </Typography>
    </Box>
  )
}

/** Active-route marker: a small gold square; outlined square when inactive. */
function NavMarker({ active }: { active: boolean }) {
  return (
    <Box
      aria-hidden
      sx={{
        width: 8,
        height: 8,
        borderRadius: '2px',
        flex: 'none',
        ...(active
          ? { bgcolor: 'primary.main' }
          : { border: '1.5px solid', borderColor: 'text.disabled' }),
      }}
    />
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
        flex: 'none',
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
              }}
            >
              <NavMarker active={false} />
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
              color: active ? 'text.primary' : 'text.secondary',
              fontWeight: active ? 600 : 500,
              bgcolor: active ? 'action.selected' : 'transparent',
              '&:hover': { bgcolor: 'action.hover' },
              '&:focus-visible': {
                outline: '2px solid',
                outlineColor: 'primary.main',
                outlineOffset: 2,
              },
            }}
          >
            <NavMarker active={active} />
            {item.label}
          </Box>
        )
      })}
    </Box>
  )
}

function BottomNav({ onAddTransaction }: { onAddTransaction: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  // Render the two routes around the central FAB, then the two placeholders.
  const routes = NAV_ITEMS.filter(
    (i): i is NavRoute => i.kind === 'route',
  )
  const placeholders = NAV_ITEMS.filter(
    (i): i is NavPlaceholder => i.kind === 'placeholder',
  )

  const itemSx = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 0.5,
    fontSize: 10.5,
    textDecoration: 'none',
    minWidth: 56,
    py: 0.5,
  } as const

  return (
    <Paper
      component="nav"
      aria-label="Primary"
      square
      sx={{
        display: { xs: 'flex', md: 'none' },
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        height: BOTTOM_NAV_HEIGHT,
        alignItems: 'center',
        justifyContent: 'space-around',
        px: 2,
        pb: 'env(safe-area-inset-bottom)',
        borderTop: 1,
        borderColor: 'divider',
        borderRadius: 0,
        zIndex: (theme) => theme.zIndex.appBar,
      }}
    >
      {routes.map((item) => {
        const active = pathname === item.to
        return (
          <Box
            key={item.to}
            component={Link}
            to={item.to}
            aria-current={active ? 'page' : undefined}
            sx={{
              ...itemSx,
              color: active ? 'primary.main' : 'text.disabled',
              fontWeight: active ? 600 : 400,
              '&:focus-visible': {
                outline: '2px solid',
                outlineColor: 'primary.main',
                outlineOffset: 2,
                borderRadius: 1,
              },
            }}
          >
            <NavMarker active={active} />
            {item.shortLabel}
          </Box>
        )
      })}

      <Button
        onClick={onAddTransaction}
        aria-label="Add transaction"
        sx={{
          minWidth: 0,
          width: 54,
          height: 54,
          borderRadius: '18px',
          mt: '-22px',
          p: 0,
          bgcolor: 'primary.main',
          color: 'primary.contrastText',
          boxShadow: '0 12px 24px -8px rgba(199,162,83,0.6)',
          '&:hover': { bgcolor: 'primary.dark' },
        }}
      >
        <AddIcon sx={{ fontSize: 27 }} />
      </Button>

      {placeholders.map((item) => (
        <Box
          key={item.label}
          aria-disabled
          title={`${item.label} — coming soon`}
          sx={{
            ...itemSx,
            color: 'text.disabled',
            opacity: 0.65,
            cursor: 'default',
          }}
        >
          <NavMarker active={false} />
          {item.shortLabel}
        </Box>
      ))}
    </Paper>
  )
}

/**
 * Responsive Margen app shell (ADR-014, ADR-017, ADR-019).
 *
 * Desktop (md+): top bar (brand + centered MonthSwitcher + ColorModeToggle and
 * avatar), a 212px left sidebar with the gold "Add transaction" CTA and nav, and
 * the routed content in <Outlet/>. Mobile (xs–sm): the sidebar is hidden and a
 * fixed 78px bottom navigation carries Home / Activity / center gold FAB / Mono
 * / Settings.
 *
 * Active route is driven by the router location and marked with the gold square
 * in both nav surfaces. The sidebar CTA and the mobile FAB both call
 * `openAdd()` from the Add-transaction seam (addContext); the actual form is a
 * later task.
 */
export function AppShell() {
  const { openAdd } = useAddTransaction()
  const onAddTransaction = () => openAdd()

  return (
    <Box
      sx={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.default',
      }}
    >
      <AppBar
        position="sticky"
        color="inherit"
        elevation={0}
        sx={{
          borderBottom: 1,
          borderColor: 'divider',
          bgcolor: 'background.paper',
        }}
      >
        <Toolbar sx={{ gap: 1.5 }}>
          <Box sx={{ flex: 1, display: 'flex', alignItems: 'center' }}>
            <BrandMark />
          </Box>

          {/* Centered month switcher (desktop emphasis; still usable on mobile). */}
          <Box sx={{ display: 'flex', justifyContent: 'center' }}>
            <MonthSwitcher />
          </Box>

          <Stack
            direction="row"
            spacing={1.25}
            sx={{ flex: 1, justifyContent: 'flex-end', alignItems: 'center' }}
          >
            <ColorModeToggle />
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
              VC
            </Avatar>
          </Stack>
        </Toolbar>
      </AppBar>

      <Box sx={{ flex: 1, display: 'flex', alignItems: 'stretch', minHeight: 0 }}>
        <Sidebar onAddTransaction={onAddTransaction} />

        <Box
          component="main"
          sx={{
            flex: 1,
            minWidth: 0,
            px: { xs: 2.5, md: 4 },
            py: { xs: 3, md: 3.75 },
            // Keep content clear of the fixed mobile bottom nav.
            pb: {
              xs: `calc(${BOTTOM_NAV_HEIGHT}px + 24px)`,
              md: 3.75,
            },
          }}
        >
          <Outlet />
        </Box>
      </Box>

      <BottomNav onAddTransaction={onAddTransaction} />
    </Box>
  )
}

export default AppShell
