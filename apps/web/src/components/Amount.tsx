/**
 * <Amount> — the single way Margen renders a monetary value (ADR-016, ADR-019).
 *
 * Renders the figure in IBM Plex Mono with tabular-nums so columns of numbers
 * align, applies sign-aware color from the design tokens (income/positive ->
 * Safe green; expense/neutral -> the neutral amount token), and carries an
 * accessible label that spells out sign + currency for screen readers rather
 * than relying on the +/− glyph alone. An optional FX subline shows the original
 * USD amount and MEP rate for USD transactions.
 */

import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { monoFontFamily } from '../theme'
import {
  amountAccessibleLabel,
  formatFxSubline,
  formatSignedAmount,
} from '../lib/format'
import type { Currency, FxRateType, TxType } from '../mock/types'

/** Size variants map to the figure font-size used across screens. */
export type AmountSize = 'sm' | 'md' | 'lg' | 'xl'

const SIZE_FONT: Record<AmountSize, string> = {
  sm: '0.8125rem', // 13px — table rows / mobile
  md: '0.875rem', //  14px — recent activity
  lg: '1.4375rem', // 23px — metric / meter figure
  xl: '1.5625rem', // 25px — hero metric cards
}

const SUBLINE_FONT = '0.6875rem' // 11px

export interface AmountProps {
  /** ARS-equivalent magnitude (sign comes from `type`, not from this number). */
  value: number
  /** Display currency prefix; defaults to ARS, the dashboard base currency. */
  currency?: Currency
  /** Direction: drives both the +/− sign and the sign-aware color. */
  type: TxType
  /** Original USD amount, when the underlying transaction was in USD. */
  fxUsd?: number
  /** MEP rate used for the USD→ARS conversion. */
  fxRate?: number
  /** Source of the FX rate (`MEP` vs `manual`); drives the subline label. */
  fxSource?: FxRateType
  /** Figure size variant. */
  size?: AmountSize
  /** Override the income/neutral color decision (e.g. force neutral on totals). */
  emphasizeSign?: boolean
  /** Optional class hook for layout (colors always come from tokens). */
  className?: string
}

/**
 * Money figure with sign, color, optional FX subline, and an accessible label.
 */
export function Amount({
  value,
  currency = 'ARS',
  type,
  fxUsd,
  fxRate,
  fxSource,
  size = 'md',
  emphasizeSign = true,
  className,
}: AmountProps) {
  const text = formatSignedAmount(value, type, currency)
  const srLabel = amountAccessibleLabel(value, type, currency)
  const subline = formatFxSubline(fxUsd, fxRate, fxSource)

  // Income reads in the Safe token; expenses use the neutral amount token so
  // the screen is not awash in red (concept intent + ADR-019: never rely on
  // color alone — the accessible label and +/− sign carry the meaning).
  const color =
    emphasizeSign && type === 'income'
      ? 'var(--mg-safe)'
      : 'var(--mg-amount)'

  return (
    <Box
      className={className}
      sx={{ display: 'inline-flex', flexDirection: 'column', minWidth: 0 }}
    >
      <Box
        component="span"
        aria-label={srLabel}
        sx={{
          fontFamily: monoFontFamily,
          fontVariantNumeric: 'tabular-nums',
          fontWeight: 500,
          fontSize: SIZE_FONT[size],
          lineHeight: 1.2,
          letterSpacing: '-0.01em',
          color,
          whiteSpace: 'nowrap',
        }}
      >
        {/* aria-hidden glyph string; the accessible name is on the wrapper. */}
        <span aria-hidden>{text}</span>
      </Box>
      {subline ? (
        <Typography
          component="span"
          aria-hidden
          sx={{
            fontFamily: monoFontFamily,
            fontSize: SUBLINE_FONT,
            lineHeight: 1.3,
            mt: 0.25,
            color: 'var(--mg-text-3)',
            whiteSpace: 'nowrap',
          }}
        >
          {subline}
        </Typography>
      ) : null}
    </Box>
  )
}

export default Amount
