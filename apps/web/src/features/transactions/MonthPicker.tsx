/**
 * Per-screen month picker for the Transactions ledger (ADR-040, ADR-019).
 *
 * The Transactions page keeps its OWN month filter, independent of the global
 * Home navigator (which stays bounded to a 6-month window and lives in the
 * shell). This control is a calendar-style MONTH picker (not a date-range
 * picker, no new date library): a pill trigger showing the current selection
 * opens a Menu listing every month that has data (newest first) plus an
 * "All time" escape hatch. The active option is flagged with a trailing check
 * — a non-color cue (ADR-019) — and `aria-checked`; the whole thing is
 * keyboard-operable with accessible names.
 *
 * Matching against transactions is year-aware (by `occurredOn`); see
 * `filtering.ts`. The selection model is the shared {@link MonthSelection}
 * (`ViewingMonth | 'all'`).
 */

import { useId, useState, type MouseEvent } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Divider from '@mui/material/Divider'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import CalendarMonthOutlinedIcon from '@mui/icons-material/CalendarMonthOutlined'
import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded'
import { monoFontFamily } from '../../theme'
import {
  ALL_MONTHS,
  formatViewingMonth,
  isSameViewingMonth,
  monthsWithData,
  type MonthSelection,
  type ViewingMonth,
} from '../../components/months'

/** Label shown on the trigger and in the menu for the "All time" option. */
const ALL_TIME_LABEL = 'All time'

export interface MonthPickerProps {
  /** Current selection: a specific month or the `'all'` ("All time") sentinel. */
  value: MonthSelection
  /** Called with the new selection when the user picks an option. */
  onChange: (next: MonthSelection) => void
  /**
   * The unfiltered list's ISO `occurredOn` dates; drives the month options so
   * the user can reach every month that actually has data (ADR-040). Empty
   * falls back to the current month.
   */
  occurredOns: readonly string[]
  /**
   * Full width on mobile (the picker sits in the mobile control row); auto on
   * desktop (inline in the filter bar). Defaults to `false`.
   */
  fullWidth?: boolean
}

/** Whether a selection is a specific month (vs the "All time" sentinel). */
function isMonth(value: MonthSelection): value is ViewingMonth {
  return value !== ALL_MONTHS
}

/**
 * Calendar-style month picker (trigger + Menu) for the Transactions page.
 * Presentational: reads `value`, calls `onChange`.
 */
export function MonthPicker({
  value,
  onChange,
  occurredOns,
  fullWidth = false,
}: MonthPickerProps) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const open = Boolean(anchorEl)
  const menuId = useId()

  const months = monthsWithData(occurredOns)
  const active = isMonth(value)
  const label = active ? formatViewingMonth(value) : ALL_TIME_LABEL

  const handleOpen = (event: MouseEvent<HTMLElement>) =>
    setAnchorEl(event.currentTarget)
  const handleClose = () => setAnchorEl(null)
  const handleSelect = (next: MonthSelection) => {
    onChange(next)
    handleClose()
  }

  return (
    <>
      <Button
        variant="outlined"
        onClick={handleOpen}
        startIcon={<CalendarMonthOutlinedIcon fontSize="small" />}
        endIcon={<ExpandMoreRoundedIcon />}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        aria-expanded={open ? 'true' : undefined}
        aria-label={`Month: ${label}`}
        sx={{
          textTransform: 'none',
          fontSize: 13,
          fontWeight: 500,
          px: 1.75,
          py: 1,
          borderRadius: '9px',
          whiteSpace: 'nowrap',
          justifyContent: 'space-between',
          width: fullWidth ? '100%' : 'auto',
          color: active ? 'text.primary' : 'text.secondary',
          borderColor: 'var(--mg-border-2)',
          bgcolor: active
            ? 'color-mix(in srgb, var(--mg-gold) 10%, transparent)'
            : 'var(--mg-paper)',
          '&:hover': {
            bgcolor: 'action.hover',
            borderColor: 'var(--mg-border-2)',
          },
        }}
      >
        <Box component="span" sx={{ fontFamily: active ? monoFontFamily : 'inherit' }}>
          {label}
        </Box>
      </Button>

      <Menu
        id={menuId}
        anchorEl={anchorEl}
        open={open}
        onClose={handleClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{
          paper: {
            elevation: 0,
            sx: {
              mt: 1,
              minWidth: 196,
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
        {/* "All time" first: the escape hatch that shows every transaction. */}
        <MenuItem
          selected={!active}
          aria-checked={!active}
          onClick={() => handleSelect(ALL_MONTHS)}
          sx={{ py: 1.25 }}
        >
          <ListItemText
            primary={ALL_TIME_LABEL}
            slotProps={{
              primary: { sx: { fontWeight: !active ? 600 : 400 } },
            }}
          />
          <ListItemIcon sx={{ minWidth: 0, ml: 1.5, color: 'primary.main' }}>
            {!active ? <CheckRoundedIcon fontSize="small" /> : null}
          </ListItemIcon>
        </MenuItem>

        <Divider sx={{ my: 0.5 }} />

        {months.map((month) => {
          const monthLabel = formatViewingMonth(month)
          const selected = active && isSameViewingMonth(month, value)
          return (
            <MenuItem
              key={monthLabel}
              selected={selected}
              aria-checked={selected}
              onClick={() => handleSelect(month)}
              sx={{ py: 1.25 }}
            >
              <ListItemText
                primary={monthLabel}
                slotProps={{
                  primary: {
                    sx: {
                      fontFamily: monoFontFamily,
                      fontWeight: selected ? 600 : 400,
                    },
                  },
                }}
              />
              {/* Selected month flagged by a check, not color alone (ADR-019). */}
              <ListItemIcon sx={{ minWidth: 0, ml: 1.5, color: 'primary.main' }}>
                {selected ? <CheckRoundedIcon fontSize="small" /> : null}
              </ListItemIcon>
            </MenuItem>
          )
        })}
      </Menu>
    </>
  )
}

export default MonthPicker
