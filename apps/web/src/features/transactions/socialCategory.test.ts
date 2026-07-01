/**
 * Guards the new "Social" category wiring.
 *
 * `Social` is a discretionary "Wants" category (group meals/outings). The
 * backend adds it as non-essential (`isEssential=false`) so budgets group it
 * under Wants automatically — no frontend grouping code. For Social rows to
 * render, be pickable, and be filterable (incl. as a URL filter), "Social" must
 * be an expense-pickable category, a member of the full category set (which
 * seeds `KNOWN_CATEGORIES` for URL-sync validation), and have a localized
 * label. Its dot uses the neutral hue (only `Income` is tinted). English-pinned
 * (ADR-105).
 */

import { describe, expect, test } from 'vitest'
import { CATEGORIES } from '../../mock/seed'
import { EXPENSE_CATEGORIES } from './useAddEditFormState'
import { categoryDotColor, categoryLabel } from './presentation'

describe('"Social" category', () => {
  test('is part of the full category set (filters + URL-sync validation)', () => {
    expect(CATEGORIES).toContain('Social')
  })

  test('is an expense-pickable category', () => {
    expect(EXPENSE_CATEGORIES).toContain('Social')
  })

  test('resolves a localized label (en)', () => {
    expect(categoryLabel('Social')).toBe('Social')
  })

  test('uses the neutral (non-Income) dot hue', () => {
    expect(categoryDotColor('Social')).toBe('var(--mg-text-2)')
    expect(categoryDotColor('Social')).not.toBe(categoryDotColor('Income'))
  })
})
