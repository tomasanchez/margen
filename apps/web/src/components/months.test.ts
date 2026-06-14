/**
 * Unit tests for the viewing-month value model (ADR-040).
 *
 * Covers month stepping across year boundaries, label formatting, equality, and
 * the recent-months window the compact picker lists.
 */

import { describe, expect, test } from 'vitest'
import {
  addMonths,
  currentViewingMonth,
  formatViewingMonth,
  isSameViewingMonth,
  monthName,
  recentMonthsWindow,
} from './months'

describe('addMonths', () => {
  test('steps forward and back within a year', () => {
    expect(addMonths({ year: 2026, month: 5 }, 1)).toEqual({
      year: 2026,
      month: 6,
    })
    expect(addMonths({ year: 2026, month: 5 }, -1)).toEqual({
      year: 2026,
      month: 4,
    })
  })

  test('crosses the year boundary in both directions', () => {
    // December 2025 (month 11) → next is January 2026.
    expect(addMonths({ year: 2025, month: 11 }, 1)).toEqual({
      year: 2026,
      month: 0,
    })
    // January 2026 (month 0) → previous is December 2025.
    expect(addMonths({ year: 2026, month: 0 }, -1)).toEqual({
      year: 2025,
      month: 11,
    })
  })

  test('steps by multiple months and full years', () => {
    expect(addMonths({ year: 2026, month: 0 }, 13)).toEqual({
      year: 2027,
      month: 1,
    })
    expect(addMonths({ year: 2026, month: 2 }, -14)).toEqual({
      year: 2025,
      month: 0,
    })
  })
})

describe('formatViewingMonth / monthName', () => {
  test('formats the full month name + year', () => {
    expect(formatViewingMonth({ year: 2026, month: 5 })).toBe('June 2026')
    expect(formatViewingMonth({ year: 2025, month: 11 })).toBe('December 2025')
  })

  test('monthName returns the bare month', () => {
    expect(monthName({ year: 2026, month: 4 })).toBe('May')
  })
})

describe('isSameViewingMonth', () => {
  test('matches only when both year and month agree', () => {
    expect(
      isSameViewingMonth({ year: 2026, month: 5 }, { year: 2026, month: 5 }),
    ).toBe(true)
    expect(
      isSameViewingMonth({ year: 2026, month: 5 }, { year: 2025, month: 5 }),
    ).toBe(false)
    expect(
      isSameViewingMonth({ year: 2026, month: 5 }, { year: 2026, month: 4 }),
    ).toBe(false)
  })
})

describe('currentViewingMonth', () => {
  test('reads the year and 0-based month from the given date', () => {
    expect(currentViewingMonth(new Date('2026-06-13T10:00:00Z'))).toEqual({
      year: 2026,
      month: 5,
    })
  })
})

describe('recentMonthsWindow', () => {
  test('returns count months ending at the anchor, newest first', () => {
    const window = recentMonthsWindow({ year: 2026, month: 1 }, 3)
    expect(window).toEqual([
      { year: 2026, month: 1 },
      { year: 2026, month: 0 },
      { year: 2025, month: 11 },
    ])
  })

  test('defaults to a rolling year (12 months)', () => {
    expect(recentMonthsWindow({ year: 2026, month: 5 })).toHaveLength(12)
  })
})
