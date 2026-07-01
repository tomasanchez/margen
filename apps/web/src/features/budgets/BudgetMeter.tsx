/**
 * <BudgetMeter> — the spent / target progress bar (ADR-019, ADR-013).
 *
 * A calm CSS meter showing how much of a category's target has been spent. The
 * over-budget state is conveyed BEYOND color (ADR-019): the track turns the
 * Watch hue AND the fill is striped (a hatch pattern) AND callers pair it with a
 * text/icon "over budget" cue — never color alone. Within budget, the fill is
 * the gold accent.
 *
 * Exposes the ARIA `meter` role with `aria-valuenow/min/max` (the percentage)
 * and an `aria-label` the caller supplies (e.g. "Food: 80% of target spent"), so
 * assistive tech announces progress without relying on the visual bar.
 *
 * Respects reduced-motion (ADR-019): the width transition is dropped when the
 * user prefers reduced motion.
 */

import Box from '@mui/material/Box'
import { budgetMeterColor } from './derive'

export interface BudgetMeterProps {
  /** Fill ratio in [0, 1] (spent / target, clamped). */
  ratio: number
  /** Whether spend exceeds the target (drives the non-color over cue). */
  overBudget?: boolean
  /** Accessible label naming the category + percentage (caller-localized). */
  label: string
}

/** Spent-vs-target meter with a non-color over-budget treatment (ADR-019). */
export function BudgetMeter({ ratio, overBudget = false, label }: BudgetMeterProps) {
  const pct = Math.round(Math.min(Math.max(ratio, 0), 1) * 100)
  // Graduated fill color by ratio (green/white/gold/red); over budget is red.
  const fill = budgetMeterColor(pct / 100, overBudget)
  return (
    <Box
      role="meter"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      sx={{
        height: 8,
        borderRadius: '5px',
        overflow: 'hidden',
        // Over budget: the track itself takes the Risk tint as a redundant cue
        // alongside the striped fill + the text/icon the row renders (ADR-019).
        bgcolor: overBudget
          ? 'color-mix(in srgb, var(--mg-risk) 18%, transparent)'
          : 'var(--mg-raised)',
      }}
    >
      <Box
        sx={{
          height: '100%',
          // Over budget always fills the track (spend ≥ target).
          width: `${overBudget ? 100 : pct}%`,
          borderRadius: '5px',
          bgcolor: fill,
          // Non-color cue: a diagonal hatch on the over-budget fill so the state
          // reads without relying on hue (ADR-019).
          ...(overBudget
            ? {
                backgroundImage:
                  'repeating-linear-gradient(45deg, transparent, transparent 4px, color-mix(in srgb, #000 22%, transparent) 4px, color-mix(in srgb, #000 22%, transparent) 8px)',
              }
            : {}),
          transition: 'width 240ms ease',
          '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
        }}
      />
    </Box>
  )
}

export default BudgetMeter
