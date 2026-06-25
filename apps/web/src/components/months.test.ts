/**
 * Unit tests for the viewing-month value model (ADR-040).
 *
 * Covers month stepping across year boundaries, label formatting, equality, and
 * the recent-months window the compact picker lists.
 */

import { afterEach, describe, expect, test } from 'vitest'
import i18n from 'i18next'
import {
  addMonths,
  boundedMonthsWindow,
  clampViewingMonth,
  currentViewingMonth,
  formatViewingMonth,
  isAtLowerBound,
  isAtUpperBound,
  isSameViewingMonth,
  lowerBoundMonth,
  monthName,
  recentMonthsWindow,
  upperBoundMonth,
} from './months'

/** A fixed client clock: 13 June 2026. */
const NOW = new Date('2026-06-13T10:00:00')

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

  // The global setup pins i18next to English (ADR-105); this case mutates the
  // shared instance, so the afterEach resets it to keep the en-pinned suite
  // green regardless of test order.
  describe('Spanish (ADR-102)', () => {
    afterEach(async () => {
      await i18n.changeLanguage('en')
    })

    test('capitalizes the month and drops the Spanish "de"', async () => {
      await i18n.changeLanguage('es')
      // "julio de 2026" (Intl default) → "Julio 2026": capital J, plain space,
      // no "de".
      expect(formatViewingMonth({ year: 2026, month: 6 })).toBe('Julio 2026')
      expect(monthName({ year: 2026, month: 5 })).toBe('Junio')
    })
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

describe('navigator bounds (ADR-041)', () => {
  test('upperBound is the current month; lowerBound is 6 months back', () => {
    expect(upperBoundMonth(NOW)).toEqual({ year: 2026, month: 5 })
    expect(lowerBoundMonth(NOW)).toEqual({ year: 2025, month: 11 })
  })

  test('isAtUpperBound: true at (or beyond) the current month, false below', () => {
    expect(isAtUpperBound({ year: 2026, month: 5 }, NOW)).toBe(true)
    expect(isAtUpperBound({ year: 2026, month: 6 }, NOW)).toBe(true)
    expect(isAtUpperBound({ year: 2026, month: 4 }, NOW)).toBe(false)
  })

  test('isAtLowerBound: true at (or below) the floor, false above', () => {
    expect(isAtLowerBound({ year: 2025, month: 11 }, NOW)).toBe(true)
    expect(isAtLowerBound({ year: 2025, month: 10 }, NOW)).toBe(true)
    expect(isAtLowerBound({ year: 2026, month: 0 }, NOW)).toBe(false)
  })

  test('clampViewingMonth pins out-of-range values into [lower, upper]', () => {
    // Future → upper bound.
    expect(clampViewingMonth({ year: 2027, month: 0 }, NOW)).toEqual({
      year: 2026,
      month: 5,
    })
    // Older than the floor → lower bound.
    expect(clampViewingMonth({ year: 2024, month: 0 }, NOW)).toEqual({
      year: 2025,
      month: 11,
    })
    // In range → unchanged.
    expect(clampViewingMonth({ year: 2026, month: 2 }, NOW)).toEqual({
      year: 2026,
      month: 2,
    })
  })

  test('boundedMonthsWindow lists the current month down to the floor (7, newest first)', () => {
    expect(boundedMonthsWindow(NOW)).toEqual([
      { year: 2026, month: 5 },
      { year: 2026, month: 4 },
      { year: 2026, month: 3 },
      { year: 2026, month: 2 },
      { year: 2026, month: 1 },
      { year: 2026, month: 0 },
      { year: 2025, month: 11 },
    ])
  })
})
