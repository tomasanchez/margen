/**
 * Guards the "Mili" category wiring (ADR-213).
 *
 * `Mili` tracks spending on the owner's partner. Like `Social` it is a
 * discretionary "Wants" category: it must be in the full category set (filters
 * + URL-sync validation), expense-pickable, and localized. English-pinned
 * (ADR-105).
 */

import { describe, expect, test } from 'vitest'
import { CATEGORIES } from '../../mock/seed'
import { EXPENSE_CATEGORIES } from './useAddEditFormState'
import { categoryDotColor, categoryLabel } from './presentation'

describe('"Mili" category', () => {
  test('is part of the full category set (filters + URL-sync validation)', () => {
    expect(CATEGORIES).toContain('Mili')
  })

  test('is an expense-pickable category', () => {
    expect(EXPENSE_CATEGORIES).toContain('Mili')
  })

  test('resolves a localized label (en)', () => {
    expect(categoryLabel('Mili')).toBe('Mili')
  })

  test('uses the neutral (non-Income) dot hue', () => {
    expect(categoryDotColor('Mili')).toBe('var(--mg-text-2)')
  })
})
