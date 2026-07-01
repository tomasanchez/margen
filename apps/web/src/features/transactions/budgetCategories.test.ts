/**
 * Guards the MVP budget-category delta (ADR-140).
 *
 * `Housing` supersedes `Rent` in the picker but `Rent` stays a tolerated alias
 * in the type union for historical rows. `Education` is added. Both new
 * categories must be expense-pickable, in the full category set, and have a
 * localized label. English-pinned (ADR-105).
 */

import { describe, expect, test } from 'vitest'
import { CATEGORIES } from '../../mock/seed'
import { EXPENSE_CATEGORIES } from './useAddEditFormState'
import { categoryLabel } from './presentation'

describe('budget-category delta (ADR-140)', () => {
  test('Housing + Education are in the full category set', () => {
    expect(CATEGORIES).toContain('Housing')
    expect(CATEGORIES).toContain('Education')
  })

  test('Housing + Education are expense-pickable', () => {
    expect(EXPENSE_CATEGORIES).toContain('Housing')
    expect(EXPENSE_CATEGORIES).toContain('Education')
  })

  test('the picker prefers Housing over the legacy Rent alias', () => {
    expect(EXPENSE_CATEGORIES).toContain('Housing')
    expect(EXPENSE_CATEGORIES).not.toContain('Rent')
    expect(CATEGORIES).not.toContain('Rent')
  })

  test('Rent stays a tolerated label (historical rows still resolve)', () => {
    // The union retains 'Rent'; its label resolves for legacy data.
    expect(categoryLabel('Rent')).toBe('Rent')
  })

  test('Housing + Education resolve localized labels (en)', () => {
    expect(categoryLabel('Housing')).toBe('Housing')
    expect(categoryLabel('Education')).toBe('Education')
  })
})
