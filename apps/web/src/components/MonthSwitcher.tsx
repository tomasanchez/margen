import { useId, useState, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import CalendarMonthOutlinedIcon from '@mui/icons-material/CalendarMonthOutlined'
import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import HistoryRoundedIcon from '@mui/icons-material/HistoryRounded'
import { monoFontFamily } from '../theme'
import {
  addMonths,
  boundedMonthsWindow,
  currentViewingMonth,
  formatViewingMonth,
  isAtLowerBound,
  isAtUpperBound,
  isSameViewingMonth,
  type ViewingMonth,
} from './months'

/**
 * Presentation of the month control:
 * - `stepper` — desktop inline `‹ June 2026 ›` prev/label/next (the original).
 * - `compact` — mobile floating circular calendar button that opens a month
 *   picker (Menu) listing a recent-months window, the current one marked with a
 *   check (non-color cue, ADR-019).
 */
export type MonthSwitcherVariant = 'stepper' | 'compact'

export interface MonthSwitcherProps {
  /** Which presentation to render. Defaults to the desktop `stepper`. */
  variant?: MonthSwitcherVariant
  /** Selected viewing month. Uncontrolled (local state) when omitted. */
  value?: ViewingMonth
  /** Called with the new viewing month when the user navigates/picks. */
  onChange?: (month: ViewingMonth) => void
  /**
   * Invoked when the user tries to go older than the 6-months-ago floor (ADR-041):
   * pressing `‹` while at the floor, or the compact picker's "Older months"
   * affordance. The shell routes to Transactions (where older dates are
   * searchable) instead of stepping further. When omitted, the floor is a hard
   * stop (no-op).
   */
  onNavigateOlder?: () => void
}

/**
 * Top-bar month navigator (ADR-017, ADR-019, ADR-040).
 *
 * A REAL month navigator (no longer cosmetic): `‹`/`›` step one calendar month,
 * crossing year boundaries; the label is the full "Month Year". Two presentations
 * share one controlled/uncontrolled `{ year, month }` state model:
 *
 * - `stepper` (desktop): ‹ June 2026 › where each chevron is a real button with
 *   an aria-label and the current month is announced via a polite live region.
 * - `compact` (mobile): a floating circular calendar button (iOS feel) that
 *   opens a Menu listing a rolling window of recent months. The trigger carries
 *   an aria-label naming the current month plus `aria-haspopup`/`aria-expanded`;
 *   each item is keyboard-selectable and the current month is flagged with a
 *   check icon (not color alone) plus `aria-checked`.
 *
 * Home reads the shared selection (via MonthContext) and filters its real
 * transactions by the selected year+month; the mock panels stay non-reactive
 * (ADR-035).
 *
 * The navigator is BOUNDED (ADR-041): `›` is disabled at the current month (no
 * future), and going older than the 6-months-ago floor redirects to
 * Transactions via {@link MonthSwitcherProps.onNavigateOlder} instead of
 * stepping further.
 */
export function MonthSwitcher({
  variant = 'stepper',
  value,
  onChange,
  onNavigateOlder,
}: MonthSwitcherProps) {
  const [internal, setInternal] = useState<ViewingMonth>(() =>
    currentViewingMonth(),
  )
  const current = value ?? internal

  const select = (next: ViewingMonth) => {
    if (isSameViewingMonth(next, current)) return
    if (value === undefined) setInternal(next)
    onChange?.(next)
  }

  if (variant === 'compact') {
    return (
      <CompactPicker
        current={current}
        onSelect={select}
        onNavigateOlder={onNavigateOlder}
      />
    )
  }

  return (
    <Stepper
      current={current}
      onSelect={select}
      onNavigateOlder={onNavigateOlder}
    />
  )
}

/**
 * Desktop inline prev / label / next stepper (ADR-017, ADR-041).
 *
 * `›` is DISABLED at the current month (no future). `‹` steps back normally
 * while above the 6-months-ago floor; AT the floor it does NOT step — it invokes
 * `onNavigateOlder` so the shell can redirect to Transactions (older dates are
 * searchable there).
 */
function Stepper({
  current,
  onSelect,
  onNavigateOlder,
}: {
  current: ViewingMonth
  onSelect: (month: ViewingMonth) => void
  onNavigateOlder?: () => void
}) {
  const { t } = useTranslation('shell')
  const label = formatViewingMonth(current)
  const atUpper = isAtUpperBound(current)
  const atLower = isAtLowerBound(current)

  const handlePrev = () => {
    if (atLower) {
      onNavigateOlder?.()
      return
    }
    onSelect(addMonths(current, -1))
  }

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
      <IconButton
        size="small"
        aria-label={
          atLower ? t('month.olderRedirect') : t('month.previous')
        }
        onClick={handlePrev}
        sx={{ border: 1, borderColor: 'divider', borderRadius: 1.75 }}
      >
        <ChevronLeftIcon fontSize="small" />
      </IconButton>

      <Typography
        component="span"
        role="status"
        aria-live="polite"
        aria-label={t('month.selected', { label })}
        sx={{
          fontFamily: monoFontFamily,
          color: 'text.primary',
          minWidth: 110,
          textAlign: 'center',
          fontSize: '0.875rem',
        }}
      >
        {label}
      </Typography>

      <IconButton
        size="small"
        aria-label={t('month.next')}
        onClick={() => onSelect(addMonths(current, 1))}
        disabled={atUpper}
        sx={{ border: 1, borderColor: 'divider', borderRadius: 1.75 }}
      >
        <ChevronRightIcon fontSize="small" />
      </IconButton>
    </Box>
  )
}

/**
 * Mobile floating circular calendar button + month-picker Menu (iOS feel).
 *
 * The 40px circle reads as floating against the transparent bar: a translucent
 * paper surface with a subtle blur and a divider border. The Menu lists ONLY the
 * bounded window (the current month down to the 6-months-ago floor, newest
 * first) — no future, no older entries (ADR-041) — with the selected one marked
 * by a trailing check (ADR-019). A trailing "Older months → Transactions" item
 * triggers the same redirect as the floor when `onNavigateOlder` is provided.
 */
function CompactPicker({
  current,
  onSelect,
  onNavigateOlder,
}: {
  current: ViewingMonth
  onSelect: (month: ViewingMonth) => void
  onNavigateOlder?: () => void
}) {
  const { t } = useTranslation('shell')
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const open = Boolean(anchorEl)
  const menuId = useId()
  const currentLabel = formatViewingMonth(current)

  // Only the bounded window: current month down to the 6-months-ago floor.
  const months = boundedMonthsWindow()

  const handleOpen = (event: MouseEvent<HTMLElement>) =>
    setAnchorEl(event.currentTarget)
  const handleClose = () => setAnchorEl(null)
  const handleSelect = (month: ViewingMonth) => {
    onSelect(month)
    handleClose()
  }
  const handleOlder = () => {
    handleClose()
    onNavigateOlder?.()
  }

  return (
    <>
      <Tooltip title={t('month.select')}>
        <IconButton
          onClick={handleOpen}
          aria-label={t('month.selectWithLabel', { label: currentLabel })}
          aria-haspopup="menu"
          aria-controls={open ? menuId : undefined}
          aria-expanded={open ? 'true' : undefined}
          sx={{
            width: 40,
            height: 40,
            color: 'text.primary',
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
          <CalendarMonthOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>

      <Menu
        id={menuId}
        anchorEl={anchorEl}
        open={open}
        onClose={handleClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{
          paper: {
            elevation: 0,
            sx: {
              mt: 1,
              minWidth: 184,
              maxHeight: 360,
              borderRadius: 2,
              border: 1,
              borderColor: 'divider',
              bgcolor: 'background.paper',
              boxShadow: '0 12px 32px -12px rgba(0,0,0,0.45)',
            },
          },
          list: { sx: { py: 0.5 }, 'aria-label': t('month.menuLabel') },
        }}
      >
        {months.map((month) => {
          const label = formatViewingMonth(month)
          const selected = isSameViewingMonth(month, current)
          return (
            <MenuItem
              key={label}
              selected={selected}
              aria-checked={selected}
              onClick={() => handleSelect(month)}
              sx={{ py: 1.25 }}
            >
              <ListItemText
                primary={label}
                slotProps={{
                  primary: {
                    sx: {
                      fontFamily: monoFontFamily,
                      fontWeight: selected ? 600 : 400,
                    },
                  },
                }}
              />
              {/* Current month flagged by a check, not color alone (ADR-019). */}
              <ListItemIcon
                sx={{ minWidth: 0, ml: 1.5, color: 'primary.main' }}
              >
                {selected ? <CheckRoundedIcon fontSize="small" /> : null}
              </ListItemIcon>
            </MenuItem>
          )
        })}

        {/* Older months than the 6-month floor live in Transactions (ADR-041). */}
        {onNavigateOlder ? (
          <Box>
            <Divider sx={{ my: 0.5 }} />
            <MenuItem onClick={handleOlder} sx={{ py: 1.25 }}>
              <ListItemIcon sx={{ minWidth: 0, mr: 1.5, color: 'text.secondary' }}>
                <HistoryRoundedIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText
                primary={t('month.olderTitle')}
                secondary={t('month.olderSubtitle')}
                slotProps={{
                  primary: { sx: { fontSize: 14 } },
                  secondary: { sx: { fontSize: 11.5 } },
                }}
              />
            </MenuItem>
          </Box>
        ) : null}
      </Menu>
    </>
  )
}

export default MonthSwitcher
