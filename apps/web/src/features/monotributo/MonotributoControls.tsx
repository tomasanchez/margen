/**
 * Monotributo page controls — the category selector + "Compare to previous
 * period" toggle (ADR-049, ADR-052).
 *
 * A compact, accessible A–K category picker (MUI Select) bound to the configured
 * category that PATCHes through the mutation; it disables while saving and
 * surfaces a 422 (unknown category) as a calm inline message. Beside it, a
 * labeled Switch toggles the period-over-period comparison. Both are keyboard
 * operable with visible focus and explicit accessible names (HIG).
 */

import Box from '@mui/material/Box'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Switch from '@mui/material/Switch'
import Typography from '@mui/material/Typography'
import { useId } from 'react'
import type { MonotributoScaleRow } from '../../mock/types'

export interface MonotributoControlsProps {
  /** Letters available to choose from (the A–K scale). */
  scale: MonotributoScaleRow[]
  /** The currently configured category letter. */
  currentCategory: string
  /** Called with the chosen letter when the user changes the category. */
  onCategoryChange: (letter: string) => void
  /** Whether the category PATCH is in flight (disables the control). */
  saving: boolean
  /** Inline calm error message (e.g. an unknown-category 422); null when none. */
  categoryError: string | null
  /** Whether the comparison toggle is on. */
  compare: boolean
  /** Called when the user toggles the comparison. */
  onCompareChange: (next: boolean) => void
}

export function MonotributoControls({
  scale,
  currentCategory,
  onCategoryChange,
  saving,
  categoryError,
  compare,
  onCompareChange,
}: MonotributoControlsProps) {
  const labelId = useId()
  const errorId = useId()

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: { xs: 'column', sm: 'row' },
        alignItems: { xs: 'stretch', sm: 'center' },
        gap: { xs: 1.5, sm: 2.5 },
        flexWrap: 'wrap',
      }}
    >
      <Box>
        <FormControl size="small" sx={{ minWidth: 168 }} disabled={saving}>
          <InputLabel id={labelId}>Category</InputLabel>
          <Select
            labelId={labelId}
            label="Category"
            value={currentCategory}
            onChange={(event) => onCategoryChange(event.target.value)}
            aria-describedby={categoryError ? errorId : undefined}
            sx={{
              borderRadius: '10px',
              bgcolor: 'var(--mg-paper)',
            }}
          >
            {scale.map((row) => (
              <MenuItem key={row.letter} value={row.letter}>
                Category {row.letter}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        {categoryError ? (
          <Typography
            id={errorId}
            role="alert"
            sx={{ fontSize: 12, mt: 0.75, maxWidth: 240, textWrap: 'pretty' }}
            color="error.main"
          >
            {categoryError}
          </Typography>
        ) : null}
      </Box>

      <FormControlLabel
        control={
          <Switch
            checked={compare}
            onChange={(event) => onCompareChange(event.target.checked)}
            slotProps={{ input: { 'aria-label': 'Compare to previous period' } }}
          />
        }
        label={
          <Typography sx={{ fontSize: 13.5 }} color="text.secondary">
            Compare to previous period
          </Typography>
        }
        sx={{ m: 0 }}
      />
    </Box>
  )
}

export default MonotributoControls
