/**
 * FX badge — the gold "FX" pill shown on foreign-currency (USD) rows, with a
 * concise tooltip explaining what it means (Issue #26 follow-up).
 *
 * "FX" alone is opaque, so the badge carries an explanatory <Tooltip> plus an
 * `aria-label` ("Foreign exchange") for screen readers, and is focusable
 * (`tabIndex={0}`) so the tooltip is reachable by keyboard — MUI's Tooltip
 * opens on focus when its child can receive focus (ADR-019: never rely on hover
 * or color alone). The visible label stays the terse "FX" to keep rows calm.
 *
 * Styling mirrors the local "gold" RowBadge tone (gold border + tint + mono
 * font) so it stays visually identical to the badge it replaces.
 */

import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Tooltip from '@mui/material/Tooltip'
import { monoFontFamily } from '../theme'

/**
 * English fallbacks for the concise tooltip + accessible-name copy. The live
 * component resolves these through the `common` namespace (`fx.*`); these
 * constants remain as the English source-of-truth values.
 */
export const FX_BADGE_LABEL = 'Foreign exchange'
export const FX_BADGE_TOOLTIP =
  'Foreign exchange — the original USD amount, converted to ARS at the shown rate.'

/**
 * The gold "FX" badge with its explanatory tooltip. Drop-in replacement for the
 * former `<RowBadge tone="gold">FX</RowBadge>` usages.
 */
export function FxBadge() {
  const { t } = useTranslation('common')
  return (
    <Tooltip title={t('fx.tooltip')}>
      <Box
        component="span"
        tabIndex={0}
        aria-label={t('fx.label')}
        sx={{
          flex: 'none',
          fontSize: 10,
          lineHeight: 1.6,
          px: 0.75,
          borderRadius: '5px',
          border: '1px solid',
          borderColor: 'primary.main',
          color: 'primary.main',
          bgcolor: 'color-mix(in srgb, var(--mg-gold) 12%, transparent)',
          fontFamily: monoFontFamily,
          whiteSpace: 'nowrap',
          cursor: 'default',
          '&:focus-visible': {
            outline: '2px solid',
            outlineColor: 'primary.main',
            outlineOffset: 2,
          },
        }}
      >
        {t('fx.badge')}
      </Box>
    </Tooltip>
  )
}

export default FxBadge
