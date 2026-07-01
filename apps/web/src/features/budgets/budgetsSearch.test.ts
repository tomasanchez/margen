/**
 * Unit tests for the `/budgets` URL month plumbing (ADR-040/125).
 *
 * The month lives in `?month=YYYY-MM`: validate narrows a raw param to a strict
 * calendar month (rejecting range sentinels + garbage), `searchToBudgetMonth`
 * derives the live month (defaulting to the current month when absent), and
 * `monthToBudgetsSearch` round-trips a month back, omitting the current-month
 * default. `now` is injected so the current-month default is deterministic.
 */

import { describe, expect, test } from 'vitest'
import {
  monthToBudgetsSearch,
  searchToBudgetMonth,
  validateBudgetsSearch,
} from './budgetsSearch'

// Pin "today" to June 2026 (month index 5) for the current-month default.
const NOW = new Date(2026, 5, 15, 12)

describe('validateBudgetsSearch', () => {
  test('keeps a strict YYYY-MM token', () => {
    expect(validateBudgetsSearch({ month: '2026-05' })).toEqual({ month: '2026-05' })
  })

  test('drops range sentinels — a budget is always one calendar month', () => {
    expect(validateBudgetsSearch({ month: 'all' })).toEqual({})
    expect(validateBudgetsSearch({ month: 'last12' })).toEqual({})
    expect(validateBudgetsSearch({ month: 'thisYear' })).toEqual({})
  })

  test('drops malformed / missing / non-string months', () => {
    expect(validateBudgetsSearch({ month: '2026-13' })).toEqual({})
    expect(validateBudgetsSearch({ month: 'junk' })).toEqual({})
    expect(validateBudgetsSearch({})).toEqual({})
    expect(validateBudgetsSearch({ month: 5 })).toEqual({})
  })
})

describe('searchToBudgetMonth', () => {
  test('derives the specified month', () => {
    expect(searchToBudgetMonth({ month: '2026-03' }, NOW)).toEqual({
      year: 2026,
      month: 2,
    })
  })

  test('defaults to the current month when absent', () => {
    expect(searchToBudgetMonth({}, NOW)).toEqual({ year: 2026, month: 5 })
  })

  test('defaults to the current month when the token is invalid', () => {
    expect(searchToBudgetMonth({ month: 'junk' }, NOW)).toEqual({
      year: 2026,
      month: 5,
    })
  })
})

describe('monthToBudgetsSearch', () => {
  test('omits the current-month default (absence IS the current month)', () => {
    expect(monthToBudgetsSearch({ year: 2026, month: 5 }, NOW)).toEqual({})
  })

  test('serializes any other month to YYYY-MM', () => {
    expect(monthToBudgetsSearch({ year: 2026, month: 4 }, NOW)).toEqual({
      month: '2026-05',
    })
    expect(monthToBudgetsSearch({ year: 2025, month: 11 }, NOW)).toEqual({
      month: '2025-12',
    })
  })
})
