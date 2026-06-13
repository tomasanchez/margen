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
import { MONTHS, type MonthLabel } from './months'

/**
 * Presentation of the month control:
 * - `stepper` — desktop inline `‹ June 2026 ›` prev/label/next (the original).
 * - `compact` — mobile floating circular calendar button that opens a month
 *   picker (Menu) listing the available months, the current one marked with a
 *   check (non-color cue, ADR-019).
 */
export type MonthSwitcherVariant = 'stepper' | 'compact'

export interface MonthSwitcherProps {
  /** Which presentation to render. Defaults to the desktop `stepper`. */
  variant?: MonthSwitcherVariant
  /** Selected month label. Uncontrolled (local state) when omitted. */
  value?: string
  /** Called with the new month label when the user changes the selection. */
  onChange?: (month: string) => void
}

/** Resolve the controlled value to a clamped index into MONTHS. */
function indexOfMonth(current: string): number {
  return Math.max(0, MONTHS.indexOf(current as MonthLabel))
}

/**
 * Top-bar month control (ADR-017, ADR-019).
 *
 * Two presentations sharing one controlled/uncontrolled state model:
 *
 * - `stepper` (desktop): ‹ June 2026 › where each chevron is a real button with
 *   an aria-label and the current month is announced via a polite live region.
 *   Stepping is clamped to the months that exist in the mock data.
 * - `compact` (mobile): a floating circular calendar button (iOS feel) that
 *   opens a Menu month picker. The trigger carries an aria-label naming the
 *   current month plus `aria-haspopup`/`aria-expanded`; each item is
 *   keyboard-selectable and the current month is flagged with a check icon
 *   (not color alone) plus `aria-checked`.
 *
 * Selection is cosmetic for now — screens consume it later; this control only
 * owns the presentation and the shared state seam.
 */
export function MonthSwitcher({
  variant = 'stepper',
  value,
  onChange,
}: MonthSwitcherProps) {
  const [internal, setInternal] = useState<string>(MONTHS[0])
  const current = value ?? internal

  const select = (next: string) => {
    if (next === current) return
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
  current: string
  onSelect: (month: string) => void
}) {
  const index = indexOfMonth(current)
  const atNewest = index <= 0
  const atOldest = index >= MONTHS.length - 1

  const step = (delta: number) => {
    const nextIndex = Math.min(MONTHS.length - 1, Math.max(0, index + delta))
    onSelect(MONTHS[nextIndex])
  }

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
      <IconButton
        size="small"
        aria-label="Previous month"
        disabled={atOldest}
        onClick={() => step(1)}
        sx={{ border: 1, borderColor: 'divider', borderRadius: 1.75 }}
      >
        <ChevronLeftIcon fontSize="small" />
      </IconButton>

      <Typography
        component="span"
        role="status"
        aria-live="polite"
        aria-label={`Selected month: ${current}`}
        sx={{
          fontFamily: monoFontFamily,
          color: 'text.primary',
          minWidth: 96,
          textAlign: 'center',
          fontSize: '0.875rem',
        }}
      >
        {current}
      </Typography>

      <IconButton
        size="small"
        aria-label="Next month"
        disabled={atNewest}
        onClick={() => step(-1)}
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
 * paper surface with a subtle blur and a divider border. The Menu lists the
 * available months with the current one marked by a trailing check (ADR-019).
 */
function CompactPicker({
  current,
  onSelect,
}: {
  current: string
  onSelect: (month: string) => void
}) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const open = Boolean(anchorEl)
  const menuId = useId()

  const handleOpen = (event: MouseEvent<HTMLElement>) =>
    setAnchorEl(event.currentTarget)
  const handleClose = () => setAnchorEl(null)
  const handleSelect = (month: string) => {
    onSelect(month)
    handleClose()
  }

  return (
    <>
      <Tooltip title="Select month">
        <IconButton
          onClick={handleOpen}
          aria-label={`Select month, ${current}`}
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
        {MONTHS.map((month) => {
          const selected = month === current
          return (
            <MenuItem
              key={month}
              selected={selected}
              aria-checked={selected}
              onClick={() => handleSelect(month)}
              sx={{ py: 1.25 }}
            >
              <ListItemText
                primary={month}
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
