import type { ReactNode } from 'react'
import UploadFileIcon from '@mui/icons-material/UploadFile'
import SwapHorizIcon from '@mui/icons-material/SwapHoriz'
import SwapHorizOutlinedIcon from '@mui/icons-material/SwapHorizOutlined'
import HomeIcon from '@mui/icons-material/Home'
import HomeOutlinedIcon from '@mui/icons-material/HomeOutlined'
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong'
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined'
import AccountBalanceIcon from '@mui/icons-material/AccountBalance'
import AccountBalanceOutlinedIcon from '@mui/icons-material/AccountBalanceOutlined'
import AccountBalanceWalletIcon from '@mui/icons-material/AccountBalanceWallet'
import AccountBalanceWalletOutlinedIcon from '@mui/icons-material/AccountBalanceWalletOutlined'
import PieChartIcon from '@mui/icons-material/PieChart'
import PieChartOutlinedIcon from '@mui/icons-material/PieChartOutlined'
import BarChartIcon from '@mui/icons-material/BarChart'
import BarChartOutlinedIcon from '@mui/icons-material/BarChartOutlined'

/** A navigable destination wired to a router route. */
export interface NavRoute {
  kind: 'route'
  to:
    | '/'
    | '/transactions'
    | '/accounts'
    | '/budgets'
    | '/reports'
    | '/transfers'
    | '/monotributo'
    | '/import-statement'
  /** i18n key (shell ns) for the sidebar label. */
  labelKey: string
  /** i18n key (shell ns) for the shorter mobile bottom-nav label. */
  shortLabelKey: string
  /** Outlined icon shown when the route is inactive. */
  icon: ReactNode
  /** Filled icon variant shown when the route is active (non-color cue, ADR-019). */
  activeIcon: ReactNode
}

export type NavItem = NavRoute

/**
 * Primary navigation (ADR-127): the everyday PFM peers. Home / Transactions /
 * Accounts / Budgets / Reports are the top-level everyday destinations, shown on
 * the desktop sidebar and the mobile nav drawer (ADR-172).
 */
export const PRIMARY_NAV_ITEMS: NavItem[] = [
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
    to: '/accounts',
    labelKey: 'nav.accounts',
    shortLabelKey: 'nav.accountsShort',
    icon: <AccountBalanceWalletOutlinedIcon fontSize="small" />,
    activeIcon: <AccountBalanceWalletIcon fontSize="small" />,
  },
  {
    kind: 'route',
    to: '/budgets',
    labelKey: 'nav.budgets',
    shortLabelKey: 'nav.budgetsShort',
    icon: <PieChartOutlinedIcon fontSize="small" />,
    activeIcon: <PieChartIcon fontSize="small" />,
  },
  {
    kind: 'route',
    to: '/reports',
    labelKey: 'nav.reports',
    shortLabelKey: 'nav.reportsShort',
    icon: <BarChartOutlinedIcon fontSize="small" />,
    activeIcon: <BarChartIcon fontSize="small" />,
  },
]

/**
 * Secondary "Tools" navigation (ADR-127): transfers + import + the optional
 * Monotributo module are demoted below the primary peers into their own
 * grouping. The Monotributo entry is settings-gated (ADR-126) — see the sidebar
 * and the nav drawer, which filter it out when the module is disabled.
 */
export const TRANSFERS_NAV_ITEM: NavItem = {
  kind: 'route',
  to: '/transfers',
  labelKey: 'nav.transfers',
  shortLabelKey: 'nav.transfersShort',
  icon: <SwapHorizOutlinedIcon fontSize="small" />,
  activeIcon: <SwapHorizIcon fontSize="small" />,
}

export const IMPORT_NAV_ITEM: NavItem = {
  kind: 'route',
  to: '/import-statement',
  labelKey: 'nav.import',
  shortLabelKey: 'nav.importShort',
  icon: <UploadFileIcon fontSize="small" />,
  activeIcon: <UploadFileIcon fontSize="small" />,
}

export const MONOTRIBUTO_NAV_ITEM: NavItem = {
  kind: 'route',
  to: '/monotributo',
  labelKey: 'nav.monotributo',
  shortLabelKey: 'nav.monotributoShort',
  icon: <AccountBalanceOutlinedIcon fontSize="small" />,
  activeIcon: <AccountBalanceIcon fontSize="small" />,
}
