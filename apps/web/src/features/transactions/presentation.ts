/**
 * Small presentation helpers shared by the Transactions row and filter chips.
 * Colors resolve to design tokens (tokens.css) so they adapt to light/dark.
 */

import type { Category } from '../../mock/types'

/**
 * Color token for a category's dot. The concept tints Income with the Safe
 * green and renders every spending category in a single neutral hue; we keep
 * that, mapping to tokens rather than hex. The dot is a redundant cue beside the
 * category text label, never the only signal (ADR-019).
 */
export function categoryDotColor(category: Category): string {
  return category === 'Income' ? 'var(--mg-safe)' : 'var(--mg-text-2)'
}
