/**
 * Guards the new "Fees" category wiring (ADR-135, extends ADR-083).
 *
 * Transfer fees are recorded as `kind=expense`, category `"Fees"` transactions
 * (created server-side). For those rows to render + be filterable, "Fees" must be
 * a member of the frontend category set used by the transaction form/filters, an
 * expense-pickable category, and have a localized label. English-pinned (ADR-105).
 */

import { describe, expect, test } from 'vitest'
import { CATEGORIES } from '../../mock/seed'
import { EXPENSE_CATEGORIES } from './useAddEditFormState'
import { categoryLabel } from './presentation'

describe('"Fees" category (ADR-135)', () => {
  test('is part of the full category set (filters + form)', () => {
    expect(CATEGORIES).toContain('Fees')
  })

  test('is an expense-pickable category', () => {
    expect(EXPENSE_CATEGORIES).toContain('Fees')
  })

  test('resolves a localized label (en)', () => {
    expect(categoryLabel('Fees')).toBe('Fees')
  })
})
