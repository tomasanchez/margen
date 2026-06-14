/**
 * <ManualThresholdNote> — the calm "thresholds are manually maintained" indicator
 * (ADR-049/051/057/059).
 *
 * The A–K AFIP/ARCA scale is a manually-maintained constant (ADR-051); it is not
 * polled or scraped. This read-only note tells the user so plainly, with the
 * scale year so they can judge how current the figures are. Shown on the Settings
 * page and on the Monotributo page so both surfaces agree. State is carried by
 * icon + text, never color alone (ADR-019 / HIG).
 */

import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'

/**
 * The AFIP scale year surfaced by the indicator. The scale is a maintained
 * constant (ADR-051); this matches the year shown on the Monotributo scale table
 * ("Monotributo 2026 — full scale"). Update alongside the scale data.
 */
export const AFIP_SCALE_YEAR = 2026

export interface ManualThresholdNoteProps {
  /** Optional override for the scale year (defaults to {@link AFIP_SCALE_YEAR}). */
  scaleYear?: number
}

export function ManualThresholdNote({
  scaleYear = AFIP_SCALE_YEAR,
}: ManualThresholdNoteProps) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        color: 'text.secondary',
      }}
    >
      <InfoOutlinedIcon aria-hidden fontSize="small" />
      <Typography component="p" sx={{ fontSize: 12.5 }}>
        Thresholds are manually maintained · AFIP scale {scaleYear}
      </Typography>
    </Box>
  )
}

export default ManualThresholdNote
