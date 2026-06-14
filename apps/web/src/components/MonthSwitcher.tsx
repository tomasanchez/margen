import { useId, useState, type MouseEvent } from 'react'
import Box from '@mui/material/Box'
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
import { monoFontFamily } from '../theme'
import {
  addMonths,
  currentViewingMonth,
  formatViewingMonth,
  isSameViewingMonth,
  recentMonthsWindow,
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
 */
export function MonthSwitcher({
  variant = 'stepper',
  value,
  onChange,
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
    return <CompactPicker current={current} onSelect={select} />
  }

  return <Stepper current={current} onSelect={select} />
}

/** Desktop inline prev / label / next stepper (the original presentation). */
function Stepper({
  current,
  onSelect,
}: {
  current: ViewingMonth
  onSelect: (month: ViewingMonth) => void
}) {
  const label = formatViewingMonth(current)

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
      <IconButton
        size="small"
        aria-label="Previous month"
        onClick={() => onSelect(addMonths(current, -1))}
        sx={{ border: 1, borderColor: 'divider', borderRadius: 1.75 }}
      >
        <ChevronLeftIcon fontSize="small" />
      </IconButton>

      <Typography
        component="span"
        role="status"
        aria-live="polite"
        aria-label={`Selected month: ${label}`}
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
        aria-label="Next month"
        onClick={() => onSelect(addMonths(current, 1))}
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
 * paper surface with a subtle blur and a divider border. The Menu lists a rolling
 * window of recent months (the current month + the previous eleven) with the
 * current one marked by a trailing check (ADR-019).
 */
function CompactPicker({
  current,
  onSelect,
}: {
  current: ViewingMonth
  onSelect: (month: ViewingMonth) => void
}) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const open = Boolean(anchorEl)
  const menuId = useId()
  const currentLabel = formatViewingMonth(current)

  // A rolling year of recent months ending at the current calendar month; the
  // selected month is included even if it sits outside that window (so the
  // check still shows after stepping far back via the desktop stepper).
  const months = (() => {
    const window = recentMonthsWindow(currentViewingMonth())
    if (window.some((m) => isSameViewingMonth(m, current))) return window
    return [current, ...window]
  })()

  const handleOpen = (event: MouseEvent<HTMLElement>) =>
    setAnchorEl(event.currentTarget)
  const handleClose = () => setAnchorEl(null)
  const handleSelect = (month: ViewingMonth) => {
    onSelect(month)
    handleClose()
  }

  return (
    <>
      <Tooltip title="Select month">
        <IconButton
          onClick={handleOpen}
          aria-label={`Select month, ${currentLabel}`}
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
          list: { sx: { py: 0.5 }, 'aria-label': 'Select month' },
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
      </Menu>
    </>
  )
}

export default MonthSwitcher
