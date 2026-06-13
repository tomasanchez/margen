import { useState } from 'react'
import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import Typography from '@mui/material/Typography'
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import { monoFontFamily } from '../theme'

/**
 * Months present in the mock data (ADR-015/020), newest first. The switcher
 * steps through these for now; a later task wires the selection into the screens
 * so they filter by month. Index 0 is the default ("June 2026").
 */
const MONTHS = ['June 2026', 'May 2026', 'April 2026'] as const

export interface MonthSwitcherProps {
  /** Selected month label. Uncontrolled (local state) when omitted. */
  value?: string
  /** Called with the new month label when the user steps. */
  onChange?: (month: string) => void
}

/**
 * Top-bar month control: ‹ June 2026 › (ADR-017).
 *
 * The label uses IBM Plex Mono per the concept. Each chevron is a real button
 * with an aria-label, and the current month is announced via a polite live
 * region so keyboard/screen-reader users hear the change (ADR-019). Stepping is
 * clamped to the months that exist in the mock data. This task does not yet
 * filter data on the selection — screens consume it later.
 */
export function MonthSwitcher({ value, onChange }: MonthSwitcherProps) {
  const [internal, setInternal] = useState<string>(MONTHS[0])
  const current = value ?? internal
  const index = Math.max(0, MONTHS.indexOf(current as (typeof MONTHS)[number]))

  const atNewest = index <= 0
  const atOldest = index >= MONTHS.length - 1

  const step = (delta: number) => {
    const nextIndex = Math.min(MONTHS.length - 1, Math.max(0, index + delta))
    const next = MONTHS[nextIndex]
    if (next === current) return
    if (value === undefined) setInternal(next)
    onChange?.(next)
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

export default MonthSwitcher
