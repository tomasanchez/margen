/**
 * Range picker for the Reports header (ADR-167) — a segmented control over the
 * four analytics windows (3M / 6M / 12M / YTD) plus a calm "vs previous period"
 * marker mirroring the concept. Built on MUI ToggleButtonGroup with the same
 * pill/gold-active language the Transactions filter bar uses, so the two feel
 * like one system. The selected range lives in the URL (`?range=`, ADR-167); this
 * control is presentational — it reads `value` and calls `onChange`.
 */

import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import CompareArrowsRoundedIcon from '@mui/icons-material/CompareArrowsRounded'
import { monoFontFamily } from '../../theme'
import type { ReportsRange } from '../../api/reportsClient'
import { REPORTS_RANGES } from './reportsSearch'

/** Segmented pill styling (gold active), matching the Transactions filter bar. */
const groupSx = {
  bgcolor: 'var(--mg-paper)',
  border: '1px solid',
  borderColor: 'var(--mg-border-2)',
  borderRadius: '11px',
  p: '4px',
  gap: '4px',
  '& .MuiToggleButton-root': {
    border: 'none',
    borderRadius: '8px !important',
    px: 1.625,
    py: 0.75,
    fontSize: 13,
    fontFamily: monoFontFamily,
    fontWeight: 500,
    color: 'text.secondary',
    textTransform: 'none',
    lineHeight: 1.4,
    '&:hover': { bgcolor: 'action.hover' },
    '&.Mui-selected': {
      bgcolor: 'color-mix(in srgb, var(--mg-gold) 16%, transparent)',
      color: 'text.primary',
      fontWeight: 600,
      '&:hover': {
        bgcolor: 'color-mix(in srgb, var(--mg-gold) 22%, transparent)',
      },
    },
  },
} as const

export interface RangePickerProps {
  /** The active analytics window. */
  value: ReportsRange
  /** Select a different window (the route writes it to the URL). */
  onChange: (next: ReportsRange) => void
}

export function RangePicker({ value, onChange }: RangePickerProps) {
  const { t } = useTranslation('reports')

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, flexWrap: 'wrap' }}>
      <ToggleButtonGroup
        exclusive
        value={value}
        onChange={(_event, next: ReportsRange | null) => {
          // ToggleButtonGroup emits null when the active button is re-clicked;
          // ignore it so a range is always selected (no empty state).
          if (next != null) onChange(next)
        }}
        aria-label={t('range.ariaLabel')}
        sx={groupSx}
      >
        {REPORTS_RANGES.map((range) => (
          <ToggleButton key={range} value={range} aria-label={t(`range.${range}`)}>
            {t(`range.${range}`)}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>

      {/* A calm, non-interactive marker echoing the concept's "vs previous
          period" element — the actual comparison drives every KPI delta. */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.875,
          px: 1.625,
          py: 1,
          border: '1px solid var(--mg-border-2)',
          borderRadius: '11px',
          color: 'text.secondary',
        }}
      >
        <CompareArrowsRoundedIcon sx={{ fontSize: 16 }} aria-hidden />
        <Typography component="span" sx={{ fontSize: 13 }} color="text.secondary">
          {t('range.vsPrevious')}
        </Typography>
      </Box>
    </Box>
  )
}

export default RangePicker
