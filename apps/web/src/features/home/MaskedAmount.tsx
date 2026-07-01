/**
 * A headline amount that respects the Home "hide amounts" privacy toggle
 * (ADR-157).
 *
 * When `hidden`, it renders the shared {@link maskAmount} bullets in place of
 * the real figure — preserving the row's layout and typography — and carries an
 * accessible label (`common:privacy.hidden`) so screen readers announce the
 * value as hidden rather than reading a run of bullets. When visible it renders
 * the pre-formatted `figure` string verbatim. Masking is display-only: the value
 * is still fetched, so toggling off is instant (no refetch).
 *
 * A thin wrapper so every masked headline (metric-card values, the net-worth
 * total + its breakdown) behaves identically and stays testable.
 */

import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'
import Box from '@mui/material/Box'

export interface MaskedAmountProps {
  /** Whether the amount is currently masked. */
  hidden: boolean
  /** The pre-formatted amount string shown when visible. */
  figure: string
  /** The mask string shown when hidden (from `maskAmount()`). */
  mask: string
  /** Wrap the rendered text in a custom element (e.g. a styled Typography). */
  children?: (content: ReactNode) => ReactNode
}

/**
 * Render `figure` when visible, or the `mask` with an accessible "hidden" label
 * when `hidden`. Callers pass a `children` render-prop to keep their own
 * Typography styling; without it a bare inline span is used.
 */
export function MaskedAmount({
  hidden,
  figure,
  mask,
  children,
}: MaskedAmountProps) {
  const { t } = useTranslation('common')

  const content = hidden ? (
    <Box component="span" aria-label={t('privacy.hidden')}>
      <Box component="span" aria-hidden>
        {mask}
      </Box>
    </Box>
  ) : (
    figure
  )

  return <>{children ? children(content) : content}</>
}

export default MaskedAmount
